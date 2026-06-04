import { Injectable, Logger } from '@nestjs/common'
import { Octokit } from '@octokit/rest'

/** Creates a per-customer repo from the matching `archetype-{kind}-template-ui` template
 *  and writes the runtime env file so the deployed site fetches its overlay. */
@Injectable()
export class GitHubProvisioner {
  private readonly logger = new Logger(GitHubProvisioner.name)
  private readonly client: Octokit | null

  constructor() {
    const token = process.env.GITHUB_TOKEN
    this.client = token ? new Octokit({ auth: token }) : null
    if (!token) this.logger.warn('GITHUB_TOKEN not set — GitHub provisioning will be skipped')
  }

  templateFor(kind: 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'): string {
    switch (kind) {
      case 'mesa': return process.env.GITHUB_TEMPLATE_MESA || 'archetype-mesa-template-ui'
      case 'hearth': return process.env.GITHUB_TEMPLATE_HEARTH || 'archetype-hearth-template-ui'
      case 'vault': return process.env.GITHUB_TEMPLATE_VAULT || 'archetype-vault-template-ui'
      case 'marquee': return process.env.GITHUB_TEMPLATE_MARQUEE || 'archetype-marquee-template-ui'
      case 'keystone': return process.env.GITHUB_TEMPLATE_KEYSTONE || 'archetype-keystone-template-ui'
    }
  }

  /** Idempotent: returns existing repo if one with the same name already exists. */
  async createRepo(kind: 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone', name: string): Promise<{ owner: string; repo: string; repoId: number; defaultBranch: string }> {
    const org = process.env.GITHUB_ORG
    if (!this.client || !org) {
      return { owner: org || 'logicium', repo: name, repoId: 0, defaultBranch: 'main' }
    }
    const template = this.templateFor(kind)
    try {
      const existing = await this.client.repos.get({ owner: org, repo: name })
      return { owner: org, repo: name, repoId: existing.data.id, defaultBranch: existing.data.default_branch }
    } catch {
      // not found — create
    }
    const res = await this.client.repos.createUsingTemplate({
      template_owner: org,
      template_repo: template,
      owner: org,
      name,
      private: false,
      include_all_branches: false,
    })
    // createUsingTemplate returns immediately; GitHub copies the template files asynchronously.
    // Wait until package.json exists so downstream Vercel deploys don't clone an empty repo.
    await this.waitForFile(org, name, 'package.json')
    return { owner: org, repo: name, repoId: res.data.id, defaultBranch: res.data.default_branch ?? 'main' }
  }

  /** Polls getContent until the path exists on the default branch, or timeout. */
  async waitForFile(owner: string, repo: string, path: string, timeoutMs = 60_000, intervalMs = 1500): Promise<void> {
    if (!this.client) return
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.client.repos.getContent({ owner, repo, path })
        return
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    this.logger.warn(`waitForFile timed out for ${owner}/${repo}:${path} after ${timeoutMs}ms`)
  }

  /** Writes a single file by path; creates if missing, updates if present. Idempotent. */
  async putFile(owner: string, repo: string, path: string, content: string, message = `chore: ${path}`) {
    if (!this.client) return
    const base64 = Buffer.from(content, 'utf8').toString('base64')
    await this.putFileBase64(owner, repo, path, base64, message)
  }

  /** Returns the numeric GitHub repo ID needed for Vercel gitSource. */
  async getRepoId(ownerRepo: string): Promise<number> {
    if (!this.client) return 0
    const [owner, repo] = ownerRepo.split('/')
    const res = await this.client.repos.get({ owner, repo })
    return res.data.id
  }

  /** Returns both the numeric repo ID and the default branch name for a given `owner/repo`. */
  async getRepoInfo(ownerRepo: string): Promise<{ repoId: number; defaultBranch: string }> {
    if (!this.client) return { repoId: 0, defaultBranch: 'main' }
    const [owner, repo] = ownerRepo.split('/')
    const res = await this.client.repos.get({ owner, repo })
    return { repoId: res.data.id, defaultBranch: res.data.default_branch ?? 'main' }
  }

  /** Returns the SHA of the latest commit on a given branch. */
  async getLatestCommitSha(owner: string, repo: string, branch: string): Promise<string> {
    if (!this.client) return ''
    const res = await this.client.repos.getBranch({ owner, repo, branch })
    return res.data.commit.sha
  }

  /** Lists all file paths in a repo tree (recursive). */
  async listAllFiles(owner: string, repo: string, branch: string): Promise<string[]> {
    if (!this.client) return []
    const branchData = await this.client.repos.getBranch({ owner, repo, branch })
    const treeSha = branchData.data.commit.commit.tree.sha
    const res = await this.client.git.getTree({ owner, repo, tree_sha: treeSha, recursive: 'true' })
    return res.data.tree
      .filter(item => item.type === 'blob' && item.path != null)
      .map(item => item.path as string)
  }

  /** Returns the raw base64-encoded content of a file, or null if not found. */
  async getFileBase64(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    if (!this.client) return null
    try {
      const res = await this.client.repos.getContent({ owner, repo, path, ref })
      if (Array.isArray(res.data) || res.data.type !== 'file') return null
      return (res.data as { content: string }).content.replace(/\n/g, '')
    } catch {
      return null
    }
  }

  /** Creates or updates a file using already-base64-encoded content.
   *  Retries on 422 "sha wasn't supplied" — happens when GitHub's async template-repo
   *  initialization writes the file between our getContent (404) and createOrUpdate calls. */
  async putFileBase64(owner: string, repo: string, path: string, contentBase64: string, message: string) {
    if (!this.client) return
    const fetchSha = async (): Promise<string | undefined> => {
      try {
        const cur = await this.client!.repos.getContent({ owner, repo, path })
        if (!Array.isArray(cur.data) && 'sha' in cur.data) return cur.data.sha
      } catch { /* missing */ }
      return undefined
    }
    let sha = await fetchSha()
    try {
      await this.client.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: contentBase64, sha,
      })
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string }
      const isShaConflict =
        e?.status === 422 &&
        (e.message?.includes('sha') || e.message?.includes('does not match'))
      if (!isShaConflict) throw err
      sha = await fetchSha()
      await this.client.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: contentBase64, sha,
      })
    }
  }
}
