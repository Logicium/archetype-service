import { Entity, ManyToOne, OptionalProps, PrimaryKey, Property, Index, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Site } from './site.entity'

/**
 * Immutable, append-only versioned content overlay for a Site.
 * The latest row with `published = true` is what `/v1/sites/:slug/content` serves.
 * Drafts (published=false) are saved as the owner edits in admin.
 */
@Entity()
@Unique({ properties: ['site', 'version'] })
export class SiteContent {
  [OptionalProps]?: 'createdAt' | 'published'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @ManyToOne(() => Site)
  @Index()
  site!: Site

  @Property()
  version!: number

  /** The full overlay payload — typed as MesaSiteConfig | HearthSiteConfig | VaultSiteConfig | KeystoneSiteConfig at the API boundary. */
  @Property({ type: 'json' })
  payload!: Record<string, unknown>

  @Property({ default: false })
  published: boolean = false

  @Property({ nullable: true })
  publishedAt?: Date

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()
}
