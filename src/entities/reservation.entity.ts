import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type ReservationStatus = 'confirmed' | 'cancelled'

/**
 * A lodging reservation against a Site's `lodgingConfig.rooms[]`. Date columns
 * use `dateOnly` so a stay is timezone-stable: "checked in May 27, out May 30"
 * regardless of where the visitor or server lives.
 */
@Entity()
export class Reservation {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'cancelToken'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  /** Snapshot of the chosen `LodgingRoom.id`. */
  @Property()
  roomId!: string

  /** Snapshot of the label at booking time, so renames don't rewrite history. */
  @Property()
  roomLabel!: string

  /** Inclusive check-in date, "YYYY-MM-DD". */
  @Property({ columnType: 'date' })
  @Index()
  checkIn!: string

  /** Exclusive check-out date, "YYYY-MM-DD". */
  @Property({ columnType: 'date' })
  checkOut!: string

  @Property()
  nights!: number

  @Property()
  partySize!: number

  @Property() name!: string
  @Property() email!: string
  @Property({ nullable: true }) phone?: string
  @Property({ type: 'text', nullable: true }) notes?: string

  /** Snapshot of total price in smallest currency unit, when the room has a rate. */
  @Property({ nullable: true })
  totalCents?: number

  @Property({ nullable: true })
  currency?: string

  @Enum({ items: () => ['confirmed', 'cancelled'] as ReservationStatus[] })
  status: ReservationStatus = 'confirmed'

  @Property()
  cancelToken: string = randomUUID()

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
