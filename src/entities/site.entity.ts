import { Entity, Enum, ManyToOne, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { Owner } from './owner.entity'

export type SiteStatus = 'draft' | 'provisioning' | 'live' | 'failed' | 'archived'
export type ArchetypeKind = 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'

/** Owner-defined bookable service (premium Appointment Booker add-on). */
export interface BookingService {
  /** Stable id used in API calls; kebab-case (e.g. "oil-change"). */
  id: string
  label: string
  description?: string
  durationMinutes: number
}

/** Day-of-week (0=Sun..6=Sat) -> list of "HH:MM-HH:MM" local-time ranges when slots may be booked. */
export interface BookingConfig {
  /** IANA tz the windows are interpreted in (e.g. "America/Denver"). */
  timezone?: string
  /** 0 (Sun) .. 6 (Sat). Missing keys = closed that day. */
  hours?: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, string[]>>
  /** Minutes between bookable slot starts. Default 30. */
  slotMinutes?: number
  /** Per-type durations in minutes. Defaults: demo 30, walkthrough 45, photo-campaign 60. */
  durations?: Partial<Record<'demo' | 'walkthrough' | 'photo-campaign', number>>
  /** Minimum hours of lead time required before the earliest slot. Default 24. */
  minLeadHours?: number
  /** How many days forward to expose. Default 30. */
  windowDays?: number
  /** Platform-built-in types this site offers (for the marketing site). Default all three. */
  enabledTypes?: Array<'demo' | 'walkthrough' | 'photo-campaign'>
  /** Owner-defined services (premium Appointment Booker). When non-empty, the public
   *  booking UI shows these instead of the platform types. */
  services?: BookingService[]
}

/** Owner-defined bookable lodging unit (premium Hearth Booking add-on). */
export interface LodgingRoom {
  /** Stable id; kebab-case (e.g. "cabin-pine"). */
  id: string
  label: string
  description?: string
  capacity: number
  /** Nightly rate in the smallest currency unit (cents). Optional — when omitted, no price is shown. */
  nightlyRateCents?: number
  imageUrl?: string
}

/** Per-site lodging configuration (premium Hearth Booking add-on). */
export interface LodgingConfig {
  /** IANA tz for check-in / check-out day boundaries. */
  timezone?: string
  /** ISO 4217 (e.g. "USD"). */
  currency?: string
  /** Minimum stay length in nights. Default 1. */
  minNights?: number
  /** Maximum stay length in nights. Default 14. */
  maxNights?: number
  /** How many days forward visitors can book. Default 180. */
  windowDays?: number
  /** Default check-in time, "HH:MM" 24h. Default "15:00". */
  checkInTime?: string
  /** Default check-out time, "HH:MM" 24h. Default "11:00". */
  checkOutTime?: string
  rooms?: LodgingRoom[]
}

/** Per-site e-shop configuration (premium Vault E-Shop add-on). */
export interface ShopConfig {
  /** ISO 4217 (e.g. "USD"). Default "USD". */
  currency?: string
  /** Which fulfillment methods are offered. Default ['pickup']. */
  fulfillment?: Array<'pickup' | 'shipping'>
  /** Shown to the customer after a pickup order is placed. */
  pickupInstructions?: string
  /** Flat shipping fee in cents added when fulfillment === 'shipping'. Default 0. */
  shippingFlatCents?: number
  /** Owner email notified on new orders. Falls back to site owner's email. */
  notifyEmail?: string
}

/** Per-site meal-ordering configuration (premium Mesa Meal Ordering add-on). */
export interface OrderingConfig {
  /** IANA tz for pickup-hour windows. */
  timezone?: string
  /** ISO 4217. Default "USD". */
  currency?: string
  /** Pickup windows per weekday (0=Sun..6=Sat) as "HH:MM-HH:MM". Missing keys = closed. */
  hours?: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, string[]>>
  /** Minutes between bookable pickup slot starts. Default 15. */
  slotMinutes?: number
  /** Minimum minutes of prep lead time before the earliest selectable slot. Default 30. */
  prepMinutes?: number
  /** Max orders that may share a single pickup slot. Default 5. */
  maxOrdersPerSlot?: number
  /** How many days forward to expose. Default 14. */
  windowDays?: number
  /** Free-form instructions shown after order confirmation. */
  pickupInstructions?: string
  /** Owner notification email. Falls back to site owner's email. */
  notifyEmail?: string
}

@Entity()
export class Site {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'plan' | 'status' | 'addOns'

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

  @Enum({ items: () => ['mesa', 'hearth', 'vault', 'marquee', 'keystone'] as ArchetypeKind[] })
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

  /** Public Vercel Blob URL of the most recent site screenshot, or null if never captured. */
  @Property({ nullable: true })
  screenshotUrl?: string

  /** When the current screenshot was captured. Used to display "X days ago" and decide staleness. */
  @Property({ nullable: true })
  screenshotCapturedAt?: Date

  /** Production URL the current screenshot was taken of. Lets us detect URL drift cheaply. */
  @Property({ nullable: true })
  screenshotSourceUrl?: string

  /** Per-site overrides for booking availability. Falls back to platform defaults
   *  (see `bookings/booking-hours.ts`) when null. */
  @Property({ type: 'json', nullable: true })
  bookingConfig?: BookingConfig

  /** Per-site lodging configuration (Hearth Booking add-on). */
  @Property({ type: 'json', nullable: true })
  lodgingConfig?: LodgingConfig

  /** Per-site e-shop configuration (Vault E-Shop add-on). */
  @Property({ type: 'json', nullable: true })
  shopConfig?: ShopConfig

  /** Per-site meal-ordering configuration (Mesa Meal Ordering add-on). */
  @Property({ type: 'json', nullable: true })
  orderingConfig?: OrderingConfig

  /** Enabled premium add-ons (e.g. 'appointments', 'eshop', 'lodging', 'ordering', 'ticketing').
   *  Driven by the order's `addOns` at provisioning time; mutable by admin. */
  @Property({ type: 'json', default: '[]' })
  addOns: string[] = []

  @Property({ defaultRaw: 'NOW()' })
  createdAt: Date = new Date()

  @Property({ defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
