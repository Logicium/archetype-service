import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

export type SubmissionType = 'contact' | 'newsletter'

@Entity()
export class FormSubmission {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Enum({ items: () => ['contact', 'newsletter'] as SubmissionType[] })
  type!: SubmissionType

  @Property({ type: 'json' })
  payload!: Record<string, string>

  @Property({ nullable: true })
  ipAddress?: string

  @Property({ nullable: true })
  readAt?: Date

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()
}

@Entity()
@Index({ properties: ['site', 'externalId'] })
export class Review {
  [OptionalProps]?: 'fetchedAt' | 'visible'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  site!: Site

  @Property()
  source!: 'google' | 'manual'

  @Property()
  rating!: number

  @Property()
  author!: string

  @Property({ length: 2000 })
  text!: string

  @Property({ nullable: true })
  externalId?: string

  @Property({ default: true })
  visible: boolean = true

  @Property({ defaultRaw: 'NOW()' })
  fetchedAt: Date = new Date()
}

@Entity()
export class DeployLog {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property()
  step!: string

  @Property()
  status!: 'pending' | 'success' | 'failure'

  @Property({ nullable: true, length: 4000 })
  message?: string

  @Property({ nullable: true })
  durationMs?: number

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()
}

@Entity()
export class SiteMetric {
  [OptionalProps]?: 'visitors' | 'pageviews' | 'uptimeLatencyMs'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property()
  date!: Date

  @Property({ default: 0 })
  visitors: number = 0

  @Property({ default: 0 })
  pageviews: number = 0

  /** Last uptime probe success (ms). 0 = down. */
  @Property({ default: 0 })
  uptimeLatencyMs: number = 0

  @Property({ nullable: true })
  uptimeError?: string
}

@Entity()
export class AuditEvent {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @Property({ nullable: true })
  ownerId?: string

  @Property({ nullable: true })
  siteId?: string

  @Property()
  action!: string

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown>

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()
}
