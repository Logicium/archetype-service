import { Controller, Get, Injectable, Logger, Param, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Cron, CronExpression } from '@nestjs/schedule'
import { Site } from '../entities/site.entity'
import { SiteMetric } from '../entities/misc.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { SitesService } from '../sites/sites.service'
import { EmailService } from '../common/email.service'

@Injectable()
export class UptimeService {
  private readonly logger = new Logger(UptimeService.name)
  /** Track consecutive failures per site for alerting. */
  private readonly fails = new Map<string, number>()

  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    @InjectRepository(SiteMetric) private readonly metrics: EntityRepository<SiteMetric>,
    private readonly em: EntityManager,
    private readonly email: EmailService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async probeAll() {
    if (process.env.FEATURE_UPTIME === 'false') return
    const em = this.em.fork()
    const live = await em.getRepository(Site).find({ status: 'live' })
    for (const s of live) await this.probe(s, em)
  }

  async probe(site: Site, em = this.em.fork()) {
    const target = site.customDomain ? `https://${site.customDomain}` : (site.vercelProductionUrl ? (site.vercelProductionUrl.startsWith('http') ? site.vercelProductionUrl : `https://${site.vercelProductionUrl}`) : null)
    if (!target) return
    const start = Date.now()
    let ok = false, error: string | undefined
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(target, { method: 'HEAD', signal: controller.signal })
      clearTimeout(t)
      ok = res.ok
      if (!ok) error = `HTTP ${res.status}`
    } catch (e) {
      error = (e as Error).message
    }
    const latency = Date.now() - start
    const today = new Date(); today.setHours(0, 0, 0, 0)
    let metric = await em.getRepository(SiteMetric).findOne({ site: site.id, date: today })
    if (!metric) metric = em.getRepository(SiteMetric).create({ site, date: today })
    metric.uptimeLatencyMs = ok ? latency : 0
    metric.uptimeError = ok ? undefined : error
    await em.persistAndFlush(metric)

    if (ok) {
      this.fails.delete(site.id)
    } else {
      const n = (this.fails.get(site.id) ?? 0) + 1
      this.fails.set(site.id, n)
      if (n === 2) {
        // Two consecutive failures → alert.
        await this.email.alertAdmin(`Site down: ${site.slug}`, `<p>${target} failing: ${error}</p>`)
      }
    }
  }
}

@ApiTags('admin:analytics')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AnalyticsController {
  constructor(
    @InjectRepository(SiteMetric) private readonly metrics: EntityRepository<SiteMetric>,
    private readonly sites: SitesService,
  ) {}

  @Get(':id/analytics')
  async analytics(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const rows = await this.metrics.find({ site: site.id, date: { $gte: since } }, { orderBy: { date: 'asc' } })
    return rows.map(r => ({
      date: r.date,
      visitors: r.visitors,
      pageviews: r.pageviews,
      uptimeLatencyMs: r.uptimeLatencyMs,
      uptimeError: r.uptimeError,
    }))
  }
}
