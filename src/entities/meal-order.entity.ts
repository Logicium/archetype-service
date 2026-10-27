import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type MealOrderStatus = 'pending' | 'confirmed' | 'ready' | 'completed' | 'cancelled'

/**
 * `unpaid`   — pay at pickup (owner not onboarded, or online payment turned off).
 * `awaiting` — a Stripe Checkout session exists; the customer has not paid yet.
 *              Holds its pickup slot for CHECKOUT_HOLD_MINUTES, then counts as abandoned.
 * `paid`     — Stripe confirmed payment; emails and the kitchen ticket go out on this flip.
 */
export type MealPaymentStatus = 'unpaid' | 'awaiting' | 'paid'

export interface MealOrderLine {
  menuItemId: string
  sku: string
  name: string
  unitPriceCents: number
  quantity: number
  lineTotalCents: number
  notes?: string
}

/**
 * A customer-placed pickup order against a Site's `MenuItem` catalog (Mesa Meal Ordering add-on).
 * Items are snapshotted at order time. `pickupAt` is a UTC slot start aligned to the site's
 * configured `ordering-config.slotMinutes` grid.
 */
@Entity()
export class MealOrder {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'currency' | 'paymentStatus'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property() name!: string
  @Property() email!: string
  @Property({ nullable: true }) phone?: string
  @Property({ type: 'text', nullable: true }) notes?: string

  @Property()
  @Index()
  pickupAt!: Date

  @Property({ type: 'json' })
  items: MealOrderLine[] = []

  @Property()
  subtotalCents!: number

  @Property()
  totalCents!: number

  @Property({ default: 'USD' })
  currency: string = 'USD'

  @Enum({ items: () => ['pending', 'confirmed', 'ready', 'completed', 'cancelled'] as MealOrderStatus[] })
  status: MealOrderStatus = 'pending'

  /* ── Online payment (Stripe Checkout, destination charge to the site owner) ── */

  @Property({ length: 16, default: 'unpaid' })
  paymentStatus: MealPaymentStatus = 'unpaid'

  @Property({ nullable: true })
  stripeSessionId?: string

  @Property({ nullable: true })
  stripePaymentIntentId?: string

  /** Square order behind the payment link, when the owner checks out through Square. */
  @Property({ nullable: true })
  squareOrderId?: string

  @Property({ nullable: true })
  squarePaymentId?: string

  /* ── POS sync (kitchen ticket) ──
     posOrderId is set once the order exists in the POS; posSyncError holds the
     last failure so the dashboard can show it and offer a resend. A failed push
     never blocks the customer's order — it is retried on demand. */

  @Property({ nullable: true })
  posOrderId?: string

  @Property({ nullable: true })
  posSyncedAt?: Date

  @Property({ type: 'text', nullable: true })
  posSyncError?: string

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
