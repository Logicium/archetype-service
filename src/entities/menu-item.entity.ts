import { Entity, Index, ManyToOne, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

/**
 * A menu item offered by a Site's pickup-ordering kitchen (premium Mesa Meal Ordering add-on).
 * SKU is unique per-site. `category` groups items on the public menu.
 */
@Entity()
@Unique({ properties: ['site', 'sku'] })
export class MenuItem {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'active' | 'sortOrder' | 'currency' | 'category'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property()
  sku!: string

  @Property()
  name!: string

  @Property({ type: 'text', nullable: true })
  description?: string

  /** Price in smallest currency unit (cents). */
  @Property()
  priceCents!: number

  @Property({ default: 'USD' })
  currency: string = 'USD'

  @Property({ default: '' })
  category: string = ''

  @Property({ nullable: true })
  imageUrl?: string

  @Property({ default: true })
  active: boolean = true

  @Property({ default: 0 })
  sortOrder: number = 0

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
