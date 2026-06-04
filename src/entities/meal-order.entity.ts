import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type MealOrderStatus = 'pending' | 'confirmed' | 'ready' | 'completed' | 'cancelled'

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

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
