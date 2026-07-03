import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type ShopOrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled'
export type FulfillmentType = 'pickup' | 'shipping'

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
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'currency'

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

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
