import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

/** Platform-built-in types used by the marketing site. Owner-defined services
 *  (premium Appointment Booker) use arbitrary `serviceId` strings — those go in
 *  the `serviceId` column rather than this enum. */
export type BookingType = 'demo' | 'walkthrough' | 'photo-campaign' | 'service'
export type BookingStatus = 'confirmed' | 'cancelled'

@Entity()
export class Booking {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'cancelToken'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Enum({ items: () => ['demo', 'walkthrough', 'photo-campaign', 'service'] as BookingType[] })
  type!: BookingType

  /** Owner-defined service id from BookingConfig.services (when type === 'service'). */
  @Property({ nullable: true })
  serviceId?: string

  /** Snapshot of the service label at booking time, in case the owner renames or removes it later. */
  @Property({ nullable: true })
  serviceLabel?: string

  @Property() name!: string
  @Property() email!: string
  @Property({ nullable: true }) phone?: string
  @Property({ type: 'text', nullable: true }) notes?: string

  /** Start time in UTC. */
  @Property()
  @Index()
  scheduledAt!: Date

  @Property()
  durationMinutes!: number

  /** IANA tz the visitor booked in (so the .ics reflects local time on their device). */
  @Property({ nullable: true })
  timezone?: string

  @Enum({ items: () => ['confirmed', 'cancelled'] as BookingStatus[] })
  status: BookingStatus = 'confirmed'

  /** Random token used by visitor to cancel via emailed link without auth. */
  @Property()
  cancelToken: string = randomUUID()

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
