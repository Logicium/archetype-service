import { Body, Controller, Get, Headers, Injectable, Ip, Logger, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { IsOptional, IsString, MaxLength } from 'class-validator'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Cron, CronExpression } from '@nestjs/schedule'
import { createHash } from 'crypto'
import { Site } from '../entities/site.entity'
import { SiteMetric, PageHit, type DeviceKind } from '../entities/misc.entity'
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

  /** Prune raw pageview rows past the retention window; daily rollups on
   *  SiteMetric are kept indefinitely, so trend charts are unaffected. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async pruneOldHits() {
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
    try {
      await this.em.fork().nativeDelete(PageHit, { createdAt: { $lt: cutoff } })
    } catch (e) {
      this.logger.warn(`PageHit prune failed: ${(e as Error).message}`)
    }
  }

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

/** Device class from a User-Agent string — coarse buckets are all we chart. */
function deviceFromUA(ua: string | undefined): DeviceKind {
  const s = (ua || '').toLowerCase()
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)) return 'tablet'
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini/.test(s)) return 'mobile'
  return 'desktop'
}

/** Referrer → bare host, dropping our own hosts (self-referrals) and junk. */
function referrerHost(ref: string | undefined, selfHosts: string[]): string | undefined {
  if (!ref) return undefined
  try {
    const host = new URL(ref).host.replace(/^www\./, '')
    if (!host) return undefined
    if (selfHosts.some(h => host === h || host.endsWith(`.${h}`))) return undefined
    return host.slice(0, 255)
  } catch {
    return undefined
  }
}

/** Rotating daily salt so visitor hashes can't be correlated across days. */
function dailySalt(): string {
  const d = new Date()
  return `${process.env.JWT_SECRET || 'salt'}:${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}

class CollectDto {
  @IsString() @MaxLength(512) path!: string
  @IsOptional() @IsString() @MaxLength(2048) referrer?: string
}

/** Public analytics ingest — fired by deployed sites' beacon. */
@ApiTags('analytics')
@Controller('v1/sites')
export class AnalyticsIngestController {
  private readonly logger = new Logger(AnalyticsIngestController.name)

  constructor(
    @InjectRepository(PageHit) private readonly hits: EntityRepository<PageHit>,
    @InjectRepository(SiteMetric) private readonly metrics: EntityRepository<SiteMetric>,
    private readonly em: EntityManager,
    private readonly sites: SitesService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':key/collect')
  async collect(
    @Param('key') key: string,
    @Body() dto: CollectDto,
    @Ip() ip: string,
    @Headers('user-agent') ua?: string,
  ) {
    let site: Site
    try { site = await this.sites.findByIdOrSlug(key) } catch { return { ok: true } } // never leak existence
    const em = this.em.fork()

    const device = deviceFromUA(ua)
    const selfHosts = [site.customDomain, site.vercelProductionUrl?.replace(/^https?:\/\//, '')]
      .filter(Boolean).map(h => (h as string).replace(/^www\./, ''))
    const host = referrerHost(dto.referrer, selfHosts)
    const path = (dto.path || '/').split(/[?#]/)[0]!.slice(0, 512)
    const visitorHash = createHash('sha256').update(`${site.id}|${ip}|${ua || ''}|${dailySalt()}`).digest('hex').slice(0, 64)

    // Is this visitor already counted today? (indexed lookup, not a scan)
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const seen = await em.getRepository(PageHit).findOne({ site: site.id, visitorHash, createdAt: { $gte: startOfDay } })

    em.persist(em.getRepository(PageHit).create({ site, path, referrerHost: host, device, visitorHash }))

    let metric = await em.getRepository(SiteMetric).findOne({ site: site.id, date: startOfDay })
    if (!metric) metric = em.getRepository(SiteMetric).create({ site, date: startOfDay })
    metric.pageviews += 1
    if (!seen) metric.visitors += 1
    em.persist(metric)

    await em.flush()
    return { ok: true }
  }
}

@ApiTags('admin:analytics')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AnalyticsController {
  constructor(
    @InjectRepository(SiteMetric) private readonly metrics: EntityRepository<SiteMetric>,
    @InjectRepository(PageHit) private readonly hits: EntityRepository<PageHit>,
    private readonly em: EntityManager,
    private readonly sites: SitesService,
  ) {}

  @Get(':id/analytics')
  async analytics(@Param('id') id: string, @Req() req: AuthRequest, @Query('range') rangeRaw?: string) {
    const site = await this.sites.getOwned(id, req.owner)
    const range = [7, 30, 90].includes(Number(rangeRaw)) ? Number(rangeRaw) : 30

    const dayMs = 86_400_000
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const rangeStart = new Date(startOfToday.getTime() - (range - 1) * dayMs)
    const prevStart = new Date(rangeStart.getTime() - range * dayMs)

    // ── Daily trend (gap-filled) from SiteMetric ──
    const metricRows = await this.metrics.find(
      { site: site.id, date: { $gte: prevStart } },
      { orderBy: { date: 'asc' } },
    )
    const byDay = new Map<string, { visitors: number; pageviews: number; uptimeLatencyMs: number; uptimeError?: string }>()
    for (const r of metricRows) {
      byDay.set(dayKey(r.date), { visitors: r.visitors, pageviews: r.pageviews, uptimeLatencyMs: r.uptimeLatencyMs, uptimeError: r.uptimeError })
    }
    const series: Array<{ date: string; visitors: number; pageviews: number; latencyMs: number; up: boolean | null }> = []
    for (let i = 0; i < range; i++) {
      const d = new Date(rangeStart.getTime() + i * dayMs)
      const k = dayKey(d)
      const m = byDay.get(k)
      series.push({
        date: k,
        visitors: m?.visitors ?? 0,
        pageviews: m?.pageviews ?? 0,
        latencyMs: m?.uptimeLatencyMs ?? 0,
        up: m ? (m.uptimeLatencyMs > 0) : null,
      })
    }

    // ── Totals + previous-period deltas ──
    const sum = (from: Date, to: Date, field: 'visitors' | 'pageviews') => {
      let t = 0
      for (const r of metricRows) if (r.date >= from && r.date < to && r.date <= startOfToday) t += r[field]
      return t
    }
    const totals = {
      visitors: sum(rangeStart, new Date(startOfToday.getTime() + dayMs), 'visitors'),
      pageviews: sum(rangeStart, new Date(startOfToday.getTime() + dayMs), 'pageviews'),
      prevVisitors: sum(prevStart, rangeStart, 'visitors'),
      prevPageviews: sum(prevStart, rangeStart, 'pageviews'),
    }

    // Uptime % + avg latency across the range (only days we actually probed).
    const probed = series.filter(s => s.up !== null)
    const upDays = probed.filter(s => s.up).length
    const latencies = probed.filter(s => s.latencyMs > 0).map(s => s.latencyMs)
    const uptimePct = probed.length ? Math.round((upDays / probed.length) * 1000) / 10 : null
    const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null

    // ── Breakdowns from PageHit over the range ──
    const [topPages, sources, devices, byHour] = await Promise.all([
      this.groupCount('path', site.id, rangeStart, 12),
      this.groupCount('referrer_host', site.id, rangeStart, 8),
      this.groupCount('device', site.id, rangeStart, 3),
      this.hourHistogram(site.id, rangeStart),
    ])

    return {
      range,
      series,
      totals,
      uptimePct,
      avgLatencyMs,
      topPages,
      sources: sources.map(s => ({ label: s.label || 'Direct', views: s.views })),
      devices,
      byHour,
    }
  }

  /** GROUP BY one column, most-frequent first. Null values collapse to ''.
   *  `column` is an internal allow-listed identifier, never user input. */
  private async groupCount(column: 'path' | 'referrer_host' | 'device', siteId: string, since: Date, limit: number) {
    const schema = process.env.DB_SCHEMA || 'archetype'
    const rows = await this.em.getConnection().execute<Array<{ label: string | null; views: string | number }>>(
      `SELECT coalesce("${column}", '') as label, count(*) as views
       FROM "${schema}"."page_hit"
       WHERE "site_id" = ? AND "created_at" >= ?
       GROUP BY "${column}" ORDER BY views DESC LIMIT ?`,
      [siteId, since, limit],
    )
    return rows.map(r => ({ label: r.label ?? '', views: Number(r.views) }))
  }

  /** 24-bucket hour-of-day histogram over the range. */
  private async hourHistogram(siteId: string, since: Date) {
    const schema = process.env.DB_SCHEMA || 'archetype'
    const rows = await this.em.getConnection().execute<Array<{ hour: string | number; views: string | number }>>(
      `SELECT extract(hour from "created_at") as hour, count(*) as views
       FROM "${schema}"."page_hit"
       WHERE "site_id" = ? AND "created_at" >= ?
       GROUP BY hour`,
      [siteId, since],
    )
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, views: 0 }))
    for (const r of rows) { const h = Number(r.hour); if (h >= 0 && h < 24) buckets[h]!.views = Number(r.views) }
    return buckets
  }
}

function dayKey(d: Date): string {
  return new Date(d).toISOString().slice(0, 10)
}
