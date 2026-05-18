/**
 * Theme token contracts shared across every Archetype site.
 * A "theme" defines feel (typography, spacing, shape).
 * A "swatch" defines color. They are composed at runtime.
 *
 * This file is the single source of truth — every archetype UI
 * re-exports these types from `src/themes/tokens.ts`.
 */

export type ThemeName = 'studio' | 'heritage' | 'vibrant'
export type HeroStyle = '1' | '2' | '3' | '4' | '5' | '6'
export type FooterStyle = '1' | '2' | '3' | '4' | '5'
export type ContactStyle = '1' | '2' | '3' | '4' | '5'
export type HoursStyle = '1' | '2' | '3' | '4' | '5'
export type GalleryStyle = '1' | '2' | '3' | '4' | '5'
export type ReviewsStyle = '1' | '2' | '3' | '4' | '5'
export type SubheroStyle = '1' | '2' | '3' | '4' | '5'
export type SiteStyle = '1' | '2' | '3' | '4' | '5'
export type Alignment = 'left' | 'center'

export type SwatchGroup = 'neutral' | 'earth' | 'warm' | 'bold' | 'dark' | 'neon'

export type SwatchName =
  | 'sand' | 'forest' | 'sage' | 'sunset' | 'rose' | 'stone' | 'fiesta' | 'citrus'
  | 'midnight' | 'obsidian' | 'ember' | 'plum'
  | 'electric' | 'punch' | 'neon' | 'aurora'

export type SiteVariant = 'essentials' | 'portfolio'
export type Archetype = 'dine' | 'stay' | 'shop' | 'project' | 'utility'
/** Maps an `Archetype` to its template repo key. */
export type ArchetypeKey = 'mesa' | 'hearth' | 'vault' | 'keystone'

export const ARCHETYPE_OF: Record<ArchetypeKey, Archetype> = {
  mesa: 'dine',
  hearth: 'stay',
  vault: 'shop',
  keystone: 'utility',
}

export const VARIANT_PHOTO_COUNT: Record<SiteVariant, { gallery: number; max: number }> = {
  essentials: { gallery: 6, max: 8 },
  portfolio: { gallery: 12, max: 16 },
}
