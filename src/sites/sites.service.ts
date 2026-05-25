import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Site } from '../entities/site.entity'
import { SiteContent } from '../entities/site-content.entity'
import { Owner } from '../entities/owner.entity'
import { diffContent, type ContentDiff } from './content-diff.util'

@Injectable()
export class SitesService {
  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    @InjectRepository(SiteContent) private readonly contents: EntityRepository<SiteContent>,
    private readonly em: EntityManager,
  ) {}

  async findBySlug(slug: string): Promise<Site> {
    const site = await this.sites.findOne({ slug })
    if (!site) throw new NotFoundException('Site not found')
    return site
  }

  /**
   * Public lookup that accepts either a UUID (preferred — immutable, set at
   * provision time as `VITE_SITE_ID`) or a slug (legacy — still used by older
   * deployments before the ID switchover). UUID is detected by canonical
   * 8-4-4-4-12 hex format; anything else is treated as a slug.
   */
  async findByIdOrSlug(key: string): Promise<Site> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
    const site = isUuid
      ? await this.sites.findOne({ id: key })
      : await this.sites.findOne({ slug: key })
    if (!site) throw new NotFoundException('Site not found')
    return site
  }

  async listForOwner(owner: Owner, opts: { includeDeactivated?: boolean } = {}): Promise<Site[]> {
    const where: Record<string, unknown> = { owner: owner.id }
    if (!opts.includeDeactivated) where.deactivatedAt = null
    return this.sites.find(where)
  }

  /** Rename the human-readable site label shown throughout the admin. */
  async rename(site: Site, displayName: string): Promise<Site> {
    const trimmed = displayName.trim()
    site.displayName = trimmed || undefined
    await this.em.persistAndFlush(site)
    return site
  }

  /** Pause a site (hide from default admin list, keep Vercel + repo intact). */
  async deactivate(site: Site): Promise<Site> {
    if (!site.deactivatedAt) {
      site.deactivatedAt = new Date()
      await this.em.persistAndFlush(site)
    }
    return site
  }

  /** Reactivate a paused site. */
  async activate(site: Site): Promise<Site> {
    if (site.deactivatedAt) {
      site.deactivatedAt = undefined
      await this.em.persistAndFlush(site)
    }
    return site
  }

  /** Auto-source displayName from siteConfig.brand on first publish if not already set. */
  async ensureDisplayNameFromPayload(site: Site, payload: Record<string, unknown> | undefined): Promise<void> {
    if (site.displayName || !payload) return
    const brand = (payload as { brand?: unknown }).brand
    if (typeof brand === 'string' && brand.trim()) {
      site.displayName = brand.trim()
      await this.em.persistAndFlush(site)
    }
  }

  async getOwned(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId }, { populate: ['owner'] as never })
    if (!site) throw new NotFoundException('Site not found')
    if (site.owner.id !== owner.id) throw new ForbiddenException('Not your site')
    return site
  }

  async save(site: Site): Promise<void> {
    await this.em.persistAndFlush(site)
  }

  /** Returns the latest published overlay payload (or null if no publish yet). */
  async getPublishedContent(siteId: string): Promise<Record<string, unknown> | null> {
    const row = await this.contents.findOne({ site: siteId, published: true }, { orderBy: { version: 'desc' } })
    return row?.payload ?? null
  }

  /** Returns the latest content row (draft or published). */
  async getLatestContent(siteId: string): Promise<SiteContent | null> {
    return this.contents.findOne({ site: siteId }, { orderBy: { version: 'desc' } })
  }

  /** Save a new draft (or overwrite the open draft) without publishing. */
  async saveDraft(site: Site, payload: Record<string, unknown>): Promise<SiteContent> {
    const latest = await this.getLatestContent(site.id)
    if (latest && !latest.published) {
      latest.payload = payload
      await this.em.persistAndFlush(latest)
      return latest
    }
    const next = this.contents.create({
      site,
      version: (latest?.version ?? 0) + 1,
      payload,
      published: false,
    })
    await this.em.persistAndFlush(next)
    return next
  }

  /** Publish the current draft, or create a published version from `payload`. */
  async publish(site: Site, payload?: Record<string, unknown>): Promise<SiteContent> {
    const latest = await this.getLatestContent(site.id)
    let target: SiteContent
    if (latest && !latest.published) {
      if (payload) latest.payload = payload
      latest.published = true
      latest.publishedAt = new Date()
      target = latest
    } else {
      target = this.contents.create({
        site,
        version: (latest?.version ?? 0) + 1,
        payload: payload ?? latest?.payload ?? {},
        published: true,
        publishedAt: new Date(),
      })
    }
    await this.em.persistAndFlush(target)
    return target
  }

  async listVersions(site: Site): Promise<SiteContent[]> {
    return this.contents.find({ site: site.id }, { orderBy: { version: 'desc' }, limit: 50 })
  }

  /**
   * Returns the same versions as `listVersions`, paired with a summary of
   * what changed compared to the previous version. The oldest entry has an
   * empty diff (no predecessor).
   */
  async listVersionsWithDiff(site: Site): Promise<Array<SiteContent & { changes: ContentDiff }>> {
    const rows = await this.listVersions(site)
    // rows are newest-first; predecessor of rows[i] is rows[i + 1].
    return rows.map((row, i) => {
      const prev = rows[i + 1]
      const changes = prev ? diffContent(prev.payload, row.payload) : { paths: [], count: 0 }
      return Object.assign(row, { changes })
    })
  }

  async restoreVersion(site: Site, version: number): Promise<SiteContent> {
    const target = await this.contents.findOne({ site: site.id, version })
    if (!target) throw new NotFoundException('Version not found')
    return this.publish(site, target.payload)
  }

  /** Build a unique slug from a desired base. */
  async generateSlug(base: string): Promise<string> {
    const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site'
    let candidate = clean
    let n = 0
    while (await this.sites.findOne({ slug: candidate })) {
      n += 1
      candidate = `${clean}-${n}`
    }
    return candidate
  }

  /** Returns the list of distinct custom domains for dynamic CORS. */
  async allLiveOrigins(): Promise<string[]> {
    const live = await this.sites.find({ status: 'live' })
    const origins: string[] = []
    for (const s of live) {
      if (s.vercelProductionUrl) origins.push(`https://${s.vercelProductionUrl.replace(/^https?:\/\//, '')}`)
      if (s.customDomain) origins.push(`https://${s.customDomain}`, `https://www.${s.customDomain}`)
    }
    return origins
  }
}
