import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import Stripe from 'stripe'
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid'
import { Owner } from '../entities/owner.entity'

/**
 * Owner-scoped payments: Stripe Connect (Express) for accepting money on any
 * site the owner runs, and Plaid for linking the payout bank account.
 *
 * A single Connect account per owner is the crux of "maps to every owned
 * website": commerce checkouts on ANY of the owner's sites are created as
 * destination charges to `owner.stripeAccountId`, so a new site inherits
 * payments the moment it's provisioned — no per-site setup.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name)
  private readonly stripe: Stripe | null
  private readonly plaid: PlaidApi | null

  constructor(
    @InjectRepository(Owner) private readonly owners: EntityRepository<Owner>,
    private readonly em: EntityManager,
  ) {
    const key = process.env.STRIPE_SECRET_KEY
    this.stripe = key ? new Stripe(key, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion }) : null
    if (!key) this.logger.warn('STRIPE_SECRET_KEY not set — Connect onboarding disabled.')

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

  /** The Stripe client, for callers that build their own Checkout sessions. */
  get stripeClient(): Stripe | null { return this.stripe }

  // ── Stripe Connect (Express) ──────────────────────────────────────────

  /** Idempotently ensures the owner has a Connect account; returns its id. */
  async ensureConnectAccount(owner: Owner): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Payments not configured')
    if (owner.stripeAccountId) return owner.stripeAccountId
    const account = await this.stripe.accounts.create({
      type: 'express',
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
      stripeConfigured: !!this.stripe,
      plaidConfigured: !!this.plaid,
      connected: !!owner.stripeAccountId,
      chargesEnabled: owner.stripeChargesEnabled,
      payoutsEnabled: owner.stripePayoutsEnabled,
      detailsSubmitted: owner.stripeDetailsSubmitted,
      bank: owner.bankName ? { name: owner.bankName, mask: owner.bankMask ?? null } : null,
    }
  }

  /**
   * Build a destination-charge Checkout Session that settles to the owner's
   * Connect account. Returns null when the owner can't yet accept charges, so
   * callers cleanly fall back to their no-payment (sandbox/demo) path.
   */
  async createDestinationCheckout(params: {
    owner: Owner
    lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]
    successUrl: string
    cancelUrl: string
    customerEmail?: string
    metadata?: Record<string, string>
    /** Optional platform fee in the smallest currency unit. */
    applicationFeeCents?: number
  }): Promise<{ sessionId: string; url: string | null } | null> {
    if (!this.stripe) return null
    if (!params.owner.stripeAccountId || !params.owner.stripeChargesEnabled) return null

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: params.lineItems,
      customer_email: params.customerEmail,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
      payment_intent_data: {
        transfer_data: { destination: params.owner.stripeAccountId },
        ...(params.applicationFeeCents && params.applicationFeeCents > 0
          ? { application_fee_amount: params.applicationFeeCents }
          : {}),
      },
    })
    return { sessionId: session.id, url: session.url }
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
