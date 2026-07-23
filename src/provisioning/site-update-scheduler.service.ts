import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectQueue } from '@nestjs/bullmq'
import { EntityManager } from '@mikro-orm/postgresql'
import { Queue } from 'bullmq'
import { Site } from '../entities/site.entity'
import { GitHubProvisioner } from './github.provisioner'
import { SITE_UPDATE_QUEUE, SITE_UPDATE_JOB } from './provisioning.constants'

/**
 * Keeps every opted-in site current with its template automatically.
 *
 * Sites default to `autoUpdate = true`, so owners never have to remember to
 * click "update". Once a day the scheduler checks each archetype's template
 * repo for a newer commit and, for any enrolled live site running an older
 * template, queues the same sync-and-redeploy job the manual button uses.
 *
 * The heavy lifting (file sync + Vercel redeploy) stays in SiteUpdateProcessor;
 * this service only decides *which* sites need it, cheaply — one template
 * lookup per archetype, not per site.
 */
@Injectable()
export class SiteUpdateSchedulerService {
  private readonly logger = new Logger(SiteUpdateSchedulerService.name)

  constructor(
    @InjectQueue(SITE_UPDATE_QUEUE) private readonly updateQueue: Queue,
    private readonly em: EntityManager,
    private readonly github: GitHubProvisioner,
  ) {}

  /** Nightly sweep. Guarded by FEATURE_AUTO_UPDATE so it can be disabled per env. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<{ checked: number; queued: number }> {
    if (process.env.FEATURE_AUTO_UPDATE === 'false') return { checked: 0, queued: 0 }
    const templateOwner = process.env.GITHUB_ORG
    if (!templateOwner) {
      this.logger.warn('auto-update skipped: GITHUB_ORG not set')
      return { checked: 0, queued: 0 }
    }

    const em = this.em.fork()
    const sites = await em.find(Site, {
      status: 'live',
      autoUpdate: true,
      githubRepo: { $ne: null },
      vercelProjectId: { $ne: null },
      templateCommitSha: { $ne: null },
    })

    // One latest-commit lookup per archetype, memoized across the sweep.
    const latestByArchetype = new Map<string, string | null>()
    const latestFor = async (archetype: string): Promise<string | null> => {
      if (latestByArchetype.has(archetype)) return latestByArchetype.get(archetype)!
      let sha: string | null = null
      try {
        const templateRepo = this.github.templateFor(archetype as Site['archetype'])
        const info = await this.github.getRepoInfo(`${templateOwner}/${templateRepo}`)
        sha = await this.github.getLatestCommitSha(templateOwner, templateRepo, info.defaultBranch)
      } catch (e) {
        this.logger.warn(`auto-update: could not resolve template for ${archetype}: ${(e as Error).message}`)
      }
      latestByArchetype.set(archetype, sha)
      return sha
    }

    let queued = 0
    for (const site of sites) {
      try {
        const latest = await latestFor(site.archetype)
        if (!latest || site.templateCommitSha === latest) continue
        // Dedupe on (site, target sha) so repeated sweeps before the job runs
        // don't pile up duplicate work.
        await this.updateQueue.add(
          SITE_UPDATE_JOB,
          { siteId: site.id },
          { jobId: `auto-${site.id}-${latest.slice(0, 7)}`, removeOnComplete: 50, removeOnFail: 50 },
        )
        site.lastAutoUpdateAt = new Date()
        em.persist(site)
        queued++
        this.logger.log(`auto-update queued site=${site.slug} ${String(site.templateCommitSha).slice(0, 7)} -> ${latest.slice(0, 7)}`)
      } catch (e) {
        this.logger.warn(`auto-update failed for site=${site.slug}: ${(e as Error).message}`)
      }
    }
    if (queued) await em.flush()

    this.logger.log(`auto-update sweep: checked=${sites.length} queued=${queued}`)
    return { checked: sites.length, queued }
  }
}
