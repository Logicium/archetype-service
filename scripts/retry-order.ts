/**
 * Re-run provisioning for an order that failed, without going through the HTTP
 * API (no login required). Mirrors OrdersService.retryProvisioning: resets the
 * order to `paid`, clears the failure reason, and re-enqueues the provisioning
 * job — but skips the owner check, since running this script already implies
 * operator access.
 *
 * Intended for the Render shell, where DATABASE_URL / REDIS_URL are already set.
 *
 * Usage (from archetype-service/):
 *   npx ts-node -r tsconfig-paths/register scripts/retry-order.ts --id <ORDER_ID>
 *   npx ts-node -r tsconfig-paths/register scripts/retry-order.ts --id <ORDER_ID> --dry-run
 *
 * Safe to re-run: BullMQ dedupes by job id, and any existing job for this order
 * is removed first so a previously failed job cannot block the retry.
 */
import 'dotenv/config'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import { Queue } from 'bullmq'
import config from '../src/mikro-orm.config'
import { Order } from '../src/entities/order.entity'
import { PROVISION_QUEUE, PROVISION_JOB } from '../src/provisioning/provisioning.constants'

function parseArgs(): { id: string; dryRun: boolean } {
  const argv = process.argv.slice(2)
  let id = ''
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') id = argv[++i] ?? ''
    else if (argv[i] === '--dry-run') dryRun = true
  }
  if (!id) {
    console.error('Usage: retry-order.ts --id <ORDER_ID> [--dry-run]')
    process.exit(1)
  }
  return { id, dryRun }
}

async function main() {
  const { id, dryRun } = parseArgs()

  const orm = await MikroORM.init<PostgreSqlDriver>(config)
  const em = orm.em.fork()

  const order = await em.findOne(Order, { id }, { populate: ['owner'] as never })
  if (!order) {
    console.error(`Order ${id} not found.`)
    await orm.close(true)
    process.exit(1)
  }

  console.log('Order      :', order.id)
  console.log('Owner      :', (order as unknown as { owner?: { email?: string } }).owner?.email ?? '(unknown)')
  console.log('Archetype  :', order.archetype)
  console.log('Plan       :', order.plan, order.addOns?.length ? `+ ${order.addOns.join(', ')}` : '')
  console.log('Status     :', order.status)
  console.log('Site id    :', order.siteId ?? '(none yet)')
  console.log('Failure    :', order.failureReason ?? '(none)')

  if (!['failed', 'paid', 'provisioning'].includes(order.status)) {
    console.error(`\nRefusing to retry from status "${order.status}". ` +
      'Only failed / paid / provisioning orders can be retried.')
    await orm.close(true)
    process.exit(1)
  }

  if (dryRun) {
    console.log('\n--dry-run: no changes written, no job enqueued.')
    await orm.close(true)
    return
  }

  order.status = 'paid'
  order.failureReason = undefined
  await em.persistAndFlush(order)

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
  const queue = new Queue(PROVISION_QUEUE, {
    connection: { url: redisUrl, maxRetriesPerRequest: null, enableReadyCheck: false } as never,
  })

  // BullMQ dedupes by jobId: a prior completed/failed job with the same id
  // would silently drop this re-enqueue, so clear it first.
  const jobId = `provision-${order.id}`
  const existing = await queue.getJob(jobId)
  if (existing) {
    await existing.remove().catch((e: unknown) =>
      console.warn(`Could not remove existing job ${jobId}: ${(e as Error).message}`))
    console.log(`Removed previous queue job ${jobId}`)
  }

  await queue.add(
    PROVISION_JOB,
    { orderId: order.id },
    { jobId, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
  )

  console.log(`\nRe-queued provisioning as ${jobId}.`)
  console.log('Watch the service logs; the worker picks it up within a few seconds.')

  await queue.close()
  await orm.close(true)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
