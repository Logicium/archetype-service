import { BadRequestException, Body, Controller, Get, Header, Injectable, Logger, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Cron, CronExpression } from '@nestjs/schedule'
import { Client as GMaps } from '@googlemaps/google-maps-services-js'
import { Review } from '../entities/misc.entity'
import { Site } from '../entities/site.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { SitesService } from '../sites/sites.service'

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name)
  private readonly gmaps = new GMaps({})

  constructor(
    @InjectRepository(Review) private readonly reviews: EntityRepository<Review>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
  ) {}

  async fetchForSite(site: Site, em = this.em.fork()): Promise<number> {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key || !site.googlePlaceId) return 0
    try {
      const res = await this.gmaps.placeDetails({
        params: { place_id: site.googlePlaceId, fields: ['reviews'], key },
      })
      const reviews = res.data.result.reviews ?? []
      let added = 0
      for (const rv of reviews) {
        const externalId = `${site.googlePlaceId}:${rv.time}`
        const existing = await em.getRepository(Review).findOne({ site: site.id, externalId })
        if (existing) continue
        const row = em.getRepository(Review).create({
          site,
          source: 'google',
          rating: rv.rating ?? 5,
          author: rv.author_name ?? 'Anonymous',
          text: (rv.text ?? '').slice(0, 2000),
          externalId,
        })
        em.persist(row)
        added += 1
      }
      await em.flush()
      return added
    } catch (e) {
      this.logger.warn(`Google reviews fetch failed for ${site.slug}: ${(e as Error).message}`)
      return 0
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async pollAll() {
    if (!process.env.GOOGLE_PLACES_API_KEY) return
    const em = this.em.fork()
    const sites = await em.getRepository(Site).find({ status: 'live' })
    for (const s of sites) {
      if (s.googlePlaceId) await this.fetchForSite(s, em)
    }
  }
}

@ApiTags('reviews')
@Controller('v1/sites')
export class PublicReviewsController {
  constructor(
    @InjectRepository(Review) private readonly reviews: EntityRepository<Review>,
    private readonly sites: SitesService,
  ) {}

  @Get(':slug/reviews')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=900')
  async list(@Param('slug') slug: string) {
    const site = await this.sites.findBySlug(slug)
    const rows = await this.reviews.find({ site: site.id, visible: true }, { orderBy: { fetchedAt: 'desc' }, limit: 20 })
    return rows.map(r => ({ rating: r.rating, author: r.author, text: r.text, source: r.source, fetchedAt: r.fetchedAt }))
  }
}

@ApiTags('admin:reviews')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AdminReviewsController {
  constructor(
    @InjectRepository(Review) private readonly reviews: EntityRepository<Review>,
    @InjectRepository(Site) private readonly sitesRepo: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly sites: SitesService,
    private readonly reviewsSvc: ReviewsService,
  ) {}

  @Post(':id/google-place')
  async setPlaceId(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { placeId: string }) {
    const site = await this.sites.getOwned(id, req.owner)
    site.googlePlaceId = body.placeId
    await this.em.persistAndFlush(site)
    await this.reviewsSvc.fetchForSite(site)
    return { ok: true }
  }

  @Post(':id/reviews/manual')
  async addManual(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { author: string; rating: number; text: string }) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!body.author || !body.text) throw new BadRequestException('author + text required')
    const r = this.reviews.create({ site, source: 'manual', author: body.author, rating: body.rating ?? 5, text: body.text })
    await this.em.persistAndFlush(r)
    return { id: r.id }
  }
}
