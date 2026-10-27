import { BadRequestException, Body, Controller, Get, Headers, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import type { Response } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityRepository } from '@mikro-orm/postgresql'
import { Owner, PaymentProvider } from '../entities/owner.entity'
import { PaymentsService } from './payments.service'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

function originFrom(header: string | undefined): string {
  if (header) {
    try {
      const u = new URL(header)
      if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}`
    } catch { /* fall through */ }
  }
  return process.env.PUBLIC_APP_URL || 'http://localhost:5173'
}

class ExchangeBody {
  @IsString() @MaxLength(500) publicToken!: string
  @IsString() @MaxLength(200) accountId!: string
}

class OnboardBody {
  @IsOptional() @IsString() @MaxLength(500) returnTo?: string
}

class ProviderBody {
  @IsIn(['stripe', 'square']) provider!: PaymentProvider
}

/*
 * Square's OAuth redirect lands on the API with no Authorization header, so
 * the callback cannot sit behind JwtAuthGuard. The owner id and the admin
 * origin to send the browser back to travel in an HMAC-signed, short-lived
 * `state` minted when the signed-in owner asks for the connect URL (the same
 * trick the POS and Instagram flows use).
 */
const STATE_TTL_MS = 15 * 60_000

function stateSecret(): string {
  return process.env.JWT_SECRET || 'archetype-dev-secret'
}

function signSquareState(ownerId: string, returnTo: string): string {
  const exp = Date.now() + STATE_TTL_MS
  const payload = `${ownerId}.${Buffer.from(returnTo, 'utf8').toString('base64url')}.${exp}`
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifySquareState(state: string): { ownerId: string; returnTo: string } | null {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [ownerId, rt, expStr, sig] = parts
  const expected = createHmac('sha256', stateSecret()).update(`${ownerId}.${rt}.${expStr}`).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (!Number.isFinite(Number(expStr)) || Date.now() > Number(expStr)) return null
  const returnTo = Buffer.from(rt, 'base64url').toString('utf8')
  // Only ever bounce back to a bare origin we minted ourselves.
  if (!/^https?:\/\/[^/?#]+$/.test(returnTo)) return null
  return { ownerId, returnTo }
}

function squareCallbackUri(): string {
  return `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/v1/payments/square/callback`
}

/**
 * Owner-level payments admin. Not scoped to a single site — a payment
 * account (Stripe or Square) belongs to the owner and applies across all
 * their sites.
 */
@ApiTags('admin:payments')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('status')
  status(@Req() req: AuthRequest) {
    return this.payments.getStatus(req.owner)
  }

  @Post('connect')
  connect(@Req() req: AuthRequest, @Headers('origin') origin: string | undefined, @Body() body: OnboardBody) {
    return this.payments.createOnboardingLink(req.owner, body.returnTo || originFrom(origin))
  }

  /** Which connected provider storefront checkouts run through. */
  @Post('provider')
  async setProvider(@Req() req: AuthRequest, @Body() body: ProviderBody) {
    await this.payments.setProvider(req.owner, body.provider)
    return this.payments.getStatus(req.owner)
  }

  /** Square OAuth: the Square URL to send the owner's browser to. */
  @Post('square/connect')
  squareConnect(@Req() req: AuthRequest, @Headers('origin') origin: string | undefined, @Body() body: OnboardBody) {
    const returnTo = originFrom(body.returnTo || origin)
    return { url: this.payments.squareAuthorizeUrl(signSquareState(req.owner.id, returnTo), squareCallbackUri()) }
  }

  @Post('square/disconnect')
  async squareDisconnect(@Req() req: AuthRequest) {
    await this.payments.disconnectSquare(req.owner)
    return this.payments.getStatus(req.owner)
  }

  @Post('plaid/link-token')
  linkToken(@Req() req: AuthRequest) {
    return this.payments.createPlaidLinkToken(req.owner)
  }

  @Post('plaid/exchange')
  exchange(@Req() req: AuthRequest, @Body() body: ExchangeBody) {
    return this.payments.exchangePlaidPublicToken(req.owner, body.publicToken, body.accountId)
  }
}

/** Square's OAuth redirect target. Unauthenticated by necessity; see the state notes above. */
@ApiTags('payments')
@Controller('v1/payments')
export class SquareOAuthController {
  private readonly logger = new Logger(SquareOAuthController.name)

  constructor(
    private readonly payments: PaymentsService,
    @InjectRepository(Owner) private readonly owners: EntityRepository<Owner>,
  ) {}

  @Get('square/callback')
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    const parsed = state ? verifySquareState(state) : null
    const back = (result: 'connected' | 'error', detail?: string) => {
      if (!parsed) {
        return res
          .status(400)
          .send('<html><body style="font-family:sans-serif"><h2>Square connection failed</h2><p>This connect link is invalid or has expired. Please start again from Payments in your dashboard.</p></body></html>')
      }
      const qs = detail ? `?square=${result}&detail=${encodeURIComponent(detail)}` : `?square=${result}`
      return res.redirect(`${parsed.returnTo}/admin/payments${qs}`)
    }

    if (!parsed) return back('error')
    if (error || errorDescription) return back('error', errorDescription || error)
    if (!code) return back('error', 'Square did not return an authorization code.')

    const owner = await this.owners.findOne({ id: parsed.ownerId })
    if (!owner) return back('error', 'Account not found.')

    try {
      await this.payments.completeSquareConnection(owner, code, squareCallbackUri())
      return back('connected')
    } catch (e) {
      const msg = (e as Error).message
      this.logger.warn(`Square callback failed for ${owner.email}: ${msg}`)
      return back('error', e instanceof BadRequestException ? msg : 'Something went wrong finishing the connection. Please try again.')
    }
  }
}
