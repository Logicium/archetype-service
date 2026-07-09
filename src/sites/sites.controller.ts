import { Body, Controller, Get, Header, Param, Post, Put, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityRepository } from '@mikro-orm/postgresql'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { SitesService } from './sites.service'
import { ScreenshotService } from '../screenshot/screenshot.service'
import { DeployLog } from '../entities/misc.entity'
import { Site } from '../entities/site.entity'
import { GitHubProvisioner } from '../provisioning/github.provisioner'
import { VercelProvisioner } from '../provisioning/vercel.provisioner'
import { SITE_UPDATE_JOB, SITE_UPDATE_QUEUE } from '../provisioning/provisioning.constants'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { OrdersService } from '../orders/orders.service'
import { resolveDeployedContentApiUrl } from '../provisioning/content-api.util'

/**
 * Screenshots are recaptured automatically when the persisted one is older than
 * this threshold. The list endpoint enqueues a background capture if any live
 * site's `screenshotCapturedAt` predates this window. Override with
 * SCREENSHOT_STALE_AFTER_DAYS.
 */
const SCREENSHOT_STALE_AFTER_MS =
  Number(process.env.SCREENSHOT_STALE_AFTER_DAYS ?? 14) * 24 * 60 * 60 * 1_000

/** Public read endpoint — fetched by every live archetype site at boot. */
@ApiTags('content')
@Controller('v1/sites')
export class PublicSitesController {
  constructor(private readonly sites: SitesService) {}

  @Get(':key/content')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300')
  async getContent(@Param('key') key: string) {
    const site = await this.sites.findByIdOrSlug(key)
    const content = await this.sites.getPublishedContent(site.id)
    return {
      slug: site.slug,
      archetype: site.archetype,
      plan: site.plan,
      addOns: site.addOns || [],
      content: content ?? {},
    }
  }
}

/** Owner-authenticated admin endpoints. */
@ApiTags('admin:sites')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AdminSitesController {
  constructor(
    private readonly sites: SitesService,
    @InjectRepository(DeployLog) private readonly deployLogs: EntityRepository<DeployLog>,
    private readonly github: GitHubProvisioner,
    private readonly vercel: VercelProvisioner,
    @InjectQueue(SITE_UPDATE_QUEUE) private readonly updateQueue: Queue,
    private readonly screenshot: ScreenshotService,
    private readonly orders: OrdersService,
  ) {}

  @Get()
  async list(@Req() req: AuthRequest & { query: { includeDeactivated?: string } }) {
    const includeDeactivated = req.query?.includeDeactivated === '1' || req.query?.includeDeactivated === 'true'
    const sites = await this.sites.listForOwner(req.owner, { includeDeactivated })
    // Stale-screenshot sweep: any live site whose screenshot is missing or
    // older than STALE_AFTER_MS gets a background capture queued. Fire-and-forget
    // so the list response isn't blocked by Puppeteer. Inflight dedup in the
    // service prevents duplicate captures if list() is called repeatedly.
    for (const s of sites) {
      const url = s.customDomain ? `https://${s.customDomain}` : s.vercelProductionUrl
      if (!url) continue
      const urlDrifted = s.screenshotSourceUrl != null && s.screenshotSourceUrl !== url
      if (!s.screenshotUrl || urlDrifted || this.screenshot.isStale(s, SCREENSHOT_STALE_AFTER_MS)) {
        void this.captureInBackground(s, url)
      }
    }
    // Latest successful deploy activity per site (one grouped query).
    const lastDeployBySite = new Map<string, string>()
    if (sites.length) {
      try {
        const rows: Array<Record<string, unknown>> = await this.deployLogs
          .createQueryBuilder('d')
          .select(['d.site'])
          .addSelect('max(d.created_at) as last')
          .where({ site: { $in: sites.map(s => s.id) }, status: 'success' })
          .groupBy('d.site')
          .execute('all')
        for (const r of rows) {
          const key = (r.site ?? r.site_id) as string | undefined
          const last = r.last as string | Date | undefined
          if (key && last) lastDeployBySite.set(String(key), new Date(last).toISOString())
        }
      } catch { /* metadata only — never block the list */ }
    }

    return sites.map(s => ({
      id: s.id,
      slug: s.slug,
      displayName: s.displayName ?? null,
      archetype: s.archetype,
      status: s.status,
      productionUrl: s.customDomain ? `https://${s.customDomain}` : s.vercelProductionUrl,
      customDomain: s.customDomain,
      deactivatedAt: s.deactivatedAt ?? null,
      screenshotUrl: s.screenshotUrl ?? null,
      screenshotCapturedAt: s.screenshotCapturedAt ?? null,
      addOns: s.addOns ?? [],
      templateCommitSha: s.templateCommitSha ?? null,
      lastDeployedAt: lastDeployBySite.get(s.id) ?? null,
    }))
  }

  @Get(':id')
  async detail(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.sites.getOwned(id, req.owner)
  }

  @Get(':id/content/draft')
  async getDraft(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const latest = await this.sites.getLatestContent(site.id)
    return { version: latest?.version ?? 0, published: latest?.published ?? false, payload: latest?.payload ?? {} }
  }

  @Put(':id/content/draft')
  async saveDraft(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { payload: Record<string, unknown> }) {
    const site = await this.sites.getOwned(id, req.owner)
    const row = await this.sites.saveDraft(site, body.payload)
    return { version: row.version, published: row.published }
  }

  @Post(':id/content/publish')
  async publish(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { payload?: Record<string, unknown> }) {
    const site = await this.sites.getOwned(id, req.owner)
    const row = await this.sites.publish(site, body.payload)
    await this.sites.ensureDisplayNameFromPayload(site, body.payload ?? row.payload as Record<string, unknown>)
    return { version: row.version, publishedAt: row.publishedAt }
  }

  @Get(':id/content/versions')
  async versions(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const rows = await this.sites.listVersionsWithDiff(site)
    return rows.map(r => ({
      version: r.version,
      published: r.published,
      publishedAt: r.publishedAt,
      createdAt: r.createdAt,
      changes: r.changes,
    }))
  }

  @Post(':id/content/versions/:version/restore')
  async restore(@Param('id') id: string, @Param('version') version: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const row = await this.sites.restoreVersion(site, parseInt(version, 10))
    return { version: row.version, publishedAt: row.publishedAt }
  }

  @Post(':id/redeploy')
  async redeploy(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!site.vercelProjectId) throw new Error('No Vercel project linked to this site')
    if (!site.githubRepo) throw new Error('No GitHub repo linked to this site')
    // Re-apply the canonical env vars BEFORE triggering the deployment so changes
    // to DEPLOYED_CONTENT_API_URL (or slug) actually take effect on the next build.
    // setEnv PATCHes existing vars on Vercel, so this is safe to call every time.
    try {
      await this.vercel.setEnv(site.vercelProjectId, 'VITE_SITE_ID', site.id)
      await this.vercel.setEnv(site.vercelProjectId, 'VITE_SITE_SLUG', site.slug)
      await this.vercel.setEnv(site.vercelProjectId, 'VITE_CONTENT_API', resolveDeployedContentApiUrl())
      await this.vercel.setEnv(site.vercelProjectId, 'VITE_PLATFORM_ENABLED', 'true')
    } catch (e) {
      // Surface the localhost-URL guard error clearly instead of silently shipping a broken build.
      throw new Error(`Cannot redeploy: ${(e as Error).message}`)
    }
    const { repoId, defaultBranch } = await this.github.getRepoInfo(site.githubRepo)
    const dep = await this.vercel.redeploy(site.vercelProjectId, site.githubRepo, repoId, defaultBranch)
    // Always refresh the stable production URL in case the stored value was a deployment-specific URL.
    const stableDomain = await this.vercel.getProductionUrl(site.vercelProjectId)
    if (stableDomain) {
      const url = stableDomain.startsWith('http') ? stableDomain : `https://${stableDomain}`
      site.vercelProductionUrl = url
      site.status = 'live'
      await this.sites.save(site)
    }
    // Record the trigger so the site list's "last deployed" stays truthful.
    const em = this.deployLogs.getEntityManager()
    em.persist(this.deployLogs.create({ site, step: 'redeploy', status: 'success', message: `Triggered deployment ${dep.id}` }))
    await em.flush()
    return { ok: true, deploymentId: dep.id, url: site.vercelProductionUrl ?? dep.url }
  }

  @Get(':id/deploy-logs')
  async getDeployLogs(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const logs = await this.deployLogs.find({ site: site.id }, { orderBy: { createdAt: 'asc' }, limit: 100 })
    return logs.map(l => ({ step: l.step, status: l.status, message: l.message, durationMs: l.durationMs, createdAt: l.createdAt }))
  }

  /**
   * Returns the live Vercel deployment state so the UI can render a progress
   * indicator on the site card while a redeploy/update is in flight. If
   * `deploymentId` is provided we ask for that exact one; otherwise we look up
   * the latest production deployment for the linked project.
   */
  @Get(':id/deployment-status')
  async deploymentStatus(
    @Param('id') id: string,
    @Req() req: AuthRequest & { query: { deploymentId?: string } },
  ) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!site.vercelProjectId) return { state: 'UNKNOWN', siteStatus: site.status }
    const deploymentId = req.query.deploymentId
    const dep = deploymentId
      ? await this.vercel.getDeploymentState(deploymentId)
      : await this.vercel.getLatestDeployment(site.vercelProjectId)
    return {
      state: dep?.state ?? 'UNKNOWN',
      deploymentId: dep?.id ?? null,
      url: dep?.url ?? null,
      createdAt: dep?.createdAt ?? null,
      siteStatus: site.status,
      productionUrl: site.vercelProductionUrl ?? null,
    }
  }

  /** Compares the recorded templateCommitSha against the latest commit on the template's default branch. */
  @Get(':id/update-status')
  async updateStatus(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const templateRepo = this.github.templateFor(site.archetype)
    const templateOwner = process.env.GITHUB_ORG || ''
    if (!templateOwner) return { current: site.templateCommitSha ?? null, latest: null, hasUpdate: false }
    const info = await this.github.getRepoInfo(`${templateOwner}/${templateRepo}`)
    const latest = await this.github.getLatestCommitSha(templateOwner, templateRepo, info.defaultBranch)
    return {
      current: site.templateCommitSha ?? null,
      latest,
      hasUpdate: !!site.templateCommitSha && site.templateCommitSha !== latest,
      neverChecked: !site.templateCommitSha,
    }
  }

  /** Queues a worker job that syncs template files into the customer repo and redeploys. */
  @Post(':id/update')
  async triggerUpdate(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const job = await this.updateQueue.add(SITE_UPDATE_JOB, { siteId: site.id }, { removeOnComplete: 50, removeOnFail: 50 })
    return { ok: true, jobId: job.id }
  }

  /**
   * Force the site's linked order back into provisioning. Useful when GitHub/Vercel
   * setup half-completed and we need a clean retry. Idempotent: existing repo/project
   * are reused.
   */
  @Post(':id/reprovision')
  async reprovision(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    if (site.status !== 'failed' && site.status !== 'provisioning' && site.status !== 'draft') {
      // Allow live sites too \u2014 sometimes a "live" status is wrong because vercel-deploy succeeded
      // but the URL recorded is bogus. Reprovisioning is idempotent.
    }
    site.status = 'provisioning'
    await this.sites.save(site)
    return this.orders.reprovisionForSite(site.id, req.owner)
  }

  /** Returns Stripe session/payment-intent/event status for the order that produced this site. */
  @Get(':id/billing-status')
  async billingStatus(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    return this.orders.getStripeStatusForSite(site.id, req.owner)
  }

  /** If Stripe confirms the session is paid, flip the order to paid and enqueue provisioning. */
  @Post(':id/resolve-billing')
  async resolveBilling(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    return this.orders.resolveBillingForSite(site.id, req.owner)
  }

  /** Rename a site (display label only — slug stays stable). */
  @Put(':id')
  async rename(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { displayName?: string }) {
    const site = await this.sites.getOwned(id, req.owner)
    const next = await this.sites.rename(site, body.displayName ?? '')
    return { id: next.id, displayName: next.displayName ?? null }
  }

  /** Pause a site — hides from default admin list. Vercel + repo are kept intact. */
  @Post(':id/deactivate')
  async deactivate(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const next = await this.sites.deactivate(site)
    return { id: next.id, deactivatedAt: next.deactivatedAt }
  }

  /** Reactivate a paused site. */
  @Post(':id/activate')
  async activate(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const next = await this.sites.activate(site)
    return { id: next.id, deactivatedAt: next.deactivatedAt ?? null }
  }

  /**
   * Returns the persisted screenshot metadata for a site. The frontend uses the
   * `url` directly as an <img src> (it's a public Vercel Blob URL), so this
   * endpoint never streams PNG bytes through Node. Returns `{url: null}` when
   * no screenshot has been captured yet.
   *
   * This endpoint does NOT trigger captures. To force a new screenshot, POST
   * `/admin/sites/:id/screenshot/refresh`.
   */
  @Get(':id/screenshot')
  async getScreenshot(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    return {
      url: site.screenshotUrl ?? null,
      capturedAt: site.screenshotCapturedAt ?? null,
      sourceUrl: site.screenshotSourceUrl ?? null,
    }
  }

  /**
   * Captures a fresh screenshot of the site's current production URL and
   * persists the resulting public Blob URL on the Site entity. Resolves the
   * live URL from Vercel first so renamed projects are caught immediately.
   * Returns the same shape as GET /screenshot.
   */
  @Post(':id/screenshot/refresh')
  async refreshScreenshot(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const url = await this.resolveLiveUrl(site)
    if (!url) {
      return { url: null, capturedAt: null, sourceUrl: null, error: 'No production URL for this site' }
    }
    await this.screenshot.captureForSite(site, url)
    await this.sites.save(site)
    return {
      url: site.screenshotUrl ?? null,
      capturedAt: site.screenshotCapturedAt ?? null,
      sourceUrl: site.screenshotSourceUrl ?? null,
    }
  }

  /**
   * Best-effort background capture used by `list()` for stale/missing
   * screenshots. Loads a fresh entity reference so we flush only the
   * screenshot fields; any error is swallowed (logged) since this is
   * fire-and-forget.
   */
  private async captureInBackground(site: Site, url: string): Promise<void> {
    try {
      await this.screenshot.captureForSite(site, url)
      await this.sites.save(site)
    } catch {
      // Logged inside ScreenshotService; nothing the list response can do.
    }
  }

  /**
   * Resolves the authoritative production URL for a site. Custom domain takes
   * precedence; otherwise asks Vercel (which may have auto-renamed the
   * project) and persists the new value if it changed.
   */
  private async resolveLiveUrl(site: Site): Promise<string | undefined> {
    if (site.customDomain) return `https://${site.customDomain}`
    if (!site.vercelProjectId) return site.vercelProductionUrl
    const fresh = await this.vercel.getProductionUrl(site.vercelProjectId).catch(() => null)
    if (fresh && fresh !== site.vercelProductionUrl) {
      site.vercelProductionUrl = fresh
      await this.sites.save(site)
    }
    return fresh ?? site.vercelProductionUrl
  }
}
