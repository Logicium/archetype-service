import { BadRequestException, Controller, Get, Header, Injectable, Logger, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Cron, CronExpression } from '@nestjs/schedule'
import { Site } from '../entities/site.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { SitesService } from '../sites/sites.service'

interface InstagramMedia { id: string; media_type: string; media_url: string; permalink: string; caption?: string; timestamp: string }

/**
 * Instagram integration — "Instagram API with Instagram Login".
 *
 * The Basic Display API this module originally targeted was shut down by
 * Meta on 2024-12-04. The replacement flow:
 *   - requires the IG account to be a professional account (Business/Creator),
 *   - authorizes at www.instagram.com/oauth/authorize with the
 *     `instagram_business_basic` scope,
 *   - uses the Instagram-product App ID/secret (NOT the Meta app ID) from
 *     INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET,
 *   - exchanges short-lived → long-lived (60-day) tokens exactly as before,
 *   - long-lived tokens are refreshed by a daily cron before they expire.
 *
 * OAuth callback design: Instagram redirects the owner's browser here with
 * no Authorization header, so the callback CANNOT sit behind JwtAuthGuard.
 * Instead the site id travels in an HMAC-signed, short-lived `state` token
 * minted when the signed-in owner requests the connect URL. One fixed
 * redirect URI (`/v1/instagram/callback`) is registered with Meta — exact
 * match is required, so per-site path segments are not an option.
 */

const STATE_TTL_MS = 15 * 60_000

function stateSecret(): string {
  return process.env.JWT_SECRET || 'archetype-dev-secret'
}

function signState(siteId: string): string {
  const exp = Date.now() + STATE_TTL_MS
  const payload = `${siteId}.${exp}`
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

/** Returns the site id, or null when the state is malformed, forged, or expired. */
function verifyState(state: string): string | null {
  const parts = state.split('.')
  if (parts.length !== 3) return null
  const [siteId, expStr, sig] = parts
  const expected = createHmac('sha256', stateSecret()).update(`${siteId}.${expStr}`).digest('hex')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  if (!Number.isFinite(Number(expStr)) || Date.now() > Number(expStr)) return null
  return siteId
}

function callbackUri(): string {
  return `${process.env.PUBLIC_BASE_URL}/v1/instagram/callback`
}

/** Where to send the owner's browser after the OAuth round-trip. */
function adminRedirect(site: Site, result: 'connected' | 'error', detail?: string): string | null {
  const base = site.customDomain ? `https://${site.customDomain}` : site.vercelProductionUrl
  if (!base) return null
  const qs = detail ? `?instagram=${result}&detail=${encodeURIComponent(detail)}` : `?instagram=${result}`
  return `${base.replace(/\/$/, '')}/admin/instagram${qs}`
}

@Injectable()
export class InstagramTokenService {
  private readonly logger = new Logger(InstagramTokenService.name)

  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
  ) {}

  /**
   * Long-lived tokens last 60 days and can be refreshed once they are at
   * least 24 hours old. Refresh anything expiring within 15 days so a few
   * failed nights never strand a site with a dead token.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshExpiring() {
    const em = this.em.fork()
    const soon = new Date(Date.now() + 15 * 24 * 3600_000)
    const sites = await em.getRepository(Site).find({
      instagramToken: { $ne: null },
      instagramTokenExpiresAt: { $lte: soon },
    })
    for (const site of sites) {
      try {
        const res = await fetch(
          `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${site.instagramToken}`,
        )
        if (!res.ok) {
          this.logger.warn(`Instagram token refresh failed for ${site.slug}: ${res.status} ${await res.text()}`)
          continue
        }
        const data = await res.json() as { access_token: string; expires_in: number }
        site.instagramToken = data.access_token
        site.instagramTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000)
        await em.persistAndFlush(site)
        this.logger.log(`Refreshed Instagram token for ${site.slug}`)
      } catch (e) {
        this.logger.warn(`Instagram token refresh errored for ${site.slug}: ${(e as Error).message}`)
      }
    }
  }
}

@ApiTags('instagram')
@Controller('v1/sites')
export class PublicInstagramController {
  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly sitesSvc: SitesService,
  ) {}

  @Get(':key/instagram')
  @Header('Cache-Control', 'public, max-age=900, s-maxage=900, stale-while-revalidate=3600')
  async list(@Param('key') key: string) {
    const site = await this.sitesSvc.findByIdOrSlug(key)
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

/** Public OAuth callback — authenticated by the signed `state`, not a session. */
@ApiTags('instagram')
@Controller('v1/instagram')
export class InstagramOAuthController {
  private readonly logger = new Logger(InstagramOAuthController.name)

  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
  ) {}

  @Get('callback')
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    const siteId = state ? verifyState(state) : null
    const site = siteId ? await this.sites.findOne({ id: siteId }) : null

    const fail = (msg: string) => {
      const to = site ? adminRedirect(site, 'error', msg) : null
      if (to) return res.redirect(to)
      res.status(400).send(`<html><body style="font-family:sans-serif"><h2>Instagram connection failed</h2><p>${msg}</p><p>You can close this tab and try again from your site's admin.</p></body></html>`)
    }

    if (!site) return fail('This connect link is invalid or has expired — please start again from your admin.')
    if (errorDescription) return fail(errorDescription)
    if (!code) return fail('Instagram did not return an authorization code.')

    const appId = process.env.INSTAGRAM_APP_ID, appSecret = process.env.INSTAGRAM_APP_SECRET
    if (!appId || !appSecret) return fail('Instagram is not configured on the server.')

    try {
      // Instagram appends `#_` to the redirect — strip anything after a hash.
      const cleanCode = code.replace(/#.*$/, '')

      const tokRes = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          grant_type: 'authorization_code',
          redirect_uri: callbackUri(),
          code: cleanCode,
        }),
      })
      if (!tokRes.ok) {
        this.logger.warn(`Instagram token exchange failed for ${site.slug}: ${await tokRes.text()}`)
        return fail('Instagram rejected the sign-in. Make sure you are using a professional (Business or Creator) account.')
      }
      const short = await tokRes.json() as { access_token: string }

      const longRes = await fetch(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${appSecret}&access_token=${short.access_token}`,
      )
      if (!longRes.ok) {
        this.logger.warn(`Instagram long-lived exchange failed for ${site.slug}: ${await longRes.text()}`)
        return fail('Could not finish connecting your account. Please try again.')
      }
      const long = await longRes.json() as { access_token: string; expires_in: number }

      site.instagramToken = long.access_token
      site.instagramTokenExpiresAt = new Date(Date.now() + long.expires_in * 1000)
      await this.em.persistAndFlush(site)

      const to = adminRedirect(site, 'connected')
      if (to) return res.redirect(to)
      return res.send('<html><body style="font-family:sans-serif"><h2>Instagram connected 🎉</h2><p>Your latest posts will appear in your site gallery shortly. You can close this tab.</p></body></html>')
    } catch (e) {
      this.logger.warn(`Instagram callback errored for ${site.slug}: ${(e as Error).message}`)
      return fail('Something went wrong talking to Instagram. Please try again.')
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
  async connectUrl(@Param('id') id: string, @Req() req: AuthRequest) {
    const appId = process.env.INSTAGRAM_APP_ID
    if (!appId) throw new BadRequestException('Instagram not configured')
    const site = await this.sitesSvc.getOwned(id, req.owner)
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: callbackUri(),
      response_type: 'code',
      scope: 'instagram_business_basic',
      state: signState(site.id),
    })
    return { url: `https://www.instagram.com/oauth/authorize?${params.toString()}` }
  }

  @Get(':id/instagram/status')
  async status(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sitesSvc.getOwned(id, req.owner)
    return {
      connected: !!site.instagramToken,
      expiresAt: site.instagramTokenExpiresAt ?? null,
    }
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
