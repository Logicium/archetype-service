import { BadRequestException, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Site } from '../entities/site.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { SitesService } from '../sites/sites.service'

interface InstagramMedia { id: string; media_type: string; media_url: string; permalink: string; caption?: string; timestamp: string }

/**
 * Instagram Basic Display API integration.
 *  - Admin connects: redirects owner to Instagram OAuth; callback stores long-lived token on Site.
 *  - Public read: returns cached media for the site.
 *  - Background refresh: scheduled job refreshes long-lived tokens before expiry.
 */
@ApiTags('instagram')
@Controller('v1/sites')
export class PublicInstagramController {
  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly sitesSvc: SitesService,
  ) {}

  @Get(':slug/instagram')
  @Header('Cache-Control', 'public, max-age=900, s-maxage=900, stale-while-revalidate=3600')
  async list(@Param('slug') slug: string) {
    const site = await this.sitesSvc.findBySlug(slug)
    if (!site.instagramToken) return { media: [] }
    try {
      const url = `https://graph.instagram.com/me/media?fields=id,media_type,media_url,permalink,caption,timestamp&access_token=${site.instagramToken}&limit=12`
      const res = await fetch(url)
      if (!res.ok) return { media: [] }
      const data = await res.json() as { data: InstagramMedia[] }
      return { media: data.data.filter(m => m.media_type === 'IMAGE' || m.media_type === 'CAROUSEL_ALBUM') }
    } catch {
      return { media: [] }
    }
  }
}

@ApiTags('admin:instagram')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AdminInstagramController {
  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly sitesSvc: SitesService,
  ) {}

  @Get(':id/instagram/connect')
  connectUrl(@Param('id') id: string, @Req() req: AuthRequest) {
    const appId = process.env.INSTAGRAM_APP_ID
    if (!appId) throw new BadRequestException('Instagram not configured')
    const redirect = `${process.env.PUBLIC_BASE_URL}/v1/admin/sites/${id}/instagram/callback`
    return {
      url: `https://api.instagram.com/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&scope=user_profile,user_media&response_type=code&state=${id}`,
    }
  }

  @Get(':id/instagram/callback')
  async callback(@Param('id') id: string, @Req() req: AuthRequest, @Query('code') code?: string) {
    if (!code) throw new BadRequestException('Missing code')
    const site = await this.sitesSvc.getOwned(id, req.owner)
    const appId = process.env.INSTAGRAM_APP_ID, appSecret = process.env.INSTAGRAM_APP_SECRET
    if (!appId || !appSecret) throw new BadRequestException('Instagram not configured')
    const redirect = `${process.env.PUBLIC_BASE_URL}/v1/admin/sites/${id}/instagram/callback`

    // Short-lived token
    const tokRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirect, code }),
    })
    if (!tokRes.ok) throw new BadRequestException(`Instagram token exchange failed: ${await tokRes.text()}`)
    const short = await tokRes.json() as { access_token: string }

    // Exchange for long-lived (60-day) token
    const longRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${appSecret}&access_token=${short.access_token}`)
    const long = await longRes.json() as { access_token: string; expires_in: number }
    site.instagramToken = long.access_token
    site.instagramTokenExpiresAt = new Date(Date.now() + long.expires_in * 1000)
    await this.em.persistAndFlush(site)
    return { ok: true }
  }

  @Post(':id/instagram/disconnect')
  async disconnect(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sitesSvc.getOwned(id, req.owner)
    site.instagramToken = undefined
    site.instagramTokenExpiresAt = undefined
    await this.em.persistAndFlush(site)
    return { ok: true }
  }
}
