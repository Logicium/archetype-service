import { Logger } from '@nestjs/common'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'

/**
 * Square as a payments provider, the owner-level sibling of Stripe Connect.
 *
 * Square has no "connected account" concept: the owner already runs a Square
 * account, authorises our app through OAuth, and we create hosted Checkout
 * payment links on THEIR account with their access token. Money settles into
 * their Square balance and bank directly; refunds, disputes and payouts stay
 * in their Square dashboard. The order the link creates shows up in Square
 * Orders beside their in-store sales.
 *
 * OAuth issues a 30-day access token plus a refresh token that does not
 * expire; PaymentsService refreshes lazily before use and proactively on a
 * nightly sweep so a checkout never meets a dead token.
 *
 *   SQUARE_APP_ID, SQUARE_APP_SECRET, SQUARE_ENV=sandbox|production
 *   SQUARE_WEBHOOK_SIGNATURE_KEY  (webhook subscription -> signature key)
 *   SQUARE_WEBHOOK_URL            (optional; defaults to PUBLIC_BASE_URL + /v1/webhooks/square)
 *
 * Shares the developer account with the other Apotome services; this service
 * only needs its own redirect URL and webhook subscription on that app.
 */
const SQUARE_VERSION = '2025-01-23'
export const SQUARE_SCOPES = ['MERCHANT_PROFILE_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENTS_READ', 'PAYMENTS_WRITE']

export interface SquareTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  merchantId?: string
}

export interface SquareLineItem {
  name: string
  quantity: number
  unitCents: number
  note?: string
}

export interface SquarePaymentLink {
  paymentLinkId: string
  orderId: string
  url: string
}

/** Square rejected our credentials: the owner has to reconnect. */
export class SquareAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SquareAuthError'
  }
}

export class SquareConnect {
  private readonly logger = new Logger(SquareConnect.name)

  get base(): string {
    return (process.env.SQUARE_ENV || 'production').toLowerCase() === 'sandbox'
      ? 'https://connect.squareupsandbox.com'
      : 'https://connect.squareup.com'
  }

  isConfigured(): boolean {
    return !!(process.env.SQUARE_APP_ID && process.env.SQUARE_APP_SECRET)
  }

  /** Where Square expects to deliver webhooks; must match the subscription exactly. */
  notificationUrl(): string {
    return process.env.SQUARE_WEBHOOK_URL || `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/v1/webhooks/square`
  }

  // ── OAuth ─────────────────────────────────────────────────────────────

  authorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: process.env.SQUARE_APP_ID ?? '',
      scope: SQUARE_SCOPES.join(' '),
      session: 'false',
      state,
      redirect_uri: redirectUri,
    })
    return `${this.base}/oauth2/authorize?${params.toString()}`
  }

  exchangeCode(code: string, redirectUri: string): Promise<SquareTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  }

  refresh(refreshToken: string): Promise<SquareTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  /** Best-effort: tells Square the owner disconnected so the token dies now. */
  async revoke(accessToken: string): Promise<void> {
    try {
      await fetch(`${this.base}/oauth2/revoke`, {
        method: 'POST',
        headers: {
          Authorization: `Client ${process.env.SQUARE_APP_SECRET}`,
          'Content-Type': 'application/json',
          'Square-Version': SQUARE_VERSION,
        },
        body: JSON.stringify({ client_id: process.env.SQUARE_APP_ID, access_token: accessToken }),
      })
    } catch (e) {
      this.logger.warn(`Square revoke failed: ${(e as Error).message}`)
    }
  }

  private async token(body: Record<string, string>): Promise<SquareTokens> {
    const res = await fetch(`${this.base}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Square-Version': SQUARE_VERSION },
      body: JSON.stringify({ client_id: process.env.SQUARE_APP_ID, client_secret: process.env.SQUARE_APP_SECRET, ...body }),
    })
    const text = await res.text()
    if (!res.ok) throw new SquareAuthError(`Square refused the token request (${res.status}): ${text.slice(0, 300)}`)
    let j: Record<string, unknown>
    try {
      j = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new SquareAuthError(`Square returned a non-JSON token response: ${text.slice(0, 200)}`)
    }
    const accessToken = j.access_token as string | undefined
    if (!accessToken) throw new SquareAuthError(`Square token response had no access_token: ${text.slice(0, 200)}`)
    const expires = typeof j.expires_at === 'string' ? new Date(j.expires_at) : undefined
    return {
      accessToken,
      refreshToken: (j.refresh_token as string | undefined) ?? undefined,
      expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : undefined,
      merchantId: (j.merchant_id as string | undefined) ?? undefined,
    }
  }

  // ── Merchant ──────────────────────────────────────────────────────────

  private headers(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Square-Version': SQUARE_VERSION,
    }
  }

  /** Business name + first active location (payment links need a location). */
  async describeMerchant(accessToken: string): Promise<{ name?: string; merchantId?: string; locationId?: string; currency?: string }> {
    const out: { name?: string; merchantId?: string; locationId?: string; currency?: string } = {}
    try {
      const m = await fetch(`${this.base}/v2/merchants/me`, { headers: this.headers(accessToken) })
      if (m.ok) {
        const j = (await m.json()) as { merchant?: { id?: string; business_name?: string; currency?: string } }
        out.name = j.merchant?.business_name
        out.merchantId = j.merchant?.id
        out.currency = j.merchant?.currency
      }
      const l = await fetch(`${this.base}/v2/locations`, { headers: this.headers(accessToken) })
      if (l.ok) {
        const j = (await l.json()) as { locations?: { id: string; status?: string; name?: string }[] }
        const active = (j.locations ?? []).find(x => x.status === 'ACTIVE') ?? j.locations?.[0]
        out.locationId = active?.id
        if (!out.name && active?.name) out.name = active.name
      }
    } catch (e) {
      this.logger.warn(`Square merchant lookup errored: ${(e as Error).message}`)
    }
    return out
  }

  // ── Checkout ──────────────────────────────────────────────────────────

  /**
   * Hosted checkout page for one order. Square creates a real Order on the
   * merchant's account (visible in Square Orders) and a payment link to it;
   * after payment the buyer is sent to `redirectUrl`. There is no cancel URL:
   * the buyer simply navigates back.
   */
  async createPaymentLink(args: {
    accessToken: string
    locationId: string
    currency: string
    items: SquareLineItem[]
    redirectUrl: string
    referenceId: string
    sourceName: string
    buyerEmail?: string
    note?: string
  }): Promise<SquarePaymentLink> {
    const currency = args.currency.toUpperCase()
    const res = await fetch(`${this.base}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: this.headers(args.accessToken),
      body: JSON.stringify({
        idempotency_key: `apotome-${args.referenceId}-${randomUUID().slice(0, 8)}`,
        order: {
          location_id: args.locationId,
          reference_id: args.referenceId.slice(0, 40),
          source: { name: args.sourceName.slice(0, 255) },
          line_items: args.items.map(i => ({
            name: i.name.slice(0, 512),
            quantity: String(Math.max(1, Math.round(i.quantity))),
            base_price_money: { amount: i.unitCents, currency },
            ...(i.note ? { note: i.note.slice(0, 2000) } : {}),
          })),
        },
        checkout_options: { redirect_url: args.redirectUrl.slice(0, 2048) },
        ...(args.buyerEmail ? { pre_populated_data: { buyer_email: args.buyerEmail } } : {}),
        ...(args.note ? { payment_note: args.note.slice(0, 500) } : {}),
      }),
    })
    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new SquareAuthError(`Square rejected the checkout (${res.status}): ${text.slice(0, 300)}. Reconnect Square from Payments.`)
    }
    if (!res.ok) throw new Error(`Square payment link failed (${res.status}): ${text.slice(0, 300)}`)
    const j = JSON.parse(text) as { payment_link?: { id?: string; url?: string; order_id?: string } }
    const link = j.payment_link
    if (!link?.id || !link.url || !link.order_id) throw new Error('Square created the payment link but returned no url/order.')
    return { paymentLinkId: link.id, orderId: link.order_id, url: link.url }
  }

  /**
   * Has the order behind a payment link been paid? Square settles the link
   * as a tender on the order and drives the amount due to zero; the order
   * state itself only reaches COMPLETED once fulfilments close, so it is not
   * the signal to wait on.
   */
  async orderPaid(accessToken: string, orderId: string): Promise<{ paid: boolean; paymentId?: string }> {
    const res = await fetch(`${this.base}/v2/orders/${encodeURIComponent(orderId)}`, { headers: this.headers(accessToken) })
    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new SquareAuthError(`Square rejected the order lookup (${res.status}): ${text.slice(0, 300)}`)
    }
    if (!res.ok) throw new Error(`Square order lookup failed (${res.status}): ${text.slice(0, 300)}`)
    const j = JSON.parse(text) as {
      order?: {
        state?: string
        tenders?: Array<{ id?: string; payment_id?: string; amount_money?: { amount?: number } }>
        total_money?: { amount?: number }
        net_amount_due_money?: { amount?: number }
      }
    }
    const order = j.order
    if (!order) return { paid: false }
    const tenders = order.tenders ?? []
    if (!tenders.length) return { paid: false }
    const due = order.net_amount_due_money?.amount
    const tendered = tenders.reduce((s, t) => s + (t.amount_money?.amount ?? 0), 0)
    const total = order.total_money?.amount ?? 0
    const paid = due !== undefined ? due <= 0 : tendered >= total
    return { paid, paymentId: tenders[0]?.payment_id ?? tenders[0]?.id }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────

  /**
   * Square signs `notificationUrl + rawBody` with the subscription's
   * signature key (HMAC-SHA256, base64) in `x-square-hmacsha256-signature`.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY
    if (!key || !signature) return false
    const expected = createHmac('sha256', key).update(this.notificationUrl() + rawBody.toString('utf8')).digest('base64')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}
