/**
 * Polls an order (and its site) until provisioning settles, so a retry can be
 * confirmed without tailing service logs.
 *
 * Usage (from archetype-service/):
 *   npx ts-node -r tsconfig-paths/register scripts/watch-order.ts --id <ORDER_ID> [--seconds 180]
 */
import 'dotenv/config'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import config from '../src/mikro-orm.config'
import { Order } from '../src/entities/order.entity'
import { Site } from '../src/entities/site.entity'

function parseArgs() {
  const argv = process.argv.slice(2)
  let id = ''
  let seconds = 180
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') id = argv[++i] ?? ''
    else if (argv[i] === '--seconds') seconds = parseInt(argv[++i] ?? '180', 10) || 180
  }
  if (!id) { console.error('Usage: watch-order.ts --id <ORDER_ID> [--seconds N]'); process.exit(1) }
  return { id, seconds }
}

async function main() {
  const { id, seconds } = parseArgs()
  const orm = await MikroORM.init<PostgreSqlDriver>(config)
  const deadline = Date.now() + seconds * 1000
  let last = ''

  while (Date.now() < deadline) {
    const em = orm.em.fork()
    const order = await em.findOne(Order, { id })
    if (!order) { console.error('Order not found'); break }
    const site = order.siteId ? await em.findOne(Site, { id: order.siteId }) : null

    const line = [
      `status=${order.status}`,
      site ? `repo=${site.githubRepo ?? '-'}` : 'site=-',
      site ? `url=${site.vercelProductionUrl ?? '-'}` : '',
      order.failureReason ? `failure="${order.failureReason}"` : '',
    ].filter(Boolean).join('  ')

    if (line !== last) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
      last = line
    }
    if (order.status === 'live' || order.status === 'cancelled') break
    await new Promise(r => setTimeout(r, 5000))
  }

  await orm.close(true)
}

main().catch(e => { console.error(e); process.exit(1) })
