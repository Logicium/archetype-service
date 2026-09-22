/**
 * Backfills sites that PAID for Portfolio but are still rendering Essentials.
 *
 * Two things drifted apart before the tier fix:
 *   - `Site.plan` stored the catalogue SKU (`website-extended`) on the initial
 *     purchase, while every gate looked for the tier name (`portfolio`).
 *   - The $50 upgrade set `Site.plan` but never touched `variant` in the
 *     site's content, which is what actually decides the layout.
 *
 * So an owner could be fully paid up and still see an 8-photo Essentials site.
 * This normalises `Site.plan` to a tier name and writes `variant: 'portfolio'`
 * into the published content (and any open draft, so publishing cannot revert
 * it). It never downgrades anyone.
 *
 * Reports only by default. Run it again with --apply to write.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-portfolio-tier.ts
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-portfolio-tier.ts --apply
 */
import 'dotenv/config'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import config from '../src/mikro-orm.config'
import { Site } from '../src/entities/site.entity'
import { SiteContent } from '../src/entities/site-content.entity'
import { resolvePlanTier } from '../src/shared/tokens'

async function main() {
  const apply = process.argv.includes('--apply')
  const orm = await MikroORM.init<PostgreSqlDriver>(config)
  const em = orm.em.fork()

  const sites = await em.find(Site, {})
  const planFixes: Array<{ slug: string; from: string; to: string }> = []
  const variantFixes: Array<{ slug: string; rows: string }> = []

  for (const site of sites) {
    if (resolvePlanTier(site.plan) !== 'portfolio') continue

    // 1. Normalise the stored plan to the tier name.
    if (site.plan !== 'portfolio') {
      planFixes.push({ slug: site.slug, from: site.plan, to: 'portfolio' })
      if (apply) site.plan = 'portfolio'
    }

    // 2. Make the live site actually render the tier they paid for.
    const rows = await em.find(SiteContent, { site: site.id }, { orderBy: { version: 'desc' }, limit: 2 })
    const targets = [rows.find(r => r.published), rows.find(r => !r.published)]
      .filter((r): r is SiteContent => !!r)
      .filter(r => r.payload?.variant !== 'portfolio')

    if (targets.length) {
      variantFixes.push({
        slug: site.slug,
        rows: targets.map(r => `v${r.version}${r.published ? ' (live)' : ' (draft)'}`).join(', '),
      })
      if (apply) {
        for (const r of targets) r.payload = { ...(r.payload ?? {}), variant: 'portfolio' }
      }
    }
  }

  console.log(`\nScanned ${sites.length} sites.\n`)

  if (!planFixes.length && !variantFixes.length) {
    console.log('Nothing to backfill — every paid Portfolio site already renders as one.')
    await orm.close(true)
    return
  }

  if (planFixes.length) {
    console.log(`Site.plan -> 'portfolio'  (${planFixes.length})`)
    for (const f of planFixes) console.log(`  ${f.slug.padEnd(28)} ${f.from} -> ${f.to}`)
    console.log()
  }
  if (variantFixes.length) {
    console.log(`content variant -> 'portfolio'  (${variantFixes.length})`)
    for (const f of variantFixes) console.log(`  ${f.slug.padEnd(28)} ${f.rows}`)
    console.log()
  }

  if (apply) {
    await em.flush()
    console.log('Applied. Those sites render Portfolio on their next load.')
  } else {
    console.log('Dry run — nothing written. Re-run with --apply to make these changes.')
  }

  await orm.close(true)
}

main().catch(e => { console.error(e); process.exit(1) })
