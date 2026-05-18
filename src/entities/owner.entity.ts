import { Entity, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'

@Entity()
export class Owner {
  [OptionalProps]?: 'createdAt' | 'name'

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @Property()
  @Unique()
  email!: string

  @Property({ nullable: true })
  name?: string

  /** Hash of the latest magic-link token (single-use). */
  @Property({ nullable: true })
  magicLinkHash?: string

  /** Expiry of the current magic-link token. */
  @Property({ nullable: true })
  magicLinkExpiresAt?: Date

  /** bcrypt hash; optional — owners can use magic links instead. */
  @Property({ nullable: true })
  passwordHash?: string

  @Property({ nullable: true })
  lastLoginAt?: Date

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()
}
