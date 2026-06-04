import { Collection, Entity, Enum, Index, ManyToOne, OneToMany, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type EventStatus = 'draft' | 'on_sale' | 'sold_out' | 'cancelled' | 'past'

export interface TicketTier {
  /** Stable id (kebab-case). */
  id: string
  label: string
  description?: string
  /** Price in smallest currency unit. 0 = free. */
  priceCents: number
  /** Per-tier cap. -1 = unlimited (subject to event capacity). */
  capacity: number
  /** Defaults to true. */
  active?: boolean
}

/**
 * A scheduled event with one or more `TicketTier` options (Marquee Ticket Sales add-on).
 * Tier capacities are tracked by counting non-cancelled ticket rows.
 */
@Entity()
export class Event {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'currency' | 'capacity'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property()
  title!: string

  @Property({ type: 'text', nullable: true })
  description?: string

  @Property()
  @Index()
  startsAt!: Date

  @Property({ nullable: true })
  endsAt?: Date

  @Property({ nullable: true })
  venue?: string

  @Property({ nullable: true })
  imageUrl?: string

  /** Total event capacity across tiers. -1 = unlimited. */
  @Property({ default: -1 })
  capacity: number = -1

  @Property({ default: 'USD' })
  currency: string = 'USD'

  @Property({ type: 'json' })
  tiers: TicketTier[] = []

  @Enum({ items: () => ['draft', 'on_sale', 'sold_out', 'cancelled', 'past'] as EventStatus[] })
  status: EventStatus = 'draft'

  @OneToMany(() => Ticket, t => t.event)
  tickets = new Collection<Ticket>(this)

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type TicketStatus = 'confirmed' | 'cancelled' | 'checked_in'

/**
 * A single ticket purchased against an `Event.tiers[]` entry. Tier label/price
 * snapshotted at purchase. One row per seat to make capacity math straightforward.
 */
@Entity()
export class Ticket {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'cancelToken'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Event)
  @Index()
  event!: Event

  @Property()
  tierId!: string

  @Property()
  tierLabel!: string

  @Property()
  unitPriceCents!: number

  @Property()
  currency!: string

  @Property() name!: string
  @Property() email!: string
  @Property({ nullable: true }) phone?: string

  /** Order id grouping tickets purchased together. */
  @Property()
  @Index()
  orderId!: string

  @Enum({ items: () => ['confirmed', 'cancelled', 'checked_in'] as TicketStatus[] })
  status: TicketStatus = 'confirmed'

  @Property()
  cancelToken: string = randomUUID()

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
