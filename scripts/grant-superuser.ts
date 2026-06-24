/**
 * Promote an owner account to superuser and (optionally) ensure a Site row
 * exists for it. Useful for bootstrapping platform-owned marketing sites
 * (e.g. the projects-ui catalog) that aren't created through the order flow.
 *
 * Usage (from archetype-service/):
 *   npx ts-node -r tsconfig-paths/register scripts/grant-superuser.ts \
 *     --email you@example.com \
 *     [--site-slug apotome-projects] \
 *     [--site-name "Apotome Projects"] \
 *     [--archetype keystone]
 *
 * Re-runnable: existing owner gets flipped to superuser, existing site gets
 * reassigned to that owner, missing rows are created.
 */
import 'dotenv/config'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import config from '../src/mikro-orm.config'
import { Owner } from '../src/entities/owner.entity'
import { Site } from '../src/entities/site.entity'

type Args = {
  email: string
  siteSlug?: string
  siteName?: string
  archetype: 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'
}

function parseArgs(): Args {
  const out: Partial<Args> = { archetype: 'keystone' }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--email': out.email = next(); break
      case '--site-slug': out.siteSlug = next(); break
      case '--site-name': out.siteName = next(); break
      case '--archetype': out.archetype = next() as Args['archetype']; break
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`)
    }
  }
  if (!out.email) throw new Error('Missing --email')
  return out as Args
}

async function main() {
  const args = parseArgs()
  const orm = await MikroORM.init<PostgreSqlDriver>(config)
  const em = orm.em.fork()

  try {
    let owner = await em.findOne(Owner, { email: args.email })
    if (!owner) {
      owner = em.create(Owner, { email: args.email, isSuperuser: true })
      console.log(`Created owner ${args.email} (${owner.id}) as superuser`)
    } else if (!owner.isSuperuser) {
      owner.isSuperuser = true
      console.log(`Promoted existing owner ${args.email} (${owner.id}) to superuser`)
    } else {
      console.log(`Owner ${args.email} (${owner.id}) is already a superuser`)
    }
    await em.persistAndFlush(owner)

    if (args.siteSlug) {
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
      console.log(`\nPoint the UI deployment at this site by setting:\n  VITE_SITE_ID=${site.id}`)
    }
  } finally {
    await orm.close(true)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
