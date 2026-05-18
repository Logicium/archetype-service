/**
 * Site content type contracts for each archetype.
 * Used by the runtime overlay API (`/v1/sites/:slug/content`)
 * and the wizard payload posted to `/v1/orders`.
 */
import type { ThemeName, SwatchName, SiteVariant, ArchetypeKey } from './tokens'

export interface PhotoSlot { src: string; alt?: string; caption?: string }
export interface ContactInfo { address: string; phone: string; email: string; mapEmbedUrl?: string }
export interface Story { title: string; paragraphs: string[]; facts?: Array<{ label: string; value: string }> }
export interface Testimonial { quote: string; author: string; source?: string }
export interface SocialLink { label: string; href: string }
export interface HoursRow { day: string; open: string }

/** Mesa (restaurant) */
export interface MenuItem { name: string; description?: string; price: string; tags?: string[] }
export interface MenuCategory { name: string; description?: string; items: MenuItem[] }
export interface MesaPhotos { hero: PhotoSlot; about: PhotoSlot; gallery: PhotoSlot[] }
export interface MesaSiteConfig {
  brand: string
  tagline: string
  blurb: string
  theme: ThemeName
  swatch: SwatchName
  variant: SiteVariant
  contact: ContactInfo
  hours: HoursRow[]
  photos: MesaPhotos
  story: Story
  menu: { intro?: string; categories: MenuCategory[]; fullMenuUrl?: string }
  testimonials: Testimonial[]
  social: SocialLink[]
}

/** Hearth (hotel) */
export interface Room {
  name: string
  blurb: string
  image: string
  imageAlt?: string
  features: string[]
  rateFrom?: string
  bookUrl?: string
}
export interface HearthPhotos { hero: PhotoSlot; about: PhotoSlot; rooms: PhotoSlot[]; gallery: PhotoSlot[] }
export interface HearthSiteConfig {
  brand: string
  tagline: string
  blurb: string
  theme: ThemeName
  swatch: SwatchName
  variant: SiteVariant
  contact: ContactInfo
  photos: HearthPhotos
  story: Story
  rooms: Room[]
  amenities: Array<{ label: string; description?: string; icon?: string }>
  testimonials: Testimonial[]
  bookingUrl: string
  social: SocialLink[]
}

/** Vault (shop) */
export interface Product {
  name: string
  price: string
  image: string
  imageAlt?: string
  blurb?: string
  badge?: string
  url?: string
}
export interface Category { name: string; image: string; imageAlt?: string; url?: string; count?: number }
export interface VaultPhotos { hero: PhotoSlot; about: PhotoSlot; storefront: PhotoSlot; gallery: PhotoSlot[] }
export interface VaultSiteConfig {
  brand: string
  tagline: string
  blurb: string
  theme: ThemeName
  swatch: SwatchName
  variant: SiteVariant
  contact: ContactInfo
  hours: HoursRow[]
  photos: VaultPhotos
  story: Story
  featured: Product[]
  categories: Category[]
  testimonials: Testimonial[]
  shopUrl: string
  social: SocialLink[]
}

export type AnySiteConfig = MesaSiteConfig | HearthSiteConfig | VaultSiteConfig

export type SiteConfigOf<K extends ArchetypeKey> =
  K extends 'mesa' ? MesaSiteConfig :
  K extends 'hearth' ? HearthSiteConfig :
  K extends 'vault' ? VaultSiteConfig :
  never

/** Wizard / order payload posted to the backend on purchase. */
export interface WizardPayload<K extends ArchetypeKey = ArchetypeKey> {
  archetype: K
  /** A clean, sluggable brand identifier; the backend will dedupe. */
  desiredSlug: string
  config: SiteConfigOf<K>
}

/** Owner-facing form submission shape. */
export interface FormSubmissionPayload {
  type: 'contact' | 'newsletter'
  /** Free-form key/value collected by the form. */
  fields: Record<string, string>
  /** Honeypot — must be empty. */
  hp?: string
  /** hCaptcha response token. */
  captcha?: string
}
