/**
 * Exercises the dynamic-CORS origin logic against a stub database: which
 * origins a site grants, when the cache re-reads, and that saving a domain
 * takes effect immediately. No live database, no test rows.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/cors-origins.check.ts
 */
import { SitesService } from '../src/sites/sites.service'

type Row = { customDomain?: string; vercelProductionUrl?: string; status: string }

/** Minimal stand-in for the bits of EntityManager that readOrigins() touches. */
function stubEm(rows: () => Row[], onFind: () => void) {
  const em = {
    fork() {
      return {
        async find(_entity: unknown, where: { status?: { $ne?: string } }) {
          onFind()
          const excluded = where?.status?.$ne
          return rows().filter(r => r.status !== excluded)
        },
      }
    },
  }
  return em
}

/**
 * Prints the origins the real database currently grants — the first thing to
 * check when an owner reports their domain is blocked.
 */
async function live() {
  await import('dotenv/config')
  const { MikroORM } = await import('@mikro-orm/core')
  const { PostgreSqlDriver } = await import('@mikro-orm/postgresql')
  const config = (await import('../src/mikro-orm.config')).default
  const { Site } = await import('../src/entities/site.entity')

  const orm = await MikroORM.init<InstanceType<typeof PostgreSqlDriver>>(config)
  const svc = new SitesService(null as never, null as never, orm.em as never)
  await svc.refreshOrigins()

  const rows = await orm.em.fork().find(Site, {}, { fields: ['slug', 'status', 'customDomain', 'vercelProductionUrl'] })
  console.log('\nsite                 status        domain / vercel url')
  for (const s of rows) {
    const addr = [s.customDomain, s.vercelProductionUrl].filter(Boolean).join('  +  ') || '(none)'
    console.log(`${s.slug.padEnd(20)} ${s.status.padEnd(13)} ${addr}`)
  }

  console.log('\norigins CORS will accept:')
  for (const o of [...(svc as unknown as { originCache: Set<string> }).originCache].sort()) {
    console.log(`  ${o}`)
  }
  const probe = process.argv[process.argv.indexOf('--origin') + 1]
  if (process.argv.includes('--origin') && probe) {
    console.log(`\n${probe} -> ${(await svc.isSiteOrigin(probe.toLowerCase())) ? 'ALLOWED' : 'BLOCKED'}`)
  }
  await orm.close(true)
}

async function main() {
  if (process.argv.includes('--live')) return live()
  const results: Array<{ n: string; ok: boolean; info?: string }> = []
  const check = (n: string, ok: boolean, info?: string) => results.push({ n, ok, info })

  let rows: Row[] = [
    { customDomain: 'goodeats.cafe', vercelProductionUrl: 'mesa-site-5.vercel.app', status: 'live' },
    { customDomain: 'oldplace.com', status: 'archived' },
    { vercelProductionUrl: 'https://half-built.vercel.app/', status: 'provisioning' },
  ]
  let finds = 0
  const svc = new SitesService(
    null as never,
    null as never,
    stubEm(() => rows, () => { finds++ }) as never,
  )

  await svc.refreshOrigins()

  check('apex custom domain is allowed', await svc.isSiteOrigin('https://goodeats.cafe'))
  check('www of a custom domain is allowed', await svc.isSiteOrigin('https://www.goodeats.cafe'))
  check('the site\'s vercel URL is allowed', await svc.isSiteOrigin('https://mesa-site-5.vercel.app'))
  check('a scheme/slash in vercelProductionUrl is normalised away',
    await svc.isSiteOrigin('https://half-built.vercel.app'))
  check('a site still provisioning is not locked out',
    await svc.isSiteOrigin('https://half-built.vercel.app'))
  check('an archived site grants nothing', !(await svc.isSiteOrigin('https://oldplace.com')))
  check('an unrelated origin is refused', !(await svc.isSiteOrigin('https://evil.example')))

  // A domain saved just now must work on the first try, not after the TTL.
  rows = [...rows, { customDomain: 'brandnew.shop', status: 'live' }]
  svc.invalidateOrigins()
  check('a domain saved seconds ago is accepted immediately',
    await svc.isSiteOrigin('https://brandnew.shop'))
  check('and its www host too', await svc.isSiteOrigin('https://www.brandnew.shop'))

  // Repeated misses must not re-read the table every single preflight.
  finds = 0
  for (let i = 0; i < 25; i++) await svc.isSiteOrigin('https://flood.example')
  check('a flood of unknown origins does not hammer the database',
    finds <= 1, `${finds} queries for 25 preflights`)

  // A database outage must not lock every customer out of their own site.
  const boom = new SitesService(
    null as never,
    null as never,
    { fork() { return { async find() { throw new Error('db down') } } } } as never,
  )
  await boom.refreshOrigins()
  let threw = false
  try {
    await boom.isSiteOrigin('https://goodeats.cafe')
  } catch {
    threw = true
  }
  check('a database outage degrades quietly instead of throwing', !threw)

  let pass = 0
  for (const r of results) {
    if (r.ok) pass++
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${!r.ok && r.info ? `\n        got: ${r.info}` : ''}`)
  }
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
