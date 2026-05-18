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
    if (existing) return { id: existing.id, projectName: name }
    const res = await this.req<{ id: string; name: string }>('POST', '/v10/projects', {
      name,
      framework: 'vite',
      gitRepository: { type: 'github', repo: `${this.githubOrg}/${repo}` },
    })
    return { id: res.id, projectName: res.name }
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
    const repo = githubRepo.includes('/') ? githubRepo.split('/')[1] : githubRepo
    return this.triggerDeployment(projectId, repo, repoId, ref)
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
