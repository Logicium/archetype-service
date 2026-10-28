import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type ShopOrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled'
export type FulfillmentType = 'pickup' | 'shipping'

/**
 * Hands-on progress the owner advances from the dashboard. Shipping orders
 * walk received → label_printed → shipped → delivered; pickup orders walk
 * received → ready_for_pickup → picked_up. Each step emails the customer.
 */
export type FulfillmentStatus = 'received' | 'label_printed' | 'shipped' | 'delivered' | 'ready_for_pickup' | 'picked_up'

export interface FulfillmentEvent {
  status: FulfillmentStatus
  /** ISO timestamp. */
  at: string
  /** Owner's note to the customer for this step, if any. */
  note?: string
}

export interface ShopOrderItem {
  productId: string
  sku: string
  name: string
  unitPriceCents: number
  quantity: number
  lineTotalCents: number
}

export interface ShippingAddress {
  line1: string
  line2?: string
  city: string
  region?: string
  postalCode: string
  country: string
}

/**
 * A customer-placed order against a Site's `Product` catalog (Vault E-Shop add-on).
 * Items are snapshotted at order time so renames/price changes don't rewrite history.
 * Named `ShopOrder` to avoid colliding with the platform's provisioning `Order`.
 */
@Entity()
export class ShopOrder {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'currency' | 'fulfillmentStatus'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property() name!: string
  @Property() email!: string
  @Property({ nullable: true }) phone?: string
  @Property({ type: 'text', nullable: true }) notes?: string

  @Enum({ items: () => ['pickup', 'shipping'] as FulfillmentType[] })
  fulfillment!: FulfillmentType

  @Property({ type: 'json', nullable: true })
  shippingAddress?: ShippingAddress

  @Property({ type: 'json' })
  items: ShopOrderItem[] = []

  @Property()
  subtotalCents!: number

  @Property({ default: 0 })
  shippingCents: number = 0

  @Property()
  totalCents!: number

  @Property({ default: 'USD' })
  currency: string = 'USD'

  @Enum({ items: () => ['pending', 'paid', 'fulfilled', 'cancelled'] as ShopOrderStatus[] })
  status: ShopOrderStatus = 'pending'

  /** Stripe Checkout session that will collect payment (destination charge to the site owner). */
  @Property({ nullable: true })
  stripeSessionId?: string

  @Property({ nullable: true })
  stripePaymentIntentId?: string

  /** Square order behind the payment link, when the owner checks out through Square. */
  @Property({ nullable: true })
  squareOrderId?: string

  @Property({ nullable: true })
  squarePaymentId?: string

  /* ── Fulfillment tracker ──
     `status` is the money/lifecycle state; this is the physical progress the
     owner advances step by step, each step emailing the customer. Plain
     varchar, not an enum, so adding a step never needs a migration. */
  @Property({ type: 'string', length: 32, default: 'received' })
  fulfillmentStatus: FulfillmentStatus = 'received'

  @Property({ nullable: true })
  trackingNumber?: string

  @Property({ nullable: true })
  trackingCarrier?: string

  @Property({ length: 1000, nullable: true })
  trackingUrl?: string

  /** The owner's latest note to the customer, shown on the order page. */
  @Property({ type: 'text', nullable: true })
  fulfillmentNote?: string

  @Property({ type: 'json', nullable: true })
  fulfillmentHistory?: FulfillmentEvent[]

  @Property({ nullable: true })
  fulfillmentUpdatedAt?: Date

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
