import { Entity, Enum, ManyToOne, OptionalProps, PrimaryKey, Property, Index } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Owner } from './owner.entity'

export type OrderStatus = 'pending' | 'paid' | 'provisioning' | 'live' | 'failed' | 'cancelled'

@Entity()
export class Order {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'addOns' | 'status'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Owner)
  @Index()
  owner!: Owner

  @Property()
  archetype!: 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'

  @Property()
  plan!: string

  @Property({ type: 'json' })
  addOns: string[] = []

  /** Snapshot of the wizard payload that produced this order. */
  @Property({ type: 'json' })
  wizardPayload!: Record<string, unknown>

  @Property({ nullable: true })
  stripeSessionId?: string

  @Property({ nullable: true })
  stripeCustomerId?: string

  /** Linked Site once provisioning starts. */
  @Property({ nullable: true })
  siteId?: string

  @Enum({ items: () => ['pending', 'paid', 'provisioning', 'live', 'failed', 'cancelled'] as OrderStatus[] })
  status: OrderStatus = 'pending'

  @Property({ nullable: true, length: 1000 })
  failureReason?: string

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
