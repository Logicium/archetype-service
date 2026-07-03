import { Entity, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'

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

  // ── Payments: Stripe Connect (Express) ──
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
