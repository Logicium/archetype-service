/** Pricing for the Apotome Trinidad website program. Single source of truth.
 *  Shared by `archetype-project-ui` (display) and `archetype-service` (Stripe). */

export type PriceCategory = 'website' | 'marketing' | 'addons'

export interface PriceItem {
  id: string
  name: string
  price: number
  unit?: string
  blurb: string
  featured?: boolean
  category: PriceCategory
  includes?: string[]
  /** Optional: env var name holding the Stripe Price ID for this SKU. */
  stripePriceEnv?: string
}

export const PRICING: PriceItem[] = [
  { id: 'website', name: 'Website (Essentials)', price: 200, blurb: 'A polished one-of-three template, configured for your business with up to 8 photos.', category: 'website', featured: true, stripePriceEnv: 'STRIPE_PRICE_WEBSITE_ESSENTIALS',
    includes: ['Choice of three design themes (Studio, Heritage, Vibrant)', 'Choice of eight color swatches', 'Hosted, fast, mobile-ready', '6–8 of your photos placed and captioned', 'Hours, contact, and map embedded'] },
  { id: 'website-extended', name: 'Website (Portfolio)', price: 250, blurb: 'The extended template with a dedicated gallery and 12–16 photos.', category: 'website', stripePriceEnv: 'STRIPE_PRICE_WEBSITE_PORTFOLIO',
    includes: ['Everything in Essentials', 'Dedicated gallery / lookbook page', '12–16 of your photos placed and captioned', 'Extra section per page (menu, rooms, products)'] },
  { id: 'tuneup', name: 'Website tune-up', price: 100, unit: 'per visit', blurb: 'Refresh your site after a season change, menu update, or new product line.', category: 'website', stripePriceEnv: 'STRIPE_PRICE_TUNEUP',
    includes: ['Up to 3 hours of edits', 'Photo swap-outs', 'Copy refresh'] },
  { id: 'photo', name: 'Photo campaign', price: 100, blurb: 'A short photo session that delivers the 8 photos your Essentials site needs.', category: 'marketing', stripePriceEnv: 'STRIPE_PRICE_PHOTO',
    includes: ['On-location shoot', '8 web-ready edited photos', 'Named to match your site'] },
  { id: 'photo-extended', name: 'Photo campaign (Extended)', price: 150, blurb: 'A longer session that delivers the 16 photos your Portfolio site needs.', category: 'marketing', stripePriceEnv: 'STRIPE_PRICE_PHOTO_EXTENDED',
    includes: ['Two-hour on-location shoot', '16 web-ready edited photos', 'Lifestyle + product + interior coverage'] },
  { id: 'gmaps', name: 'Google Business Profile', price: 50, blurb: 'We set up — or fix — your Google Maps profile so locals can find you.', category: 'addons', stripePriceEnv: 'STRIPE_PRICE_GMAPS',
    includes: ['Profile creation or claim', 'Hours, photos, links', 'Verification walkthrough'] },
  { id: 'gsc', name: 'Google Search Console', price: 50, blurb: 'We connect your site to Google so it gets indexed faster and you can see search traffic.', category: 'addons', stripePriceEnv: 'STRIPE_PRICE_GSC',
    includes: ['Property setup', 'Sitemap submission', 'A 1-page guide for reading your stats'] },
  { id: 'instagram-gmaps', name: 'Instagram + Google Reviews', price: 50, blurb: 'Embed your latest Instagram posts and live Google star ratings directly on your site — keeps content fresh automatically.', category: 'addons', stripePriceEnv: 'STRIPE_PRICE_INSTA_GMAPS',
    includes: ['Instagram feed widget (latest posts, auto-updated)', 'Google Maps star rating + review carousel', 'No manual updates needed'] },
]

export interface Bundle {
  id: string
  name: string
  price: number
  items: string[]
  saves: number
  blurb: string
  stripePriceEnv?: string
}

export const BUNDLES: readonly Bundle[] = [
  { id: 'starter', name: 'Trinidad Starter', price: 350, items: ['Website (Essentials)', 'Photo campaign', 'Google Business Profile'], saves: 0, blurb: 'Everything a new business needs to be online and findable.', stripePriceEnv: 'STRIPE_PRICE_BUNDLE_STARTER' },
  { id: 'pro', name: 'Trinidad Portfolio', price: 450, items: ['Website (Portfolio)', 'Photo campaign (Extended)', 'Google Business Profile'], saves: 0, blurb: 'For established businesses ready to show their full story.', stripePriceEnv: 'STRIPE_PRICE_BUNDLE_PRO' },
] as const

export function findPriceItem(id: string): PriceItem | undefined {
  return PRICING.find(p => p.id === id)
}
export function findBundle(id: string): Bundle | undefined {
  return BUNDLES.find(b => b.id === id)
}
