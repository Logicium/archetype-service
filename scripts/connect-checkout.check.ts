/**
 * Exercises the Mesa online-ordering payment path (Stripe Connect destination
 * charges) two ways:
 *
 *   npx ts-node -r tsconfig-paths/register scripts/connect-checkout.check.ts
 *     Stub mode. No database, no Stripe. Drives OrderingService against
 *     in-memory stand-ins and asserts the branching: pay-at-pickup fallback,
 *     Checkout session shape, hold expiry, the confirm step, and that emails
 *     and the kitchen ticket go out exactly once.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/connect-checkout.check.ts \
 *     --live --site-slug <slug> [--api http://localhost:3001] [--email you@example.com]
 *     Live mode. Talks to a RUNNING archetype-service over HTTP exactly like
 *     the storefront does: loads the menu + slots, places a checkout, prints
 *     the Stripe URL for you to pay with a test card, then polls the order
 *     until it flips to paid. Use a Stripe TEST key (sk_test_) in .env first.
 */
import { strict as assert } from 'node:assert'
import { OrderingService, type CreateMealOrderDto } from '../src/ordering/ordering.service'
import { CHECKOUT_HOLD_MINUTES } from '../src/ordering/ordering-config'
import type { MealOrder } from '../src/entities/meal-order.entity'

// ── Stub mode ───────────────────────────────────────────────────────────────

type Call = { kind: 'email' | 'pos' | 'stripe'; detail: unknown }

function makeWorld(opts: { chargesEnabled: boolean; collectPayment?: boolean; stripeConfigured?: boolean }) {
  const calls: Call[] = []
  const owner = {
    id: 'owner-1', email: 'owner@example.com', name: 'Taco Shop',
    stripeAccountId: opts.chargesEnabled ? 'acct_test' : undefined,
    stripeChargesEnabled: opts.chargesEnabled,
  }
  const site = {
    id: 'site-1', slug: 'taco', displayName: 'Taco Shop', owner,
    addOns: ['ordering'],
    vercelProductionUrl: 'https://taco.vercel.app',
    orderingConfig: { prepMinutes: 0, ...(opts.collectPayment === false ? { collectPayment: false } : {}) },
  }
  const menu = [
    { id: 'mi-1', sku: 'TACO', name: 'Street taco', priceCents: 350, currency: 'USD', active: true, site },
    { id: 'mi-2', sku: 'HORCH', name: 'Horchata', priceCents: 400, currency: 'USD', active: true, site },
  ]
  const store: MealOrder[] = []

  const items = { find: async (where: { id: { $in: string[] } }) => menu.filter(m => where.id.$in.includes(m.id)) }
  const orders = {
    find: async () => store,
    count: async () => 0,
    findOne: async (where: { id: string }) => store.find(o => o.id === where.id) ?? null,
  }
  const sites = { findOne: async () => site }
  const em = {
    create: (_e: unknown, data: Record<string, unknown>) => {
      const o = { id: `order-${store.length + 1}`, status: 'pending', paymentStatus: 'unpaid', createdAt: new Date(), ...data } as unknown as MealOrder
      store.push(o)
      return o
    },
    persistAndFlush: async () => undefined,
    flush: async () => undefined,
    nativeUpdate: async (_e: unknown, where: { id: string; paymentStatus: string }, data: Partial<MealOrder>) => {
      const o = store.find(x => x.id === where.id && x.paymentStatus === where.paymentStatus)
      if (!o) return 0
      Object.assign(o, data)
      return 1
    },
  }
  const email = { send: async (msg: { to: string; subject: string }) => { calls.push({ kind: 'email', detail: msg }) } }
  const pos = { pushOrder: async (o: MealOrder) => { calls.push({ kind: 'pos', detail: o.id }); return { ok: true } } }

  let sessionCounter = 0
  const stripeConfigured = opts.stripeConfigured ?? true
  const payments = {
    get stripeClient() {
      if (!stripeConfigured) return null
      return { checkout: { sessions: { retrieve: async (id: string) => ({ id, payment_status: 'paid', payment_intent: `pi_${id}` }) } } }
    },
    createDestinationCheckout: async (params: Record<string, unknown>) => {
      calls.push({ kind: 'stripe', detail: params })
      const o = params.owner as typeof owner
      if (!stripeConfigured || !o.stripeAccountId || !o.stripeChargesEnabled) return null
      sessionCounter += 1
      return { sessionId: `cs_test_${sessionCounter}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sessionCounter}` }
    },
  }

  const svc = new OrderingService(
    items as never, orders as never, sites as never, em as never, email as never, pos as never, payments as never,
  )
  return { svc, calls, store, owner, site }
}

function slotIso(): string {
  // Next 15-minute boundary at least 5 min out; prepMinutes is 0 in the stubs.
  const t = Math.ceil((Date.now() + 5 * 60_000) / 900_000) * 900_000
  return new Date(t).toISOString()
}

function dto(): CreateMealOrderDto {
  return {
    siteSlug: 'taco', name: 'Ada', email: 'ada@example.com', pickupAt: slotIso(),
    items: [{ menuItemId: 'mi-1', quantity: 2, notes: 'no onions' }, { menuItemId: 'mi-2', quantity: 1 }],
  }
}

async function stubChecks() {
  // A. Owner not onboarded: pay-at-pickup, fulfilled immediately.
  {
    const w = makeWorld({ chargesEnabled: false })
    const res = await w.svc.createCheckoutSession(dto(), 'http://localhost:5197', '/menu')
    assert.equal(res.checkoutUrl, null)
    assert.equal(res.order.paymentStatus, 'unpaid')
    assert.equal(res.order.totalCents, 1100)
    assert.equal(w.calls.filter(c => c.kind === 'email').length, 2, 'customer + owner email')
    assert.equal(w.calls.filter(c => c.kind === 'pos').length, 1, 'ticket printed once')
    console.log('ok  not onboarded -> pay at pickup, emailed + printed')
  }

  // B. Owner onboarded: Checkout session, nothing sent yet.
  {
    const w = makeWorld({ chargesEnabled: true })
    const before = Math.floor(Date.now() / 1000)
    const res = await w.svc.createCheckoutSession(dto(), 'http://localhost:5197', '/menu?x=1')
    assert.match(res.checkoutUrl ?? '', /^https:\/\/checkout\.stripe\.com\//)
    assert.equal(res.order.paymentStatus, 'awaiting')
    assert.equal(w.calls.filter(c => c.kind === 'email').length, 0, 'no email before payment')
    assert.equal(w.calls.filter(c => c.kind === 'pos').length, 0, 'no ticket before payment')

    const params = w.calls.find(c => c.kind === 'stripe')!.detail as Record<string, any>
    assert.equal(params.owner.stripeAccountId, 'acct_test')
    assert.equal(params.successUrl, `http://localhost:5197/menu?order=${res.orderId}&status=success`)
    assert.equal(params.cancelUrl, `http://localhost:5197/menu?order=${res.orderId}&status=cancelled`)
    assert.equal(params.customerEmail, 'ada@example.com')
    assert.deepEqual(params.metadata, { mealOrderId: res.orderId, siteId: 'site-1' })
    assert.deepEqual(params.lineItems.map((l: any) => [l.quantity, l.price_data.unit_amount, l.price_data.product_data.name]), [
      [2, 350, 'Street taco'], [1, 400, 'Horchata'],
    ])
    assert.equal(params.lineItems[0].price_data.product_data.description, 'no onions')
    assert.equal(params.lineItems[0].price_data.currency, 'usd')
    assert.ok(params.expiresAt >= before + CHECKOUT_HOLD_MINUTES * 60 - 1 && params.expiresAt <= before + CHECKOUT_HOLD_MINUTES * 60 + 5, 'hold matches session expiry')
    assert.ok(CHECKOUT_HOLD_MINUTES >= 30, 'Stripe minimum expiry is 30 minutes')
    console.log('ok  onboarded -> Checkout session with destination + metadata, nothing sent yet')

    // C. Confirm flips to paid and fulfils exactly once, even when the
    //    webhook and the redirect both arrive.
    const [a, b] = await Promise.all([w.svc.confirmCheckout(res.orderId), w.svc.confirmCheckout(res.orderId)])
    assert.equal(a.paymentStatus, 'paid')
    assert.equal(b.paymentStatus, 'paid')
    assert.equal(w.store[0].stripePaymentIntentId, 'pi_cs_test_1')
    assert.equal(w.calls.filter(c => c.kind === 'email').length, 2, 'emails once')
    assert.equal(w.calls.filter(c => c.kind === 'pos').length, 1, 'ticket once')
    await w.svc.confirmCheckout(res.orderId)
    assert.equal(w.calls.filter(c => c.kind === 'pos').length, 1, 'later confirm is a no-op')
    console.log('ok  confirm -> paid, fulfilled exactly once across webhook + redirect')
  }

  // D. Online payment switched off: pay-at-pickup even when onboarded.
  {
    const w = makeWorld({ chargesEnabled: true, collectPayment: false })
    const res = await w.svc.createCheckoutSession(dto(), 'http://localhost:5197', '/menu')
    assert.equal(res.checkoutUrl, null)
    assert.equal(w.calls.filter(c => c.kind === 'stripe').length, 0, 'Stripe never called')
    assert.equal(w.calls.filter(c => c.kind === 'pos').length, 1)
    console.log('ok  collectPayment=false -> pay at pickup, Stripe untouched')
  }

  // E. Stripe not configured at all: same fallback.
  {
    const w = makeWorld({ chargesEnabled: true, stripeConfigured: false })
    const res = await w.svc.createCheckoutSession(dto(), undefined, undefined)
    assert.equal(res.checkoutUrl, null)
    console.log('ok  Stripe unconfigured -> pay at pickup')
  }

  // F. Return path + origin sanitising.
  {
    const w = makeWorld({ chargesEnabled: true })
    const res = await w.svc.createCheckoutSession(dto(), 'javascript:alert(1)', '//evil.example/x')
    const params = w.calls.find(c => c.kind === 'stripe')!.detail as Record<string, any>
    assert.equal(params.successUrl, `https://taco.vercel.app/menu?order=${res.orderId}&status=success`, 'bad origin -> site URL, bad path -> /menu')
    console.log('ok  hostile origin / return path fall back to the site URL and /menu')
  }

  // G. The plain no-payment endpoint is unchanged.
  {
    const w = makeWorld({ chargesEnabled: true })
    const o = await w.svc.createOrder(dto())
    assert.equal(o.paymentStatus, 'unpaid')
    assert.equal(w.calls.filter(c => c.kind === 'stripe').length, 0)
    assert.equal(w.calls.filter(c => c.kind === 'pos').length, 1)
    console.log('ok  POST /ordering/orders still places a pay-at-pickup order')
  }
}

// ── Live mode ───────────────────────────────────────────────────────────────

async function live(args: { api: string; siteSlug: string; email: string }) {
  const api = args.api.replace(/\/$/, '') + '/v1'
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${api}${path}`)
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
    return r.json() as Promise<T>
  }
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const r = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5197' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
    return r.json() as Promise<T>
  }

  const menu = await get<{ items: Array<{ id: string; name: string; priceCents: number }> }>(`/ordering/menu?siteSlug=${encodeURIComponent(args.siteSlug)}`)
  const slots = await get<{ slots: string[] }>(`/ordering/slots?siteSlug=${encodeURIComponent(args.siteSlug)}`)
  if (!menu.items.length) throw new Error('Site has no active menu items')
  if (!slots.slots.length) throw new Error('Site has no open pickup slots right now (check hours/prep time)')
  const item = menu.items[0]
  console.log(`Site ${args.siteSlug}: ${menu.items.length} items, first slot ${slots.slots[0]}`)

  const res = await post<{ orderId: string; checkoutUrl: string | null; order: { paymentStatus: string; totalCents: number } }>('/ordering/checkout', {
    siteSlug: args.siteSlug, name: 'Connect Test', email: args.email, pickupAt: slots.slots[0],
    items: [{ menuItemId: item.id, quantity: 1 }], returnPath: '/menu',
  })
  console.log(`Order ${res.orderId} created; ${item.name}; total ${(res.order.totalCents / 100).toFixed(2)}; paymentStatus=${res.order.paymentStatus}`)

  if (!res.checkoutUrl) {
    console.log('No checkout URL: the owner cannot accept charges yet (or online payment is off). Finish Connect onboarding at /admin/payments and re-run.')
    return
  }
  console.log('\nPay here with Stripe test card 4242 4242 4242 4242 (any future date, any CVC):\n  ' + res.checkoutUrl + '\n')
  console.log(`Polling order ${res.orderId} for up to ${CHECKOUT_HOLD_MINUTES} minutes...`)
  const deadline = Date.now() + CHECKOUT_HOLD_MINUTES * 60_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    const o = await get<{ paymentStatus: string; status: string; posSyncError?: string | null; posOrderId?: string | null }>(`/ordering/orders/${res.orderId}`)
    if (o.paymentStatus === 'paid') {
      console.log(`\nok  Paid. status=${o.status} pos=${o.posOrderId ?? 'none'}${o.posSyncError ? ` posError=${o.posSyncError}` : ''}`)
      console.log('Now check: customer + owner emails arrived, the Stripe dashboard shows the payment with a transfer to the connected account, and /admin -> Ordering lists it as Paid.')
      return
    }
    process.stdout.write('.')
  }
  console.log('\nTimed out without payment. (If you paid, neither the webhook nor the redirect confirm landed; see the service log.)')
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  if (argv.includes('--live')) {
    const siteSlug = flag('--site-slug')
    if (!siteSlug) throw new Error('--live needs --site-slug <slug>')
    await live({ api: flag('--api') ?? 'http://localhost:3001', siteSlug, email: flag('--email') ?? 'connect-test@example.com' })
    return
  }
  await stubChecks()
  console.log('\nAll stub checks passed.')
}

main().catch(e => { console.error(e); process.exit(1) })
