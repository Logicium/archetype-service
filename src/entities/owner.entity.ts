import { Entity, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'

export type PaymentProvider = 'stripe' | 'square'

@Entity()
export class Owner {
  [OptionalProps]?: 'createdAt' | 'name' | 'stripeChargesEnabled' | 'stripePayoutsEnabled' | 'stripeDetailsSubmitted'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @Property()
  @Unique()
  email!: string

  @Property({ nullable: true })
  name?: string

  /** Hash of the latest magic-link token (single-use). */
  @Property({ nullable: true })
  magicLinkHash?: string

  /** Expiry of the current magic-link token. */
  @Property({ nullable: true })
  magicLinkExpiresAt?: Date

  /** bcrypt hash; optional — owners can use magic links instead. */
  @Property({ nullable: true })
  passwordHash?: string

  @Property({ nullable: true })
  lastLoginAt?: Date

  // ── Payments: Stripe Connect ──
  // One connected account per owner routes payouts for EVERY site they own —
  // destination charges on any of their sites' orders settle here.
  @Property({ nullable: true })
  stripeAccountId?: string

  /** Cached from Stripe on each status refresh — cheaper than round-tripping. */
  @Property({ default: false })
  stripeChargesEnabled: boolean = false

  @Property({ default: false })
  stripePayoutsEnabled: boolean = false

  @Property({ default: false })
  stripeDetailsSubmitted: boolean = false

  // ── Payments: Square (OAuth on the owner's own Square account) ──
  // Which provider storefront checkouts run through when both are connected.
  // Unset means "whichever is connected, Stripe first" (see PaymentsService).
  @Property({ length: 16, nullable: true })
  paymentProvider?: PaymentProvider

  @Property({ nullable: true })
  squareMerchantId?: string

  @Property({ nullable: true })
  squareMerchantName?: string

  /** Payment links are created at a location; the first active one on connect. */
  @Property({ nullable: true })
  squareLocationId?: string

  /** 30-day OAuth access token; refreshed lazily and by the nightly sweep. */
  @Property({ type: 'text', nullable: true })
  squareAccessToken?: string

  @Property({ type: 'text', nullable: true })
  squareRefreshToken?: string

  @Property({ nullable: true })
  squareAccessTokenExpiresAt?: Date

  @Property({ nullable: true })
  squareConnectedAt?: Date

  // ── Payments: Plaid bank link (optional; funds a Connect external account) ──
  @Property({ nullable: true })
  plaidItemId?: string

  /** Display-only bank identity for the admin UI (never store account numbers). */
  @Property({ nullable: true })
  bankName?: string

  @Property({ nullable: true })
  bankMask?: string

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()
}
