import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid'
import { Owner, PaymentProvider } from '../entities/owner.entity'
import { ShopOrder } from '../entities/shop-order.entity'
import { MealOrder } from '../entities/meal-order.entity'
import { SquareAuthError, SquareConnect, type SquareLineItem } from './square.connect'

/** Refresh a Square token this far ahead of expiry so a checkout never races the clock. */
const SQUARE_REFRESH_SKEW_MS = 5 * 60_000
/** The nightly sweep renews anything expiring within this window. */
const SQUARE_PROACTIVE_REFRESH_MS = 7 * 24 * 3600_000

/** What a storefront gets back from createDestinationCheckout, for either provider. */
export interface CheckoutResult {
  provider: PaymentProvider
  url: string | null
  /** Stripe Checkout session id (provider = stripe). */
  stripeSessionId?: string
  /** Square order id behind the payment link (provider = square). */
  squareOrderId?: string
}

export interface CheckoutParams {
  owner: Owner
  /** Stripe's line-item shape is the lingua franca; Square items are mapped from it. */
  lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  metadata?: Record<string, string>
  /** Optional platform fee in the smallest currency unit (Stripe only for now). */
  applicationFeeCents?: number
  /** Session expiry as a unix timestamp (seconds). Stripe allows 30 min to 24 h from now. Square links do not expire. */
  expiresAt?: number
  /** Shown to the merchant as the order's source in Square. */
  sourceName?: string
}

/**
 * Owner-scoped payments. Two providers, one per owner at a time:
 *
 * - Stripe Connect: a Standard-type connected account per owner; storefront
 *   checkouts are destination charges to `owner.stripeAccountId`.
 * - Square: the owner authorises our app on their own Square account through
 *   OAuth; checkouts are hosted payment links created with their token.
 *
 * Either way the account is the OWNER's, not the site's, which is the crux of
 * "maps to every owned website": a new site inherits payments the moment it
 * is provisioned, with no per-site setup. Plaid bank linking remains for a
 * platform-managed Stripe configuration but is dormant under Stripe-managed
 * risk (Stripe collects the payout bank during onboarding instead).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name)
  private readonly stripe: Stripe | null
  private readonly plaid: PlaidApi | null
  private readonly square = new SquareConnect()

  constructor(
    @InjectRepository(Owner) private readonly owners: EntityRepository<Owner>,
    private readonly em: EntityManager,
  ) {
    // Vendor money runs on its own Stripe platform account when
    // STRIPE_CONNECT_SECRET_KEY is set: Connect onboarding, bank attach, and
    // every storefront checkout (destination charges) use this key, while the
    // platform's own service billing (OrdersService) stays on
    // STRIPE_SECRET_KEY. Leave it unset to run both on one account.
    const key = process.env.STRIPE_CONNECT_SECRET_KEY || process.env.STRIPE_SECRET_KEY
    this.stripe = key ? new Stripe(key, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion }) : null
    if (!key) this.logger.warn('STRIPE_CONNECT_SECRET_KEY / STRIPE_SECRET_KEY not set — Connect onboarding disabled.')

    const plaidClientId = process.env.PLAID_CLIENT_ID
    const plaidSecret = process.env.PLAID_SECRET
    if (plaidClientId && plaidSecret) {
      const envName = (process.env.PLAID_ENV || 'sandbox') as keyof typeof PlaidEnvironments
      this.plaid = new PlaidApi(new Configuration({
        basePath: PlaidEnvironments[envName] ?? PlaidEnvironments.sandbox,
        baseOptions: { headers: { 'PLAID-CLIENT-ID': plaidClientId, 'PLAID-SECRET': plaidSecret } },
      }))
    } else {
      this.plaid = null
      this.logger.warn('PLAID_CLIENT_ID/SECRET not set — bank linking disabled.')
    }
  }

  get stripeEnabled(): boolean { return !!this.stripe }
  get plaidEnabled(): boolean { return !!this.plaid }
  get squareEnabled(): boolean { return this.square.isConfigured() }

  /** The Stripe client, for callers that build their own Checkout sessions. */
  get stripeClient(): Stripe | null { return this.stripe }

  // ── Provider selection ───────────────────────────────────────────────

  /** Which provider this owner's storefront checkouts run through. */
  providerFor(owner: Owner): PaymentProvider {
    if (owner.paymentProvider === 'square' && owner.squareAccessToken) return 'square'
    if (owner.paymentProvider === 'stripe' && owner.stripeAccountId) return 'stripe'
    // No usable explicit choice: whichever is connected, Stripe first.
    if (owner.stripeAccountId) return 'stripe'
    if (owner.squareAccessToken) return 'square'
    return 'stripe'
  }

  async setProvider(owner: Owner, provider: PaymentProvider): Promise<Owner> {
    if (provider === 'square' && !owner.squareAccessToken) throw new BadRequestException('Connect Square first.')
    if (provider === 'stripe' && !owner.stripeAccountId) throw new BadRequestException('Connect Stripe first.')
    owner.paymentProvider = provider
    await this.em.persistAndFlush(owner)
    return owner
  }

  /** Can a checkout be created for this owner right now? */
  canCollect(owner: Owner): boolean {
    return this.providerFor(owner) === 'square'
      ? !!owner.squareAccessToken && !!owner.squareLocationId && !this.squareNeedsReconnect(owner)
      : !!this.stripe && !!owner.stripeAccountId && owner.stripeChargesEnabled
  }

  // ── Stripe Connect ──────────────────────────────────────────

  /** Idempotently ensures the owner has a Connect account; returns its id. */
  async ensureConnectAccount(owner: Owner): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Payments not configured')
    if (owner.stripeAccountId) return owner.stripeAccountId
    const account = await this.stripe.accounts.create({
      // The platform's Connect profile is set to Stripe-managed risk, so
      // Stripe must be the losses collector. Stripe only pairs that with the
      // full dashboard (the Express dashboard requires the platform to carry
      // losses), which makes this the Standard configuration: the owner gets
      // their own Stripe dashboard at dashboard.stripe.com, Stripe collects
      // their KYC and payout bank during hosted onboarding, and destination
      // charges below still settle to them with our application fee taken.
      controller: {
        losses: { payments: 'stripe' },
        fees: { payer: 'account' },
        requirement_collection: 'stripe',
        stripe_dashboard: { type: 'full' },
      },
      email: owner.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: { name: owner.name || owner.email },
      metadata: { ownerId: owner.id },
    })
    owner.stripeAccountId = account.id
    await this.em.persistAndFlush(owner)
    return account.id
  }

  /** Hosted onboarding link the owner completes to enable charges/payouts. */
  async createOnboardingLink(owner: Owner, origin: string): Promise<{ url: string }> {
    if (!this.stripe) throw new BadRequestException('Payments not configured')
    const accountId = await this.ensureConnectAccount(owner)
    const base = origin.replace(/\/$/, '')
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      // Stripe bounces back here if the link expires before completion…
      refresh_url: `${base}/admin/payments?stripe=refresh`,
      // …and here on success. The admin view then refreshes live status.
      return_url: `${base}/admin/payments?stripe=return`,
      type: 'account_onboarding',
    })
    return { url: link.url }
  }

  /** Pulls live capabilities from Stripe and caches them on the owner. */
  async refreshConnectStatus(owner: Owner): Promise<Owner> {
    if (!this.stripe || !owner.stripeAccountId) return owner
    const account = await this.stripe.accounts.retrieve(owner.stripeAccountId)
    owner.stripeChargesEnabled = !!account.charges_enabled
    owner.stripePayoutsEnabled = !!account.payouts_enabled
    owner.stripeDetailsSubmitted = !!account.details_submitted
    await this.em.persistAndFlush(owner)
    return owner
  }

  /** A resolved, UI-friendly snapshot of the owner's payment readiness. */
  async getStatus(owner: Owner) {
    if (this.stripe && owner.stripeAccountId) {
      await this.refreshConnectStatus(owner).catch(e =>
        this.logger.warn(`Connect status refresh failed for ${owner.email}: ${(e as Error).message}`))
    }
    return {
      provider: this.providerFor(owner),
      canCollect: this.canCollect(owner),
      stripeConfigured: !!this.stripe,
      squareConfigured: this.square.isConfigured(),
      plaidConfigured: !!this.plaid,
      connected: !!owner.stripeAccountId,
      chargesEnabled: owner.stripeChargesEnabled,
      payoutsEnabled: owner.stripePayoutsEnabled,
      detailsSubmitted: owner.stripeDetailsSubmitted,
      bank: owner.bankName ? { name: owner.bankName, mask: owner.bankMask ?? null } : null,
      square: {
        connected: !!owner.squareAccessToken,
        merchantName: owner.squareMerchantName ?? null,
        merchantId: owner.squareMerchantId ?? null,
        locationId: owner.squareLocationId ?? null,
        expiresAt: owner.squareAccessTokenExpiresAt ?? null,
        needsReconnect: this.squareNeedsReconnect(owner),
      },
    }
  }

  /**
   * Build a hosted checkout for an order on whichever provider the owner
   * uses: a Stripe Checkout Session with a destination charge to their
   * connected account, or a Square payment link on their own Square account.
   * Returns null when the owner can't yet accept payments, so callers cleanly
   * fall back to their no-payment (sandbox/demo) path.
   */
  async createDestinationCheckout(params: CheckoutParams): Promise<CheckoutResult | null> {
    if (this.providerFor(params.owner) === 'square') return this.createSquareCheckout(params)
    if (!this.stripe) return null
    if (!params.owner.stripeAccountId || !params.owner.stripeChargesEnabled) return null

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: params.lineItems,
      customer_email: params.customerEmail,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
      ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
      payment_intent_data: {
        transfer_data: { destination: params.owner.stripeAccountId },
        ...(params.applicationFeeCents && params.applicationFeeCents > 0
          ? { application_fee_amount: params.applicationFeeCents }
          : {}),
      },
    })
    return { provider: 'stripe', stripeSessionId: session.id, url: session.url }
  }

  private async createSquareCheckout(params: CheckoutParams): Promise<CheckoutResult | null> {
    const owner = params.owner
    if (!owner.squareAccessToken || !owner.squareLocationId) return null
    const accessToken = await this.freshSquareToken(owner)
    const items: SquareLineItem[] = []
    let currency = 'USD'
    for (const li of params.lineItems) {
      const pd = li.price_data
      if (!pd?.unit_amount || !li.quantity) continue
      currency = pd.currency
      items.push({
        name: pd.product_data?.name ?? 'Item',
        quantity: li.quantity,
        unitCents: pd.unit_amount,
        note: pd.product_data?.description ?? undefined,
      })
    }
    if (!items.length) return null
    const referenceId = params.metadata?.mealOrderId ?? params.metadata?.shopOrderId ?? randomUUID()
    const link = await this.square.createPaymentLink({
      accessToken,
      locationId: owner.squareLocationId,
      currency,
      items,
      redirectUrl: params.successUrl,
      referenceId,
      sourceName: params.sourceName ?? 'Online order',
      buyerEmail: params.customerEmail,
    })
    return { provider: 'square', squareOrderId: link.orderId, url: link.url }
  }

  /**
   * Has an order's hosted checkout been paid? One call for both providers so
   * the storefront services only persist the outcome. Safe to call repeatedly.
   */
  async checkPaid(
    owner: Owner,
    ref: { stripeSessionId?: string; squareOrderId?: string },
  ): Promise<{ paid: boolean; provider: PaymentProvider; paymentRef?: string }> {
    if (ref.squareOrderId) {
      if (!owner.squareAccessToken) return { paid: false, provider: 'square' }
      const accessToken = await this.freshSquareToken(owner)
      const r = await this.square.orderPaid(accessToken, ref.squareOrderId)
      return { paid: r.paid, provider: 'square', paymentRef: r.paymentId }
    }
    if (ref.stripeSessionId && this.stripe) {
      const session = await this.stripe.checkout.sessions.retrieve(ref.stripeSessionId)
      return {
        paid: session.payment_status === 'paid',
        provider: 'stripe',
        paymentRef: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
      }
    }
    return { paid: false, provider: this.providerFor(owner) }
  }

  // ── Square ────────────────────────────────────────────────────────────

  squareAuthorizeUrl(state: string, redirectUri: string): string {
    if (!this.square.isConfigured()) throw new BadRequestException('Square is not configured on the server yet.')
    return this.square.authorizeUrl(state, redirectUri)
  }

  /** Finishes the OAuth round-trip: exchange the code, learn the merchant, persist. */
  async completeSquareConnection(owner: Owner, code: string, redirectUri: string): Promise<Owner> {
    const tokens = await this.square.exchangeCode(code, redirectUri)
    const merchant = await this.square.describeMerchant(tokens.accessToken)
    if (!merchant.locationId) {
      throw new BadRequestException('Your Square account has no active location to take payments at.')
    }
    owner.squareAccessToken = tokens.accessToken
    owner.squareRefreshToken = tokens.refreshToken
    owner.squareAccessTokenExpiresAt = tokens.expiresAt
    owner.squareMerchantId = merchant.merchantId ?? tokens.merchantId
    owner.squareMerchantName = merchant.name
    owner.squareLocationId = merchant.locationId
    owner.squareConnectedAt = new Date()
    // The first provider connected becomes the active one; an owner with
    // Stripe already live keeps Stripe until they switch in Payments.
    if (!owner.paymentProvider) owner.paymentProvider = owner.stripeAccountId ? 'stripe' : 'square'
    await this.em.persistAndFlush(owner)
    this.logger.log(`Square connected for ${owner.email} (merchant ${owner.squareMerchantId ?? '?'}, location ${owner.squareLocationId})`)
    return owner
  }

  async disconnectSquare(owner: Owner): Promise<Owner> {
    if (owner.squareAccessToken) await this.square.revoke(owner.squareAccessToken)
    this.clearSquare(owner)
    await this.em.persistAndFlush(owner)
    return owner
  }

  private clearSquare(owner: Owner) {
    owner.squareAccessToken = undefined
    owner.squareRefreshToken = undefined
    owner.squareAccessTokenExpiresAt = undefined
    owner.squareMerchantId = undefined
    owner.squareMerchantName = undefined
    owner.squareLocationId = undefined
    owner.squareConnectedAt = undefined
    if (owner.paymentProvider === 'square') owner.paymentProvider = owner.stripeAccountId ? 'stripe' : undefined
  }

  /** `oauth.authorization.revoked`: the merchant pulled our access from their side. */
  async squareAccessRevoked(merchantId: string): Promise<void> {
    const owner = await this.owners.findOne({ squareMerchantId: merchantId })
    if (!owner) return
    this.clearSquare(owner)
    await this.em.persistAndFlush(owner)
    this.logger.warn(`Square access revoked by merchant ${merchantId} (${owner.email})`)
  }

  /** True when the access token is dead and there is nothing left to refresh it with. */
  squareNeedsReconnect(owner: Owner): boolean {
    if (!owner.squareAccessToken) return false
    const exp = owner.squareAccessTokenExpiresAt?.getTime()
    return !!exp && exp < Date.now() && !owner.squareRefreshToken
  }

  /** Usable access token, refreshing first when it is (about to be) expired. */
  private async freshSquareToken(owner: Owner): Promise<string> {
    if (!owner.squareAccessToken) throw new SquareAuthError('Square is not connected.')
    const exp = owner.squareAccessTokenExpiresAt?.getTime()
    if (!exp || exp - SQUARE_REFRESH_SKEW_MS > Date.now()) return owner.squareAccessToken
    if (!owner.squareRefreshToken) {
      throw new SquareAuthError('The Square connection has expired. Reconnect Square from Payments.')
    }
    await this.renewSquareToken(owner)
    await this.em.persistAndFlush(owner)
    return owner.squareAccessToken
  }

  /** Swaps the refresh token for a new access token on the entity (caller flushes). */
  private async renewSquareToken(owner: Owner): Promise<void> {
    try {
      const t = await this.square.refresh(owner.squareRefreshToken as string)
      owner.squareAccessToken = t.accessToken
      if (t.refreshToken) owner.squareRefreshToken = t.refreshToken
      owner.squareAccessTokenExpiresAt = t.expiresAt
      this.logger.log(`Refreshed Square token for ${owner.email}`)
    } catch (e) {
      // A refused refresh means the grant itself is dead: drop the refresh
      // token so the dashboard says "reconnect" instead of retrying forever.
      if (e instanceof SquareAuthError) owner.squareRefreshToken = undefined
      throw e
    }
  }

  /**
   * Nightly sweep: renew every Square token that expires within the next
   * week, so a 30-day token never dies between an owner's checkouts.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshExpiringSquareTokens(): Promise<{ checked: number; refreshed: number }> {
    if (!this.square.isConfigured()) return { checked: 0, refreshed: 0 }
    const em = this.em.fork()
    const soon = new Date(Date.now() + SQUARE_PROACTIVE_REFRESH_MS)
    const owners = await em.find(Owner, {
      squareRefreshToken: { $ne: null },
      $or: [{ squareAccessTokenExpiresAt: null }, { squareAccessTokenExpiresAt: { $lt: soon } }],
    })
    let refreshed = 0
    for (const owner of owners) {
      try {
        await this.renewSquareToken(owner)
        refreshed++
      } catch (e) {
        this.logger.warn(`Square token refresh failed for ${owner.email}: ${(e as Error).message}`)
      }
    }
    await em.flush()
    if (owners.length) this.logger.log(`Square token sweep: ${refreshed}/${owners.length} refreshed`)
    return { checked: owners.length, refreshed }
  }

  /** Which of our orders a Square order belongs to, for the webhook. */
  async findOrderBySquareOrderId(squareOrderId: string): Promise<{ kind: 'shop' | 'meal'; id: string } | null> {
    const em = this.em.fork()
    const shop = await em.findOne(ShopOrder, { squareOrderId })
    if (shop) return { kind: 'shop', id: shop.id }
    const meal = await em.findOne(MealOrder, { squareOrderId })
    if (meal) return { kind: 'meal', id: meal.id }
    return null
  }

  verifySquareWebhook(rawBody: Buffer, signature?: string): boolean {
    return this.square.verifyWebhook(rawBody, signature)
  }

  // ── Connect webhooks ──────────────────────────────────────────────────

  /**
   * Verifies a webhook delivered to the Connect platform account. This is a
   * different Stripe account from the one OrdersService bills on, so it has
   * its own signing secret; when the two run on one account the ordinary
   * STRIPE_WEBHOOK_SECRET is accepted as well.
   */
  constructConnectEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.stripe) throw new BadRequestException('Payments not configured')
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
      || (!process.env.STRIPE_CONNECT_SECRET_KEY ? process.env.STRIPE_WEBHOOK_SECRET : undefined)
    if (!secret) throw new BadRequestException('STRIPE_CONNECT_WEBHOOK_SECRET not set')
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, secret)
    } catch (e) {
      throw new BadRequestException(`Webhook signature failed: ${(e as Error).message}`)
    }
  }

  /**
   * `account.updated` — cache the connected account's live capabilities so
   * checkout gating is right even if the owner never reopens the Payments
   * page after finishing onboarding.
   */
  async syncAccountFromWebhook(account: Stripe.Account): Promise<void> {
    const owner = await this.owners.findOne({ stripeAccountId: account.id })
    if (!owner) return
    owner.stripeChargesEnabled = !!account.charges_enabled
    owner.stripePayoutsEnabled = !!account.payouts_enabled
    owner.stripeDetailsSubmitted = !!account.details_submitted
    await this.em.persistAndFlush(owner)
    this.logger.log(`Connect account ${account.id} synced for ${owner.email}: charges=${owner.stripeChargesEnabled} payouts=${owner.stripePayoutsEnabled}`)
  }

  // ── Plaid bank linking ────────────────────────────────────────────────

  /** Short-lived token the browser hands to Plaid Link to open the widget. */
  async createPlaidLinkToken(owner: Owner): Promise<{ linkToken: string }> {
    if (!this.plaid) throw new BadRequestException('Bank linking not configured')
    const res = await this.plaid.linkTokenCreate({
      user: { client_user_id: owner.id },
      client_name: 'Apotome',
      products: [Products.Auth],
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    return { linkToken: res.data.link_token }
  }

  /**
   * Completes bank linking: exchanges Plaid's public token, mints a Stripe
   * bank-account processor token, and attaches it to the owner's Connect
   * account as an external (payout) account. Stores display-only bank
   * identity — never the account number.
   */
  async exchangePlaidPublicToken(owner: Owner, publicToken: string, plaidAccountId: string): Promise<{ ok: true; bank: { name: string; mask: string | null } }> {
    if (!this.plaid) throw new BadRequestException('Bank linking not configured')
    if (!this.stripe) throw new BadRequestException('Payments not configured')
    const accountId = await this.ensureConnectAccount(owner)

    const exchange = await this.plaid.itemPublicTokenExchange({ public_token: publicToken })
    const accessToken = exchange.data.access_token
    owner.plaidItemId = exchange.data.item_id

    // Resolve display identity (best-effort — non-fatal if it fails).
    let bankName = 'Bank account'
    let bankMask: string | null = null
    try {
      const accountsRes = await this.plaid.accountsGet({ access_token: accessToken })
      const acct = accountsRes.data.accounts.find(a => a.account_id === plaidAccountId) ?? accountsRes.data.accounts[0]
      if (acct) { bankName = acct.name || bankName; bankMask = acct.mask ?? null }
      const institutionId = accountsRes.data.item.institution_id
      if (institutionId) {
        const inst = await this.plaid.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        })
        if (inst.data.institution?.name) bankName = inst.data.institution.name
      }
    } catch (e) {
      this.logger.warn(`Plaid account/institution lookup failed: ${(e as Error).message}`)
    }

    // Mint a Stripe bank-account token and attach as the payout account.
    // Stripe only allows this where the platform collects requirements; our
    // accounts are Stripe-managed, so Stripe rejects it and the owner is sent
    // to their Stripe dashboard instead. Kept for a future platform-managed
    // configuration.
    const processor = await this.plaid.processorStripeBankAccountTokenCreate({
      access_token: accessToken,
      account_id: plaidAccountId,
    })
    await this.stripe.accounts.createExternalAccount(accountId, {
      external_account: processor.data.stripe_bank_account_token,
      default_for_currency: true,
    } as Stripe.ExternalAccountCreateParams)

    owner.bankName = bankName
    owner.bankMask = bankMask ?? undefined
    await this.em.persistAndFlush(owner)
    return { ok: true, bank: { name: bankName, mask: bankMask } }
  }
}
