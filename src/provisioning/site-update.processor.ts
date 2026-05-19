import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { EntityManager } from '@mikro-orm/postgresql'
import { Job } from 'bullmq'
import { Site } from '../entities/site.entity'
import { GitHubProvisioner } from './github.provisioner'
import { VercelProvisioner } from './vercel.provisioner'
import { SITE_UPDATE_QUEUE } from './provisioning.constants'

/** Paths in the customer repo that must NEVER be overwritten during a template sync.
 *  These hold per-tenant content and credentials. */
const PROTECTED_PREFIXES = [
  'public/tenant.config.json',
  'public/uploads/',
  '.env.production',
  '.env.local',
]

function isProtected(path: string): boolean {
  return PROTECTED_PREFIXES.some(p => path === p || path.startsWith(p))
}

@Processor(SITE_UPDATE_QUEUE)
export class SiteUpdateProcessor extends WorkerHost {
  private readonly logger = new Logger(SiteUpdateProcessor.name)

  constructor(
    private readonly em: EntityManager,
    private readonly github: GitHubProvisioner,
    private readonly vercel: VercelProvisioner,
  ) { super() }

  async process(job: Job<{ siteId: string }>) {
    const em = this.em.fork()
    const site = await em.findOne(Site, { id: job.data.siteId })
    if (!site || !site.githubRepo) throw new Error(`site ${job.data.siteId} has no githubRepo`)

    const [owner, repoName] = site.githubRepo.split('/')
    const templateRepo = this.github.templateFor(site.archetype)
    const templateOwner = process.env.GITHUB_ORG!

    // Determine default branches
    const customer = await this.github.getRepoInfo(site.githubRepo)
    const template = await this.github.getRepoInfo(`${templateOwner}/${templateRepo}`)
    const latestSha = await this.github.getLatestCommitSha(templateOwner, templateRepo, template.defaultBranch)

    this.logger.log(`update site=${site.slug} template=${templateRepo}@${latestSha.slice(0, 7)}`)

    const templateFiles = await this.github.listAllFiles(templateOwner, templateRepo, template.defaultBranch)
    const customerFiles = new Set(await this.github.listAllFiles(owner, repoName, customer.defaultBranch))

    let synced = 0
    let skipped = 0
    for (const path of templateFiles) {
      if (isProtected(path)) { skipped++; continue }
      const content = await this.github.getFileBase64(templateOwner, templateRepo, path, template.defaultBranch)
      if (content == null) { skipped++; continue }
      // If file exists in customer repo, only update if content actually differs.
      if (customerFiles.has(path)) {
        const current = await this.github.getFileBase64(owner, repoName, path, customer.defaultBranch)
        if (current === content) continue
      }
      await this.github.putFileBase64(owner, repoName, path, content, `chore: sync from template ${latestSha.slice(0, 7)}`)
      synced++
    }

    site.templateCommitSha = latestSha
    await em.persistAndFlush(site)

    // Trigger redeploy
    if (site.vercelProjectId) {
      const info = await this.github.getRepoInfo(site.githubRepo)
      await this.vercel.redeploy(site.vercelProjectId, site.githubRepo, info.repoId, info.defaultBranch)
    }

    this.logger.log(`update site=${site.slug} done synced=${synced} skipped=${skipped}`)
    return { synced, skipped, templateCommitSha: latestSha }
  }
}
