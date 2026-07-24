/**
 * Human-readable order summary for owner-notification emails. Mirrors the
 * frontend pricing catalog (archetype-project-ui/src/config/pricing.ts) by id
 * so the "what they paid for" list reads in plain English. Kept intentionally
 * small; the authoritative charge is always the Stripe session.
 */

interface CatalogItem { label: string; price: number }

const CATALOG: Record<string, CatalogItem> = {
  // Websites
  'website': { label: 'Website (Essentials)', price: 200 },
  'website-extended': { label: 'Website (Portfolio)', price: 250 },
  'tuneup': { label: 'Website tune-up', price: 100 },
  // Marketing
  'photo': { label: 'Photo campaign', price: 100 },
  'photo-extended': { label: 'Photo campaign (Extended)', price: 150 },
  // Add-ons
  'gmaps': { label: 'Google Business Profile', price: 50 },
  'gsc': { label: 'Google Search Console', price: 50 },
  // Bundles
  'starter': { label: 'Trinidad Starter bundle', price: 350 },
  'pro': { label: 'Trinidad Portfolio bundle', price: 450 },
}

export interface OrderLine { label: string; value: string; strong?: boolean }

export interface OrderSummary {
  lines: OrderLine[]
  total: number
  planLabel: string
}

/** Build display line-items + total from an order's plan id and add-on ids. */
export function summarizeOrder(plan: string, addOns: string[] = []): OrderSummary {
  const lines: OrderLine[] = []
  let total = 0

  const base = CATALOG[plan]
  const planLabel = base?.label ?? plan
  if (base) { lines.push({ label: base.label, value: `$${base.price}` }); total += base.price }
  else lines.push({ label: planLabel, value: '' })

  for (const id of addOns) {
    const item = CATALOG[id]
    if (item) { lines.push({ label: item.label, value: `$${item.price}` }); total += item.price }
    else lines.push({ label: id, value: '' })
  }

  lines.push({ label: 'Total', value: `$${total}`, strong: true })
  return { lines, total, planLabel }
}
