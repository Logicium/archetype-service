import { Injectable, Logger } from '@nestjs/common'

/** Thin wrapper around the Vercel REST API (https://vercel.com/docs/rest-api).
 *  Used for: create project linked to a GitHub repo, set env vars, trigger deploy,
 *  attach custom domain, verify domain. Idempotent where reasonable. */
@Injectable()
export class VercelProvisioner {
  private readonly logger = new Logger(VercelProvisioner.name)
  private readonly token: string | undefined = process.env.VERCEL_TOKEN
  private readonly githubOrg = process.env.GITHUB_ORG || 'logicium'

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new Error('VERCEL_TOKEN not set')
    const teamId = process.env.VERCEL_TEAM_ID
    const qs = teamId ? `${path.includes('?') ? '&' : '?'}teamId=${teamId}` : ''
    const url = `https://api.vercel.com${path}${qs}`
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Vercel ${method} ${path} failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<T>
  }

  async findProjectByName(name: string): Promise<{ id: string } | null> {
    if (!this.token) return null
    try {
      const res = await this.req<{ id: string; name: string }>('GET', `/v9/projects/${encodeURIComponent(name)}`)
      return { id: res.id }
    } catch { return null }
  }

  async createProject(name: string, repo: string): Promise<{ id: string; projectName: string }> {
    const existing = await this.findProjectByName(name)
    if (existing) {
      // Make sure settings are correct even on a pre-existing project.
      await this.configureBuildSettings(existing.id)
      return { id: existing.id, projectName: name }
    }
    const res = await this.req<{ id: string; name: string }>('POST', '/v10/projects', {
      name,
      framework: 'vite',
      gitRepository: { type: 'github', repo: `${this.githubOrg}/${repo}` },
    })
    await this.configureBuildSettings(res.id)
    return { id: res.id, projectName: res.name }
  }

  /**
   * PATCH the project to force the correct build settings.
   * Without this, Vercel's auto-detected Vite preset runs `vite build` directly,
   * which fails because Vite is a devDependency (`vite: command not found`).
   * Project-level settings take precedence over vercel.json.
   */
  async configureBuildSettings(projectId: string) {
    if (!this.token) return
    // Apply settings in two passes: first clear rootDirectory (must be null, not ""),
    // then set build commands. Doing it in one call sometimes silently drops fields.
    try {
      const before = await this.req<{ rootDirectory?: string | null; installCommand?: string | null; buildCommand?: string | null }>(
        'GET', `/v9/projects/${projectId}`,
      )
      this.logger.log(`project ${projectId} before: root=${before.rootDirectory ?? 'null'} install=${before.installCommand ?? 'null'} build=${before.buildCommand ?? 'null'}`)
    } catch { /* ignore */ }

    // Pass 1: clear rootDirectory (Vercel requires null, not empty string)
    try {
      await this.req('PATCH', `/v9/projects/${projectId}`, { rootDirectory: null })
    } catch (e) {
      this.logger.warn(`clear rootDirectory ${projectId}: ${(e as Error).message}`)
    }

    // Pass 2: set framework + build commands
    try {
      await this.req('PATCH', `/v9/projects/${projectId}`, {
        framework: 'vite',
        installCommand: 'npm install --include=dev',
        buildCommand: 'npm run build',
        outputDirectory: 'dist',
      })
    } catch (e) {
      this.logger.warn(`set build commands ${projectId}: ${(e as Error).message}`)
    }

    try {
      const after = await this.req<{ rootDirectory?: string | null; installCommand?: string | null; buildCommand?: string | null }>(
        'GET', `/v9/projects/${projectId}`,
      )
      this.logger.log(`project ${projectId} after:  root=${after.rootDirectory ?? 'null'} install=${after.installCommand ?? 'null'} build=${after.buildCommand ?? 'null'}`)
    } catch { /* ignore */ }
  }

  async setEnv(projectId: string, key: string, value: string) {
    if (!this.token) return
    // List existing env vars, find a match, and PATCH if it already exists.
    try {
      const list = await this.req<{ envs: Array<{ id: string; key: string }> }>('GET', `/v10/projects/${projectId}/env`)
      const existing = list.envs.find(e => e.key === key)
      if (existing) {
        await this.req('PATCH', `/v10/projects/${projectId}/env/${existing.id}`, {
          value, type: 'plain', target: ['production', 'preview', 'development'],
        })
        return
      }
    } catch { /* fall through to POST */ }
    try {
      await this.req('POST', `/v10/projects/${projectId}/env`, {
        key, value, type: 'plain', target: ['production', 'preview', 'development'],
      })
    } catch (e) {
      this.logger.warn(`setEnv ${key}: ${(e as Error).message}`)
    }
  }

  async redeploy(projectId: string, githubRepo: string, repoId: number, ref = 'main'): Promise<{ id: string; url: string }> {
    // Re-apply build settings every redeploy so older broken projects self-heal.
    await this.configureBuildSettings(projectId)
    const repo = githubRepo.includes('/') ? githubRepo.split('/')[1] : githubRepo
    await this.ensureGitLink(projectId, repo, repoId)
    return this.triggerDeployment(projectId, repo, repoId, ref)
  }

  /** Ensure the Vercel project is linked to the correct GitHub repo. If not, link it. */
  async ensureGitLink(projectId: string, repo: string, repoId: number) {
    if (!this.token) return
    try {
      const proj = await this.req<{ link?: { type?: string; repo?: string; repoId?: number; org?: string } | null }>(
        'GET', `/v9/projects/${projectId}`,
      )
      const link = proj.link
      const expectedRepo = `${this.githubOrg}/${repo}`
      const linkedFullName = link?.org && link?.repo ? `${link.org}/${link.repo}` : link?.repo
      this.logger.log(`project ${projectId} git link: type=${link?.type ?? 'none'} repo=${linkedFullName ?? 'none'} repoId=${link?.repoId ?? 'none'} (expected ${expectedRepo} #${repoId})`)
      if (!link || link.type !== 'github' || link.repoId !== repoId) {
        this.logger.log(`linking project ${projectId} to ${expectedRepo} (#${repoId})`)
        await this.req('POST', `/v9/projects/${projectId}/link`, {
          type: 'github',
          repo: expectedRepo,
          repoId,
        })
      }
    } catch (e) {
      this.logger.warn(`ensureGitLink ${projectId}: ${(e as Error).message}`)
    }
  }

  async triggerDeployment(projectId: string, repo: string, repoId: number, ref = 'main'): Promise<{ id: string; url: string }> {
    const res = await this.req<{ id: string; url: string }>('POST', '/v13/deployments', {
      name: repo,
      project: projectId,
      gitSource: { type: 'github', repo: `${this.githubOrg}/${repo}`, repoId, ref },
      target: 'production',
    })
    return res
  }

  /** Returns the stable production URL for a project (e.g. "https://my-site.vercel.app"). */
  async getProductionUrl(projectId: string): Promise<string | null> {
    if (!this.token) return null
    try {
      // The project name IS the canonical subdomain — Vercel may have auto-renamed it
      // (e.g. "mesa-site-1" → "mesa-ten"), so always read it back from the API.
      const res = await this.req<{ name: string }>('GET', `/v9/projects/${projectId}`)
      return `https://${res.name}.vercel.app`
    } catch { return null }
  }

  async attachDomain(projectId: string, domain: string) {
    return this.req('POST', `/v10/projects/${projectId}/domains`, { name: domain })
  }

  async getDomainConfig(domain: string): Promise<unknown> {
    return this.req('GET', `/v6/domains/${domain}/config`)
  }
}
