import { BadRequestException, Body, Controller, Get, Logger, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityRepository } from '@mikro-orm/postgresql'
import { PosConfig, PosProvider, Site } from '../entities/site.entity'
import { AuthRequest, JwtAuthGuard } from '../auth/jwt.guard'
import { PosService } from './pos.service'

/**
 * POS OAuth, mirroring the Instagram flow: the vendor redirects the owner's
 * browser back with no Authorization header, so the callback cannot sit behind
 * JwtAuthGuard. The site id + provider instead travel in an HMAC-signed,
 * short-lived `state` minted when the signed-in owner asks for the connect URL.
 * One fixed redirect URI is registered with each vendor, so the provider has to
 * ride inside the state rather than the path.
 */

const STATE_TTL_MS = 15 * 60_000

function stateSecret(): string {
  return process.env.JWT_SECRET || 'archetype-dev-secret'
}

function signState(siteId: string, provider: PosProvider): string {
  const exp = Date.now() + STATE_TTL_MS
  const payload = `${siteId}.${provider}.${exp}`
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifyState(state: string): { siteId: string; provider: PosProvider } | null {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [siteId, provider, expStr, sig] = parts
  const expected = createHmac('sha256', stateSecret()).update(`${siteId}.${provider}.${expStr}`).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (!Number.isFinite(Number(expStr)) || Date.now() > Number(expStr)) return null
  return { siteId, provider: provider as PosProvider }
}

function callbackUri(): string {
  return `${process.env.PUBLIC_BASE_URL}/v1/pos/callback`
}

/** Where to send the owner's browser after the round-trip. */
function adminRedirect(site: Site, result: 'connected' | 'error', detail?: string): string | null {
  const base = site.customDomain ? `https://${site.customDomain}` : site.vercelProductionUrl
  if (!base) return null
  const qs = detail ? `?pos=${result}&detail=${encodeURIComponent(detail)}` : `?pos=${result}`
  return `${base.replace(/\/$/, '')}/admin/ordering${qs}`
}

@ApiTags('pos')
@Controller('v1/pos')
export class PosOAuthController {
  private readonly logger = new Logger(PosOAuthController.name)

  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly pos: PosService,
  ) {}

  @Get('callback')
  async callback(
    @Res() res: Response,
    @Query() query: Record<string, string>,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    const parsed = state ? verifyState(state) : null
    const site = parsed ? await this.sites.findOne({ id: parsed.siteId }) : null

    const fail = (msg: string) => {
      const to = site ? adminRedirect(site, 'error', msg) : null
      if (to) return res.redirect(to)
      return res
        .status(400)
        .send(`<html><body style="font-family:sans-serif"><h2>POS connection failed</h2><p>${msg}</p><p>You can close this tab and try again from your dashboard.</p></body></html>`)
    }

    // Clover can launch an installed app straight from the merchant's own
    // dashboard. That arrives here with `code` + `merchant_id` but no `state`,
    // so there is no way to know WHICH Apotome site is being connected — the
    // signed state is the only thing that carries it. Say so plainly rather
    // than showing a generic "invalid link".
    if (!state && code) {
      return fail(
        'Start the connection from your Apotome dashboard (Ordering → Kitchen printing → Connect Clover), ' +
        'not from the app page inside Clover. We need to know which of your sites to link this merchant to.',
      )
    }
    if (!site || !parsed) return fail('This connect link is invalid or has expired — please start again from your dashboard.')
    if (errorDescription) return fail(errorDescription)
    if (!code) return fail('Your POS did not return an authorization code.')

    try {
      const adapter = this.pos.adapterFor(parsed.provider)
      if (!adapter.isConfigured()) return fail(`${adapter.label} is not configured on the server.`)
      const tokens = await adapter.exchangeCode(code, callbackUri(), query)
      if (!tokens.merchantId) {
        return fail(`${adapter.label} did not identify which merchant to connect. Please try again.`)
      }
      await this.pos.completeConnection(site, parsed.provider, tokens)

      const to = adminRedirect(site, 'connected')
      if (to) return res.redirect(to)
      return res.send('<html><body style="font-family:sans-serif"><h2>POS connected</h2><p>Online orders will now print in your kitchen. You can close this tab.</p></body></html>')
    } catch (e) {
      const msg = (e as Error).message
      this.logger.warn(`POS callback failed for ${site.slug}: ${msg}`)
      return fail('Something went wrong finishing the connection. Please try again.')
    }
  }
}

@ApiTags('admin:pos')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AdminPosController {
  constructor(private readonly pos: PosService) {}

  @Get(':id/pos/status')
  async status(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.pos.getOwnedSite(id, req.owner)
    return this.pos.status(site)
  }

  /** Returns the vendor URL to send the owner to. */
  @Get(':id/pos/connect')
  async connect(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Query('provider') provider?: string,
  ) {
    const site = await this.pos.getOwnedSite(id, req.owner)
    const chosen = (provider || 'clover') as PosProvider
    const adapter = this.pos.adapterFor(chosen)
    if (!adapter.isConfigured()) {
      throw new BadRequestException(`${adapter.label} is not configured on the server yet.`)
    }
    return { url: adapter.authorizeUrl(signState(site.id, chosen), callbackUri()) }
  }

  @Post(':id/pos/disconnect')
  async disconnect(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.pos.getOwnedSite(id, req.owner)
    await this.pos.disconnect(site)
    return { ok: true }
  }

  @Put(':id/pos/config')
  async saveConfig(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Body() body: { config: PosConfig | null },
  ) {
    const site = await this.pos.getOwnedSite(id, req.owner)
    const resolved = await this.pos.saveConfig(site, body?.config ?? null)
    return { config: resolved }
  }

  /** Send (or re-send) one order to the POS. */
  @Post(':id/pos/orders/:orderId/send')
  async send(
    @Param('id') id: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthRequest,
  ) {
    return this.pos.resendOrder(id, req.owner, orderId)
  }
}
