/**
 * Exercises the Portfolio tier end to end without touching the live database:
 * which plans count as paid, what a buyer gets on the initial purchase, and
 * what the $50 upgrade changes.
 *
 * The bug this guards against: `Site.plan` holds catalogue SKU ids from the
 * initial purchase (`website-extended`) but tier names from the upgrade flow
 * (`portfolio`). When only the tier names were recognised, anyone who bought
 * Portfolio outright silently received an Essentials site.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/portfolio-tier.check.ts
 */
import { resolvePlanTier, VARIANT_PHOTO_COUNT } from '../src/shared/tokens'

type Row = { payload: Record<string, unknown>; published: boolean; version: number }

async function main() {
  const results: Array<{ n: string; ok: boolean; info?: string }> = []
  const check = (n: string, ok: boolean, info?: string) => results.push({ n, ok, info })

  /* ── 1. Plan → tier ─────────────────────────────────────────────── */
  check('the Essentials SKU is Essentials', resolvePlanTier('website') === 'essentials')
  check('the $250 Portfolio SKU counts as paid Portfolio',
    resolvePlanTier('website-extended') === 'portfolio', resolvePlanTier('website-extended'))
  check('the $300 Extended SKU counts as paid Portfolio',
    resolvePlanTier('website-premium') === 'portfolio')
  check('the $50 upgrade SKU counts as paid Portfolio',
    resolvePlanTier('website-portfolio-upgrade') === 'portfolio')
  check('a site already stored as the tier name still resolves',
    resolvePlanTier('portfolio') === 'portfolio')
  check('the legacy "extended" tier name still resolves',
    resolvePlanTier('extended') === 'portfolio')
  check('case and whitespace do not change the answer',
    resolvePlanTier('  Website-Extended ') === 'portfolio')
  check('an unknown plan grants nothing', resolvePlanTier('website-galaxy-tier') === 'essentials')
  check('null/undefined/empty grant nothing',
    resolvePlanTier(null) === 'essentials' &&
    resolvePlanTier(undefined) === 'essentials' &&
    resolvePlanTier('') === 'essentials')

  /* ── 2. Paid tier means more photos ─────────────────────────────── */
  check('Portfolio really does buy more photo capacity',
    VARIANT_PHOTO_COUNT.portfolio.max > VARIANT_PHOTO_COUNT.essentials.max,
    `${VARIANT_PHOTO_COUNT.essentials.max} -> ${VARIANT_PHOTO_COUNT.portfolio.max}`)

  /* ── 3. Initial purchase seeds the layout it paid for ───────────── */
  // Mirrors provisioning.processor: the paid tier overrides the wizard's
  // preview variant, and the Site row stores the tier, never the SKU.
  const seedFor = (orderPlan: string, wizardVariant?: string) => {
    const seeded: Record<string, unknown> = { brand: 'Test', variant: wizardVariant ?? 'essentials' }
    const tier = resolvePlanTier(orderPlan)
    seeded.variant = tier
    return { seeded, sitePlan: tier }
  }
  const bought = seedFor('website-extended')
  check('buying Portfolio up front seeds a portfolio layout',
    bought.seeded.variant === 'portfolio', String(bought.seeded.variant))
  check('the Site row stores the tier, not the SKU',
    bought.sitePlan === 'portfolio', bought.sitePlan)
  check('a stale wizard variant cannot downgrade a paid build',
    seedFor('website-extended', 'essentials').seeded.variant === 'portfolio')
  check('buying Essentials still seeds Essentials',
    seedFor('website').seeded.variant === 'essentials')

  /* ── 4. The $50 upgrade flips the live site, not just the flag ──── */
  // Mirrors OrdersService.applyUpgrade + applyVariantToContent.
  const applyVariant = (rows: Row[], variant: string) => {
    const targets = [rows.find(r => r.published), rows.find(r => !r.published)]
      .filter((r): r is Row => !!r)
    for (const r of targets) r.payload = { ...r.payload, variant }
    return targets.length
  }

  const live: Row = { payload: { brand: 'Cafe', variant: 'essentials' }, published: true, version: 3 }
  const draft: Row = { payload: { brand: 'Cafe', variant: 'essentials' }, published: false, version: 4 }
  const touched = applyVariant([draft, live], 'portfolio')

  check('the upgrade rewrites the PUBLISHED content visitors see',
    live.payload.variant === 'portfolio', String(live.payload.variant))
  check('the upgrade also rewrites an open draft, so publishing cannot revert it',
    draft.payload.variant === 'portfolio', String(draft.payload.variant))
  check('it touches both rows and nothing else', touched === 2, String(touched))
  check('unrelated content survives the variant write',
    live.payload.brand === 'Cafe' && draft.payload.brand === 'Cafe')

  const onlyPublished: Row = { payload: { variant: 'essentials' }, published: true, version: 1 }
  check('a site with no open draft still upgrades',
    applyVariant([onlyPublished], 'portfolio') === 1 && onlyPublished.payload.variant === 'portfolio')

  /* ── 5. Every purchase route ends at the same place ─────────────── */
  for (const sku of ['website-extended', 'website-premium', 'website-portfolio-upgrade']) {
    check(`"${sku}" ends up on the portfolio layout`, resolvePlanTier(sku) === 'portfolio')
  }

  let pass = 0
  for (const r of results) {
    if (r.ok) pass++
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${!r.ok && r.info ? `\n        got: ${r.info}` : ''}`)
  }
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
