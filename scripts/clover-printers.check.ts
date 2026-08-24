/**
 * Read-only: asks Clover what printing hardware the connected merchant has.
 *
 * "Default printing device is missing" means the merchant has no printer/device
 * registered, so there is nothing for a print event to target. Run this before
 * and after attaching an emulator or Dev Kit to confirm it actually registered.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/clover-printers.check.ts [--slug mesa-site-5]
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
    console.error(slug ? `Site ${slug} has no Clover connection.` : 'No site has Clover connected.')
    await orm.close(true)
    process.exit(1)
  }

  const base = (process.env.CLOVER_API_BASE || 'https://api.clover.com').replace(/\/$/, '')
  const mId = encodeURIComponent(site.posMerchantId)
  const headers = { Authorization: `Bearer ${site.posAccessToken}`, Accept: 'application/json' }

  console.log(`\nsite     : ${site.slug}`)
  console.log(`merchant : ${site.posMerchantName || site.posMerchantId}`)
  console.log(`api base : ${base}\n`)

  const probe = async (label: string, path: string) => {
    try {
      const res = await fetch(`${base}${path}`, { headers })
      const text = await res.text()
      if (!res.ok) {
        console.log(`${label.padEnd(10)} ${res.status} ${text.slice(0, 160)}`)
        return
      }
      const j = JSON.parse(text) as { elements?: Array<Record<string, unknown>> }
      const items = j.elements ?? []
      if (!items.length) {
        console.log(`${label.padEnd(10)} none registered`)
        return
      }
      console.log(`${label.padEnd(10)} ${items.length} found:`)
      for (const it of items) {
        const bits = ['id', 'name', 'type', 'model', 'serial', 'deviceTypeName', 'ip']
          .filter(k => it[k] != null)
          .map(k => `${k}=${String(it[k])}`)
        console.log(`           - ${bits.join('  ')}`)
      }
    } catch (e) {
      console.log(`${label.padEnd(10)} error: ${(e as Error).message}`)
    }
  }

  await probe('printers', `/v3/merchants/${mId}/printers`)
  await probe('devices', `/v3/merchants/${mId}/devices`)
  await probe('order_types', `/v3/merchants/${mId}/order_types`)

  console.log('\nA print event needs at least one printer (or a device that owns one).')
  console.log('If both are empty, that is exactly why printing reports the default device is missing.\n')

  await orm.close(true)
}

main().catch(e => { console.error(e); process.exit(1) })
