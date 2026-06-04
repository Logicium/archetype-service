import { Entity, Index, ManyToOne, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

/**
 * A product offered by a Site's e-shop (premium Vault E-Shop add-on).
 * SKU is unique per-site so two sites can both ship a "MUG-001".
 */
@Entity()
@Unique({ properties: ['site', 'sku'] })
export class Product {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'active' | 'sortOrder' | 'inventory' | 'currency'

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

  @Property({ nullable: true })
  imageUrl?: string

  /** Stock count. -1 means unlimited. */
  @Property({ default: -1 })
  inventory: number = -1

  @Property({ default: true })
  active: boolean = true

  @Property({ default: 0 })
  sortOrder: number = 0

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
