import { Entity, Enum, ManyToOne, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Owner } from './owner.entity'

export type SiteStatus = 'draft' | 'provisioning' | 'live' | 'failed' | 'archived'
export type ArchetypeKind = 'mesa' | 'hearth' | 'vault' | 'keystone'

@Entity()
export class Site {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'plan' | 'status'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Owner)
  owner!: Owner

  @Property()
  @Unique()
  slug!: string

  @Enum({ items: () => ['mesa', 'hearth', 'vault', 'keystone'] as ArchetypeKind[] })
  archetype!: ArchetypeKind

  @Property({ default: 'essentials' })
  plan: string = 'essentials'

  @Enum({ items: () => ['draft', 'provisioning', 'live', 'failed', 'archived'] as SiteStatus[] })
  status: SiteStatus = 'draft'

  /** "owner/repo" once GitHub repo is created. */
  @Property({ nullable: true })
  githubRepo?: string

  @Property({ nullable: true })
  vercelProjectId?: string

  @Property({ nullable: true })
  vercelProductionUrl?: string

  @Property({ nullable: true })
  customDomain?: string

  /** Random token the owner places as a DNS TXT record to prove domain ownership. */
  @Property({ nullable: true })
  domainVerificationToken?: string

  /** Google Places ID for review ingestion. */
  @Property({ nullable: true })
  googlePlaceId?: string

  /** Instagram long-lived access token (encrypted at rest in prod — TODO). */
  @Property({ nullable: true })
  instagramToken?: string

  @Property({ nullable: true })
  instagramTokenExpiresAt?: Date

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
