/**
 * Exercises the real CloverAdapter against a stub Clover server: request
 * shapes, token parsing, quantity expansion, and the print event — without
 * touching a live merchant.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/clover-adapter.check.ts
 */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

type Call = { method?: string; url?: string; body: Record<string, unknown> | null; auth?: string }

async function main() {
  const calls: Call[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization })
      const send = (o: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
      const url = req.url ?? ''
      if (url === '/oauth/v2/token') {
        return send({
          access_token: 'AT-1',
          refresh_token: 'RT-1',
          access_token_expiration: Math.floor(Date.now() / 1000) + 3600,
          refresh_token_expiration: Math.floor(Date.now() / 1000) + 86400,
          merchant_id: 'MERCH1',
        })
      }
      if (url.endsWith('/print_event')) return send({ id: 'PE-1' })
      if (url.includes('/line_items')) return send({ id: 'LI-' + calls.length })
      if (url.endsWith('/orders')) return send({ id: 'ORD-9' })
      if (url.startsWith('/v3/merchants/')) return send({ name: 'Big Momma’s Food Truck' })
      res.writeHead(404); res.end('{}')
    })
  })

  await new Promise<void>(r => server.listen(0, () => r()))
  const port = (server.address() as AddressInfo).port
  process.env.CLOVER_API_BASE = `http://127.0.0.1:${port}`
  process.env.CLOVER_OAUTH_BASE = `http://127.0.0.1:${port}`
  process.env.CLOVER_APP_ID = 'APPID'
  process.env.CLOVER_APP_SECRET = 'SECRET'

  const { CloverAdapter } = await import('../src/pos/clover.adapter')
  const clover = new CloverAdapter()

  const results: Array<{ n: string; ok: boolean; info?: string }> = []
  const check = (n: string, ok: boolean, info?: string) => results.push({ n, ok, info })

  // 1. Authorize URL
  const url = new URL(clover.authorizeUrl('STATE123', 'https://api.example.com/v1/pos/callback'))
  check('authorize URL carries client_id, redirect_uri and state',
    url.searchParams.get('client_id') === 'APPID' &&
    url.searchParams.get('state') === 'STATE123' &&
    url.searchParams.get('redirect_uri') === 'https://api.example.com/v1/pos/callback' &&
    url.pathname === '/oauth/v2/authorize')

  // 2. Token exchange — epoch seconds must become real Dates
  const tokens = await clover.exchangeCode('CODE', 'https://api.example.com/v1/pos/callback', { merchant_id: 'MERCH1' })
  check('exchangeCode returns access + refresh tokens', tokens.accessToken === 'AT-1' && tokens.refreshToken === 'RT-1')
  check('epoch-second expiries parse to future Dates',
    !!tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt > new Date() &&
    !!tokens.refreshTokenExpiresAt && tokens.refreshTokenExpiresAt > tokens.accessTokenExpiresAt)
  check('merchant id captured from the callback query', tokens.merchantId === 'MERCH1')

  // 3. Merchant name
  const name = await clover.fetchMerchantName({ accessToken: 'AT-1', merchantId: 'MERCH1' })
  check('merchant name fetched for the dashboard', name === 'Big Momma’s Food Truck', String(name))

  // 4. Push an order (qty 2 + item note)
  calls.length = 0
  const order = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'Jane D.',
    email: 'j@example.com',
    phone: '555-0100',
    notes: 'No onions',
    pickupAt: new Date('2026-08-18T17:30:00Z'),
    items: [
      { menuItemId: 'm1', sku: 'BRG', name: 'Smash Burger', unitPriceCents: 1200, quantity: 2, lineTotalCents: 2400, notes: 'well done' },
      { menuItemId: 'm2', sku: 'FRY', name: 'Fries', unitPriceCents: 450, quantity: 1, lineTotalCents: 450 },
    ],
  }
  const cfg = { autoSend: true, autoPrint: true, titlePrefix: 'ONLINE' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { posOrderId, printed: printedOk } = await clover.pushOrder({ accessToken: 'AT-1', merchantId: 'MERCH1', order: order as any, site: {} as any, config: cfg, print: true })
  check('pushOrder returns the POS order id', posOrderId === 'ORD-9')
  check('successful print is reported as printed: true', printedOk === true)

  const orderCall = calls.find(c => c.url === '/v3/merchants/MERCH1/orders')
  const title = String(orderCall?.body?.title ?? '')
  check('order created open, with a prefixed ticket title', orderCall?.body?.state === 'open' && title.startsWith('ONLINE Jane D.'), title)
  const note = String(orderCall?.body?.note ?? '')
  check('customer contact rides on the ticket note', note.includes('555-0100') && note.includes('No onions'), note)

  const lineCalls = calls.filter(c => (c.url ?? '').includes('/line_items'))
  check('quantity 2 becomes two ticket rows (3 lines total)', lineCalls.length === 3, `got ${lineCalls.length}`)
  check('line items send UNIT price in cents, not the line total',
    lineCalls[0]?.body?.price === 1200 && lineCalls[2]?.body?.price === 450,
    JSON.stringify(lineCalls.map(c => c.body?.price)))
  check('per-item note preserved', lineCalls[0]?.body?.note === 'well done')

  const printCall = calls.find(c => (c.url ?? '').endsWith('/print_event'))
  check('PRINT EVENT fired for the new order (this is what prints the ticket)',
    !!printCall && (printCall.body?.orderRef as { id?: string } | undefined)?.id === 'ORD-9')
  check('every call is bearer-authorised', calls.every(c => c.auth === 'Bearer AT-1'))

  // 5. Printer down: order must still land in the POS.
  calls.length = 0
  let printerDownThrew = false
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/print_event')) return new Response('printer offline', { status: 500 })
    return origFetch(input, init)
  }) as typeof fetch
  try {
    const r = await clover.pushOrder({ accessToken: 'AT-1', merchantId: 'MERCH1', order: order as any, site: {} as any, config: cfg, print: true })
    check('a printer failure does NOT lose the order (still returns its id)', r.posOrderId === 'ORD-9')
    check('a printer failure is REPORTED, not silently swallowed', r.printed === false && !!r.printError, JSON.stringify({ printed: r.printed, printError: r.printError?.slice(0, 60) }))
  } catch {
    printerDownThrew = true
  } finally {
    globalThis.fetch = origFetch
  }
  check('printer failure never throws out of pushOrder', !printerDownThrew)

  // 6. Expired credentials must be distinguishable from a transient failure.
  globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
  let authErrName = ''
  try {
    await clover.pushOrder({ accessToken: 'BAD', merchantId: 'MERCH1', order: order as any, site: {} as any, config: cfg, print: false })
  } catch (e) {
    authErrName = (e as Error).name
  } finally {
    globalThis.fetch = origFetch
  }
  check('401 from Clover raises PosAuthError (owner must reconnect)', authErrName === 'PosAuthError', authErrName)

  server.close()
  let pass = 0
  for (const r of results) {
    if (r.ok) pass++
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${!r.ok && r.info ? `\n        got: ${r.info}` : ''}`)
  }
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
