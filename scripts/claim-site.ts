/**
 * Ensure a Site row exists for a UI deployment that wasn't created through
 * the order/provisioning flow (e.g. the projects-ui marketing site), and
 * assign it to an existing owner account so that owner can manage it from
 * the regular admin UI.
 *
 * Usage (from archetype-service/):
 *   npx ts-node -r tsconfig-paths/register scripts/claim-site.ts \
 *     --email you@example.com \
 *     --site-slug apotome-projects \
 *     [--site-name "Apotome Projects"] \
 *     [--archetype keystone]
 *
 * Re-runnable: existing site gets reassigned, missing rows are created.
 * The owner account must already exist (sign in once via /admin/login first).
 */
import 'dotenv/config'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import config from '../src/mikro-orm.config'
import { Owner } from '../src/entities/owner.entity'
import { Site } from '../src/entities/site.entity'

type Archetype = 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'

function parseArgs() {
  const out: { email?: string; siteSlug?: string; siteName?: string; archetype: Archetype } =
    { archetype: 'keystone' }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--email': out.email = next(); break
      case '--site-slug': out.siteSlug = next(); break
      case '--site-name': out.siteName = next(); break
      case '--archetype': out.archetype = next() as Archetype; break
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`)
    }
  }
  if (!out.email) throw new Error('Missing --email')
  if (!out.siteSlug) throw new Error('Missing --site-slug')
  return out as Required<Pick<typeof out, 'email' | 'siteSlug' | 'archetype'>> & { siteName?: string }
}

async function main() {
  const args = parseArgs()
  const orm = await MikroORM.init<PostgreSqlDriver>(config)
  const em = orm.em.fork()

  try {
    const owner = await em.findOne(Owner, { email: args.email })
    if (!owner) {
      throw new Error(`No owner found for ${args.email}. Sign in once at /admin/login first.`)
    }

    let site = await em.findOne(Site, { slug: args.siteSlug }, { populate: ['owner'] })
    if (!site) {
      site = em.create(Site, {
        slug: args.siteSlug,
        displayName: args.siteName ?? args.siteSlug,
        archetype: args.archetype,
        owner,
        addOns: [],
      })
      await em.persistAndFlush(site)
      console.log(`Created site "${args.siteSlug}" (${site.id}) owned by ${args.email}`)
    } else {
      let changed = false
      if (site.owner?.id !== owner.id) { site.owner = owner; changed = true }
      if (args.siteName && site.displayName !== args.siteName) { site.displayName = args.siteName; changed = true }
      if (changed) {
        await em.persistAndFlush(site)
        console.log(`Updated site "${args.siteSlug}" (${site.id}) — owner = ${args.email}`)
      } else {
        console.log(`Site "${args.siteSlug}" (${site.id}) already owned by ${args.email}`)
      }
    }

    console.log(
      `\nDone. Sign in at /admin and "${args.siteSlug}" will appear in the site` +
      `\nswitcher. No env var changes needed for admin access.` +
      `\n\n(Optional: set VITE_SITE_ID=${site.id} in the UI's .env if you also want` +
      `\nthe public page to hydrate its published content from the DB at runtime.)`,
    )
  } finally {
    await orm.close(true)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
