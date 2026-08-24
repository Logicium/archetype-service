/**
 * Fires a real Clover print event for one order and reports exactly what the
 * cloud says. Use it to confirm ticket printing end-to-end against a merchant
 * that has a device attached (a Clover Station, or the Android emulator).
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/clover-print.check.ts --order 4PP99MNE4RWA6
 */
import 'dotenv/config'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import config from '../src/mikro-orm.config'
import { Site } from '../src/entities/site.entity'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const orm = await MikroORM.init<PostgreSqlDriver>(config)
  const em = orm.em.fork()
  const slug = arg('slug')
  const site = slug
    ? await em.findOne(Site, { slug })
    : await em.findOne(Site, { posProvider: 'clover' })

  if (!site?.posAccessToken || !site.posMerchantId) {
    console.error('No site has Clover connected.')
    await orm.close(true)
    process.exit(1)
  }

  const base = (process.env.CLOVER_API_BASE || 'https://api.clover.com').replace(/\/$/, '')
  const mId = encodeURIComponent(site.posMerchantId)
  const headers = {
    Authorization: `Bearer ${site.posAccessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  // Without --order, print the most recent order the merchant has.
  let orderId = arg('order')
  if (!orderId && process.argv.includes('--create')) {
    // A brand-new order, so device-side auto-firing has something fresh to
    // react to rather than an order it has already seen and dismissed.
    const mk = async (path: string, body: unknown) => {
      const r = await fetch(`${base}/v3/merchants/${mId}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      const t = await r.text()
      if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${t.slice(0, 200)}`)
      return JSON.parse(t) as { id: string }
    }
    const o = await mk('/orders', { state: 'open', title: 'ONLINE Print Test', note: 'Fired from clover-print.check' })
    await mk(`/orders/${o.id}/line_items`, { name: 'Green Chili Turkey', price: 1200 })
    orderId = o.id
    console.log(`created order ${orderId}`)
  }
  if (!orderId) {
    const res = await fetch(`${base}/v3/merchants/${mId}/orders?limit=1&orderBy=createdTime%20DESC`, { headers })
    const j = (await res.json()) as { elements?: Array<{ id: string }> }
    orderId = j.elements?.[0]?.id
    if (!orderId) {
      console.error('That merchant has no orders to print.')
      await orm.close(true)
      process.exit(1)
    }
  }

  console.log(`\nmerchant : ${site.posMerchantName || site.posMerchantId}`)
  console.log(`order    : ${orderId}`)
  console.log(`api base : ${base}\n`)

  const res = await fetch(`${base}/v3/merchants/${mId}/print_event`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ orderRef: { id: orderId } }),
  })
  const text = await res.text()
  console.log(`POST /print_event -> ${res.status}`)
  console.log(text.slice(0, 500) || '(empty body)')

  if (res.ok) {
    console.log('\nAccepted. The ticket prints on the merchant device, not here.')
  } else {
    console.log('\nRejected. "default printing device is missing" means the merchant has no')
    console.log('device with a default order printer — attach one in the Printers app.')
  }

  await orm.close(true)
}

main().catch(e => { console.error(e); process.exit(1) })
