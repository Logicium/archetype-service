import { Body, Controller, Get, Header, Injectable, Logger, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
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

  /** Text search for businesses on Google Places. Returns lightweight candidates. */
  async searchPlaces(query: string) {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) return []
    try {
      const res = await this.gmaps.textSearch({ params: { query, key } })
      return (res.data.results ?? []).slice(0, 8).map(r => ({
        placeId: r.place_id ?? '',
        name: r.name ?? '',
        address: r.formatted_address ?? '',
        rating: r.rating ?? null,
        totalRatings: r.user_ratings_total ?? null,
      })).filter(r => r.placeId)
    } catch (e) {
      this.logger.warn(`Places search failed for "${query}": ${(e as Error).message}`)
      return []
    }
  }

  /** Lightweight place details for the picker preview (no DB writes). */
  async placePreview(placeId: string) {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) return null
    try {
      const res = await this.gmaps.placeDetails({
        params: {
          place_id: placeId,
          fields: ['name', 'formatted_address', 'rating', 'user_ratings_total', 'url', 'reviews'],
          key,
        },
      })
      const r = res.data.result
      return {
        placeId,
        name: r.name ?? '',
        address: r.formatted_address ?? '',
        rating: r.rating ?? null,
        totalRatings: r.user_ratings_total ?? null,
        url: r.url ?? null,
        reviews: (r.reviews ?? []).slice(0, 5).map(rv => ({
          author: rv.author_name ?? 'Anonymous',
          rating: rv.rating ?? 5,
          text: rv.text ?? '',
          time: rv.time ?? 0,
          relativeTime: rv.relative_time_description ?? '',
        })),
      }
    } catch (e) {
      this.logger.warn(`Place preview failed for ${placeId}: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * Server-side geocoding for the admin's address picker so the Google Maps
   * key never ships to the browser. Returns up to 5 candidates.
   */
  async geocode(query: string) {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) return []
    try {
      const res = await this.gmaps.geocode({ params: { address: query, key } })
      return (res.data.results ?? []).slice(0, 5).map(r => ({
        placeId: r.place_id,
        address: r.formatted_address,
      }))
    } catch (e) {
      this.logger.warn(`Geocode failed for "${query}": ${(e as Error).message}`)
      return []
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

  @Get(':key/reviews')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=900')
  async list(@Param('key') key: string) {
    const site = await this.sites.findByIdOrSlug(key)
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

  @Get(':id/google-place')
  async getPlace(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!site.googlePlaceId) return { placeId: null, preview: null }
    const preview = await this.reviewsSvc.placePreview(site.googlePlaceId).catch(() => null)
    return { placeId: site.googlePlaceId, preview }
  }

  @Post(':id/google-place')
  async setPlaceId(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { placeId: string }) {
    const site = await this.sites.getOwned(id, req.owner)
    const previous = site.googlePlaceId
    site.googlePlaceId = body.placeId
    // Clear cached reviews from any previously-connected business so the
    // admin / public site never show stale or unrelated reviews.
    if (previous && previous !== body.placeId) {
      await this.em.nativeDelete(Review, { site: site.id, source: 'google' })
    }
    await this.em.persistAndFlush(site)
    await this.reviewsSvc.fetchForSite(site)
    const preview = await this.reviewsSvc.placePreview(body.placeId).catch(() => null)
    return { ok: true, placeId: body.placeId, preview }
  }

  @Post(':id/google-place/disconnect')
  async clearPlace(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    site.googlePlaceId = undefined
    // Wipe cached Google reviews so the public site stops showing them.
    await this.em.nativeDelete(Review, { site: site.id, source: 'google' })
    await this.em.persistAndFlush(site)
    return { ok: true }
  }

  @Get(':id/google-places/search')
  async searchPlaces(@Param('id') id: string, @Req() req: AuthRequest, @Query('q') q: string) {
    await this.sites.getOwned(id, req.owner)
    if (!q || q.trim().length < 2) return { results: [] }
    return { results: await this.reviewsSvc.searchPlaces(q.trim()) }
  }

  @Get(':id/geocode')
  async geocode(@Param('id') id: string, @Req() req: AuthRequest, @Query('q') q: string) {
    await this.sites.getOwned(id, req.owner)
    if (!q || q.trim().length < 3) return { results: [] }
    return { results: await this.reviewsSvc.geocode(q.trim()) }
  }

  @Get(':id/reviews')
  async listReviews(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const rows = await this.reviews.find(
      { site: site.id },
      { orderBy: { fetchedAt: 'desc' }, limit: 25 },
    )
    return rows.map(r => ({
      id: r.id,
      rating: r.rating,
      author: r.author,
      text: r.text,
      source: r.source,
      fetchedAt: r.fetchedAt,
    }))
  }
}
