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

  /** Human-readable site name shown in the admin (e.g. the business name).
   *  Auto-sourced from siteConfig.brand on first publish if not set, then editable. */
  @Property({ nullable: true })
  displayName?: string

  /** When set, the site is hidden from the default admin list and considered
   *  paused. The Vercel project and GitHub repo are left intact. */
  @Property({ nullable: true })
  deactivatedAt?: Date

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

  /** SHA of the template repo's default branch at provision time — used to detect updates. */
  @Property({ nullable: true })
  templateCommitSha?: string

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
