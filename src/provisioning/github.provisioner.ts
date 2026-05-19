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

  templateFor(kind: 'mesa' | 'hearth' | 'vault' | 'keystone'): string {
    switch (kind) {
      case 'mesa': return process.env.GITHUB_TEMPLATE_MESA || 'archetype-mesa-template-ui'
      case 'hearth': return process.env.GITHUB_TEMPLATE_HEARTH || 'archetype-hearth-template-ui'
      case 'vault': return process.env.GITHUB_TEMPLATE_VAULT || 'archetype-vault-template-ui'
      case 'keystone': return process.env.GITHUB_TEMPLATE_KEYSTONE || 'archetype-keystone-template-ui'
    }
  }

  /** Idempotent: returns existing repo if one with the same name already exists. */
  async createRepo(kind: 'mesa' | 'hearth' | 'vault' | 'keystone', name: string): Promise<{ owner: string; repo: string; repoId: number; defaultBranch: string }> {
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
    return { owner: org, repo: name, repoId: res.data.id, defaultBranch: res.data.default_branch ?? 'main' }
  }

  /** Writes a single file by path; creates if missing, updates if present. Idempotent. */
  async putFile(owner: string, repo: string, path: string, content: string, message = `chore: ${path}`) {
    if (!this.client) return
    let sha: string | undefined
    try {
      const cur = await this.client.repos.getContent({ owner, repo, path })
      if (!Array.isArray(cur.data) && 'sha' in cur.data) sha = cur.data.sha
    } catch { /* new file */ }
    await this.client.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha,
    })
  }

  /** Returns the numeric GitHub repo ID needed for Vercel gitSource. */
  async getRepoId(ownerRepo: string): Promise<number> {
    if (!this.client) return 0
    const [owner, repo] = ownerRepo.split('/')
    const res = await this.client.repos.get({ owner, repo })
    return res.data.id
  }

  /** Returns repo id + default branch — Vercel needs the real default branch (master vs main). */
  async getRepoInfo(ownerRepo: string): Promise<{ repoId: number; defaultBranch: string }> {
    if (!this.client) return { repoId: 0, defaultBranch: 'main' }
    const [owner, repo] = ownerRepo.split('/')
    const res = await this.client.repos.get({ owner, repo })
    return { repoId: res.data.id, defaultBranch: res.data.default_branch ?? 'main' }
  }

  /** Returns the latest commit SHA on a branch. */
  async getLatestCommitSha(owner: string, repo: string, branch = 'main'): Promise<string> {
    if (!this.client) return ''
    const res = await this.client.repos.getBranch({ owner, repo, branch })
    return res.data.commit.sha
  }

  /** Lists every file path in the repo at a given ref (recursive tree). */
  async listAllFiles(owner: string, repo: string, ref: string): Promise<string[]> {
    if (!this.client) return []
    const branch = await this.client.repos.getBranch({ owner, repo, branch: ref })
    const treeSha = branch.data.commit.commit.tree.sha
    const tree = await this.client.git.getTree({ owner, repo, tree_sha: treeSha, recursive: 'true' })
    return tree.data.tree.filter(t => t.type === 'blob' && t.path).map(t => t.path as string)
  }

  /** Reads a file's raw base64 content at a ref. */
  async getFileBase64(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    if (!this.client) return null
    try {
      const res = await this.client.repos.getContent({ owner, repo, path, ref })
      if (!Array.isArray(res.data) && 'content' in res.data && res.data.encoding === 'base64') {
        return res.data.content.replace(/\n/g, '')
      }
      return null
    } catch { return null }
  }

  /** Writes a file using a pre-encoded base64 content string (avoids double-encoding). */
  async putFileBase64(owner: string, repo: string, path: string, base64: string, message = `chore: sync ${path}`) {
    if (!this.client) return
    let sha: string | undefined
    try {
      const cur = await this.client.repos.getContent({ owner, repo, path })
      if (!Array.isArray(cur.data) && 'sha' in cur.data) sha = cur.data.sha
    } catch { /* new file */ }
    await this.client.repos.createOrUpdateFileContents({
      owner, repo, path, message, content: base64, sha,
    })
  }
}
