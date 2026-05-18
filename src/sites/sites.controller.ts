import { Body, Controller, Get, Header, Param, Post, Put, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityRepository } from '@mikro-orm/postgresql'
import { SitesService } from './sites.service'
import { DeployLog } from '../entities/misc.entity'
import { GitHubProvisioner } from '../provisioning/github.provisioner'
import { VercelProvisioner } from '../provisioning/vercel.provisioner'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

/** Public read endpoint — fetched by every live archetype site at boot. */
@ApiTags('content')
@Controller('v1/sites')
export class PublicSitesController {
  constructor(private readonly sites: SitesService) {}

  @Get(':slug/content')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300')
  async getContent(@Param('slug') slug: string) {
    const site = await this.sites.findBySlug(slug)
    const content = await this.sites.getPublishedContent(site.id)
    return {
      slug: site.slug,
      archetype: site.archetype,
      plan: site.plan,
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
  ) {}

  @Get()
  async list(@Req() req: AuthRequest) {
    const sites = await this.sites.listForOwner(req.owner)
    return sites.map(s => ({
      id: s.id,
      slug: s.slug,
      archetype: s.archetype,
      status: s.status,
      productionUrl: s.vercelProductionUrl,
      customDomain: s.customDomain,
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
    return { version: row.version, publishedAt: row.publishedAt }
  }

  @Get(':id/content/versions')
  async versions(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const rows = await this.sites.listVersions(site)
    return rows.map(r => ({ version: r.version, published: r.published, publishedAt: r.publishedAt, createdAt: r.createdAt }))
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
    const repoId = await this.github.getRepoId(site.githubRepo)
    const dep = await this.vercel.redeploy(site.vercelProjectId, site.githubRepo, repoId)
    // Always refresh the stable production URL in case the stored value was a deployment-specific URL.
    const stableDomain = await this.vercel.getProductionUrl(site.vercelProjectId)
    if (stableDomain) {
      const url = stableDomain.startsWith('http') ? stableDomain : `https://${stableDomain}`
      site.vercelProductionUrl = url
      site.status = 'live'
      await this.sites.save(site)
    }
    return { ok: true, deploymentId: dep.id, url: site.vercelProductionUrl ?? dep.url }
  }

  @Get(':id/deploy-logs')
  async getDeployLogs(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const logs = await this.deployLogs.find({ site: site.id }, { orderBy: { createdAt: 'asc' }, limit: 100 })
    return logs.map(l => ({ step: l.step, status: l.status, message: l.message, durationMs: l.durationMs, createdAt: l.createdAt }))
  }
}
