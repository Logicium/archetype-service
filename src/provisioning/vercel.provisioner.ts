import { Injectable, Logger } from '@nestjs/common'

/** Thin wrapper around the Vercel REST API (https://vercel.com/docs/rest-api).
 *  Used for: create project linked to a GitHub repo, set env vars, trigger deploy,
 *  attach custom domain, verify domain. Idempotent where reasonable. */
@Injectable()
export class VercelProvisioner {
  private readonly logger = new Logger(VercelProvisioner.name)
  private readonly token: string | undefined = process.env.VERCEL_TOKEN
  private readonly teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : ''
  private readonly githubOrg = process.env.GITHUB_ORG || 'apotome-labs'

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new Error('VERCEL_TOKEN not set')
    const url = `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}${this.teamQuery.replace(/^\?/, '')}`
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

  async createProject(name: string, repo: string): Promise<{ id: string }> {
    const existing = await this.findProjectByName(name)
    if (existing) return existing
    const res = await this.req<{ id: string }>('POST', '/v10/projects', {
      name,
      framework: 'vite',
      gitRepository: { type: 'github', repo: `${this.githubOrg}/${repo}` },
    })
    return { id: res.id }
  }

  async setEnv(projectId: string, key: string, value: string) {
    if (!this.token) return
    try {
      await this.req('POST', `/v10/projects/${projectId}/env`, {
        key, value, type: 'plain', target: ['production', 'preview', 'development'],
      })
    } catch (e) {
      // 409 means it exists — ignore (treat as idempotent)
      this.logger.warn(`setEnv ${key}: ${(e as Error).message}`)
    }
  }

  async triggerDeployment(projectId: string, repo: string, ref = 'main'): Promise<{ id: string; url: string }> {
    const res = await this.req<{ id: string; url: string }>('POST', '/v13/deployments', {
      name: repo,
      project: projectId,
      gitSource: { type: 'github', repo: `${this.githubOrg}/${repo}`, ref },
      target: 'production',
    })
    return res
  }

  async attachDomain(projectId: string, domain: string) {
    return this.req('POST', `/v10/projects/${projectId}/domains`, { name: domain })
  }

  async getDomainConfig(domain: string): Promise<unknown> {
    return this.req('GET', `/v6/domains/${domain}/config`)
  }
}
