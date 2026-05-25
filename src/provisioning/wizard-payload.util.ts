/**
 * Normalize the wizard `wizardPayload` into the SiteContent shape the
 * runtime overlay (`/v1/sites/:slug/content`) and admin ContentView expect.
 *
 * The wizard UI (ContentWizardSection.vue) posts a FLAT form object as
 * `wizardPayload`. The original `WizardPayload` contract called for
 * `{ archetype, desiredSlug, config }` but the UI never produced that
 * shape, so the provisioner was seeding empty published content rows
 * (`payload = wp.config ?? {}` resolved to `{}`) — meaning fresh sites
 * never showed the brand/tagline/etc. the buyer entered.
 *
 * This helper accepts BOTH shapes:
 *   • nested  `{ desiredSlug, config: { ... } }`
 *   • flat    `{ archetype, brand, tagline, ..., menuCategories, rooms, ... }`
 * and always returns `{ desiredSlug, config }` where `config` matches the
 * SiteContent shape consumed by the deployed site.
 */

type AnyRec = Record<string, unknown>
type Archetype = 'mesa' | 'hearth' | 'vault' | 'keystone'

interface Normalized {
  desiredSlug?: string
  config: AnyRec
}

function isRec(v: unknown): v is AnyRec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asArr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** Map a flat wizard form into the SiteContent shape, branching on archetype. */
function flatFormToContent(form: AnyRec, archetype: Archetype): AnyRec {
  const photoOrEmpty = (p: unknown) =>
    isRec(p) ? { src: asStr(p.src), alt: asStr(p.alt), caption: asStr(p.caption) } : { src: '', alt: '', caption: '' }

  const common: AnyRec = {
    brand: asStr(form.brand),
    tagline: asStr(form.tagline),
    blurb: asStr(form.blurb),
    theme: asStr(form.theme) || 'studio',
    swatch: asStr(form.swatch) || 'sand',
    variant: asStr(form.variant) || 'essentials',
    contact: {
      address: asStr(form.address),
      phone: asStr(form.phone),
      email: asStr(form.email),
      mapEmbedUrl: asStr(form.mapEmbedUrl),
    },
    story: {
      title: asStr(form.storyTitle),
      paragraphs: asArr<string>(form.storyParagraphs).map(asStr),
      facts: asArr<AnyRec>(form.storyFacts).map(f => ({
        label: asStr(f.label),
        value: asStr(f.value),
      })),
    },
    testimonials: asArr<AnyRec>(form.testimonials).map(t => ({
      quote: asStr(t.quote),
      author: asStr(t.author),
      source: asStr(t.source),
    })),
    social: asArr<AnyRec>(form.social).map(s => ({
      label: asStr(s.label),
      href: asStr(s.href),
    })),
  }

  const hours = asArr<AnyRec>(form.hours).map(h => ({ day: asStr(h.day), open: asStr(h.open) }))

  if (archetype === 'mesa') {
    return {
      ...common,
      hours,
      photos: {
        hero: photoOrEmpty(form.heroPhoto),
        about: photoOrEmpty(form.aboutPhoto),
        gallery: asArr<unknown>(form.gallery).map(photoOrEmpty),
      },
      menu: {
        intro: asStr(form.menuIntro),
        fullMenuUrl: asStr(form.menuFullMenuUrl),
        categories: asArr<AnyRec>(form.menuCategories).map(cat => ({
          name: asStr(cat.name),
          description: asStr(cat.description),
          items: asArr<AnyRec>(cat.items).map(i => ({
            name: asStr(i.name),
            description: asStr(i.description),
            price: asStr(i.price),
            tags: typeof i.tags === 'string'
              ? (i.tags as string).split(',').map(s => s.trim()).filter(Boolean)
              : asArr<string>(i.tags),
          })),
        })),
      },
    }
  }

  if (archetype === 'hearth') {
    const roomPhotos = asArr<unknown>(form.roomPhotos).map(photoOrEmpty)
    return {
      ...common,
      photos: {
        hero: photoOrEmpty(form.heroPhoto),
        about: photoOrEmpty(form.aboutPhoto),
        rooms: roomPhotos,
        gallery: asArr<unknown>(form.gallery).map(photoOrEmpty),
      },
      rooms: asArr<AnyRec>(form.rooms).map(r => ({
        name: asStr(r.name),
        blurb: asStr(r.blurb),
        image: asStr(r.image),
        features: typeof r.features === 'string'
          ? (r.features as string).split(',').map(s => s.trim()).filter(Boolean)
          : asArr<string>(r.features),
        rateFrom: asStr(r.rateFrom),
        bookUrl: asStr(r.bookUrl),
      })),
      amenities: asArr<AnyRec>(form.amenities).map(a => ({
        label: asStr(a.label),
        description: asStr(a.description),
        icon: asStr(a.icon),
      })),
      bookingUrl: asStr(form.bookingUrl),
    }
  }

  if (archetype === 'vault') {
    return {
      ...common,
      hours,
      photos: {
        hero: photoOrEmpty(form.heroPhoto),
        about: photoOrEmpty(form.aboutPhoto),
        storefront: photoOrEmpty(form.storefrontPhoto),
        gallery: asArr<unknown>(form.gallery).map(photoOrEmpty),
      },
      featured: asArr<AnyRec>(form.featured).map(p => ({
        name: asStr(p.name),
        price: asStr(p.price),
        image: asStr(p.image),
        blurb: asStr(p.blurb),
        badge: asStr(p.badge),
        url: asStr(p.url),
      })),
      categories: asArr<AnyRec>(form.categories).map(c => ({
        name: asStr(c.name),
        image: asStr(c.image),
        url: asStr(c.url),
        count: asStr(c.count),
      })),
      shopUrl: asStr(form.shopUrl),
    }
  }

  // keystone (services)
  return {
    ...common,
    photos: {
      hero: photoOrEmpty(form.heroPhoto),
      about: photoOrEmpty(form.aboutPhoto),
      gallery: asArr<unknown>(form.gallery).map(photoOrEmpty),
    },
    serviceArea: asStr(form.serviceArea),
    dispatchPhone: asStr(form.dispatchPhone),
    emergencyAvailable: Boolean(form.emergencyAvailable),
    services: asArr<AnyRec>(form.services).map(s => ({
      name: asStr(s.name),
      description: asStr(s.description),
      price: asStr(s.price),
      icon: asStr(s.icon),
    })),
    capabilities: asArr<AnyRec>(form.capabilities).map(c => ({
      label: asStr(c.label),
      value: asStr(c.value),
    })),
  }
}

export function normalizeWizardPayload(
  raw: unknown,
  archetype: Archetype,
): Normalized {
  if (!isRec(raw)) return { config: {} }

  // Already nested: trust caller's shape.
  if (isRec(raw.config)) {
    return {
      desiredSlug: typeof raw.desiredSlug === 'string' ? raw.desiredSlug : undefined,
      config: raw.config,
    }
  }

  // Flat form — translate to SiteContent shape.
  const config = flatFormToContent(raw, archetype)
  const desiredSlug =
    typeof raw.desiredSlug === 'string' ? raw.desiredSlug :
    asStr(raw.brand) ? slugify(asStr(raw.brand)) :
    undefined

  return { desiredSlug, config }
}
