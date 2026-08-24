import { Logger } from '@nestjs/common'
import type { MealOrder } from '../entities/meal-order.entity'
import type { PosConfig, Site } from '../entities/site.entity'
import { PosAuthError, type PosAdapter, type PosTokens } from './pos-provider'

/**
 * Clover adapter.
 *
 * OAuth: Clover's v2 flow issues a short-lived access token plus a refresh
 * token (the older v1 flow issued permanent tokens and no refresh token).
 * Clover appends `merchant_id` to the redirect, so the merchant is known
 * before we make a single API call.
 *
 * Regions matter: Clover runs separate stacks (US / EU / LATAM) and a token
 * minted on one is invalid on the others, so both hosts are env-driven.
 *   CLOVER_API_BASE    https://api.clover.com   (sandbox: https://apisandbox.dev.clover.com)
 *   CLOVER_OAUTH_BASE  https://www.clover.com   (sandbox: https://sandbox.dev.clover.com)
 *
 * Ticket printing: creating an order does NOT print anything. The kitchen
 * ticket comes from POSTing an order-level print event — that call is the
 * whole point of this integration for a restaurant.
 */
export class CloverAdapter implements PosAdapter {
  readonly id = 'clover' as const
  readonly label = 'Clover'
  private readonly logger = new Logger('CloverAdapter')

  private get apiBase(): string {
    return (process.env.CLOVER_API_BASE || 'https://api.clover.com').replace(/\/$/, '')
  }

  private get oauthBase(): string {
    return (process.env.CLOVER_OAUTH_BASE || 'https://www.clover.com').replace(/\/$/, '')
  }

  isConfigured(): boolean {
    return !!(process.env.CLOVER_APP_ID && process.env.CLOVER_APP_SECRET)
  }

  /**
   * Sandbox and production are entirely separate Clover stacks: sandbox apps,
   * merchants and logins do not exist in production and vice versa. Sending an
   * owner to the wrong one produces a bare "login failed" on Clover's page with
   * nothing in our logs, so refuse to build the URL when the two hosts disagree
   * — the usual cause is one of the two vars being unset in a deployment and
   * falling back to its production default.
   */
  private assertEnvConsistent(): void {
    const apiSandbox = /sandbox/i.test(this.apiBase)
    const oauthSandbox = /sandbox/i.test(this.oauthBase)
    if (apiSandbox !== oauthSandbox) {
      throw new Error(
        `Clover is half-configured: CLOVER_API_BASE (${this.apiBase}) and ` +
        `CLOVER_OAUTH_BASE (${this.oauthBase}) point at different Clover ` +
        'environments. Set BOTH to sandbox (https://apisandbox.dev.clover.com + ' +
        'https://sandbox.dev.clover.com) or BOTH to production ' +
        '(https://api.clover.com + https://www.clover.com).',
      )
    }
  }

  authorizeUrl(state: string, redirectUri: string): string {
    this.assertEnvConsistent()
    const params = new URLSearchParams({
      client_id: process.env.CLOVER_APP_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    })
    return `${this.oauthBase}/oauth/v2/authorize?${params.toString()}`
  }

  async exchangeCode(code: string, redirectUri: string, query: Record<string, string>): Promise<PosTokens> {
    const res = await fetch(`${this.apiBase}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.CLOVER_APP_ID,
        client_secret: process.env.CLOVER_APP_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    })
    const body = await res.text()
    if (!res.ok) {
      throw new PosAuthError(`Clover rejected the authorization code (${res.status}): ${body.slice(0, 300)}`)
    }
    return this.parseTokens(body, query.merchant_id)
  }

  async refresh(refreshToken: string): Promise<PosTokens> {
    const res = await fetch(`${this.apiBase}/oauth/v2/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: process.env.CLOVER_APP_ID, refresh_token: refreshToken }),
    })
    const body = await res.text()
    if (!res.ok) {
      throw new PosAuthError(`Clover refused to refresh the token (${res.status}): ${body.slice(0, 300)}`)
    }
    return this.parseTokens(body)
  }

  /** Clover reports both expiries as epoch SECONDS. */
  private parseTokens(body: string, merchantIdFromQuery?: string): PosTokens {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(body) as Record<string, unknown>
    } catch {
      throw new PosAuthError(`Clover returned a non-JSON token response: ${body.slice(0, 200)}`)
    }
    const accessToken = j.access_token as string | undefined
    if (!accessToken) {
      throw new PosAuthError(`Clover token response had no access_token: ${body.slice(0, 200)}`)
    }
    const at = (v: unknown): Date | undefined => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : undefined
    }
    return {
      accessToken,
      refreshToken: (j.refresh_token as string | undefined) ?? undefined,
      accessTokenExpiresAt: at(j.access_token_expiration),
      refreshTokenExpiresAt: at(j.refresh_token_expiration),
      merchantId: (j.merchant_id as string | undefined) ?? merchantIdFromQuery,
    }
  }

  async fetchMerchantName(t: { accessToken: string; merchantId: string }): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.apiBase}/v3/merchants/${encodeURIComponent(t.merchantId)}`, {
        headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json' },
      })
      if (!res.ok) {
        // Non-fatal for connecting, but a brand-new token that cannot read the
        // merchant is the first sign the app is missing permissions — which
        // will resurface later as a 401 when pushing an order.
        this.logger.warn(
          `Clover merchant lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}. ` +
          'The app may be missing "Merchant: read" permission.',
        )
        return undefined
      }
      const j = (await res.json()) as { name?: string }
      return j.name
    } catch (e) {
      this.logger.warn(`Clover merchant lookup errored: ${(e as Error).message}`)
      return undefined
    }
  }

  async pushOrder(args: {
    accessToken: string
    merchantId: string
    order: MealOrder
    site: Site
    config: Required<PosConfig>
    print: boolean
  }): Promise<{ posOrderId: string; printed: boolean; printError?: string }> {
    const { accessToken, merchantId, order, config, print } = args
    const base = `${this.apiBase}/v3/merchants/${encodeURIComponent(merchantId)}`
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }

    const call = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
      const res = await fetch(url, { ...init, headers })
      const text = await res.text()
      if (res.status === 401 || res.status === 403) {
        // Clover answers 401 both for a dead token AND for a live token whose
        // app lacks the permission for this endpoint. The body distinguishes
        // them, so never swallow it.
        const where = url.replace(this.apiBase, '')
        throw new PosAuthError(
          `Clover rejected ${init.method} ${where} (${res.status}): ${text.slice(0, 300) || '(empty body)'}. ` +
          'Either the connection needs re-authorising, or the Clover app is missing the ' +
          'permission for this endpoint (Orders read+write, Merchant read). Changing app ' +
          'permissions requires disconnecting and reconnecting to mint a new token.',
        )
      }
      if (!res.ok) {
        const where = url.replace(this.apiBase, '')
        throw new Error(`Clover ${init.method} ${where} failed (${res.status}): ${text.slice(0, 300)}`)
      }
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    }

    // 1. Order shell. `title` is what heads the printed ticket.
    const pickup = order.pickupAt
      ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(order.pickupAt)
      : ''
    const title = [config.titlePrefix, order.name, pickup && `- ${pickup}`].filter(Boolean).join(' ')
    const created = await call(`${base}/orders`, {
      method: 'POST',
      body: JSON.stringify({
        state: 'open',
        title: title.slice(0, 127),
        note: this.orderNote(order),
      }),
    })
    const posOrderId = created.id as string | undefined
    if (!posOrderId) throw new Error('Clover created the order but returned no id.')

    // 2. Line items, one call each. Clover has no bulk endpoint for ad-hoc
    //    (non-catalog) items, and an online order is exactly that. Quantity is
    //    expressed by repeating the line so each unit prints on its own row.
    for (const line of order.items) {
      for (let n = 0; n < line.quantity; n++) {
        await call(`${base}/orders/${posOrderId}/line_items`, {
          method: 'POST',
          body: JSON.stringify({
            name: line.name.slice(0, 127),
            price: line.unitPriceCents,
            note: line.notes ? line.notes.slice(0, 255) : undefined,
          }),
        })
      }
    }

    // 3. The call that actually prints the ticket.
    let printed = false
    let printError: string | undefined
    if (print) {
      try {
        await call(`${base}/print_event`, {
          method: 'POST',
          body: JSON.stringify({ orderRef: { id: posOrderId } }),
        })
        printed = true
      } catch (e) {
        // The order is in the POS either way — a printer problem must not
        // discard it. Report it so the dashboard can say "sent, but no ticket"
        // rather than claiming it printed.
        printError = this.explainPrintFailure((e as Error).message)
        this.logger.warn(`Clover print event failed for order ${order.id}: ${printError}`)
      }
    }

    return { posOrderId, printed, printError }
  }

  /**
   * Clover reports printing problems as terse server messages that mean nothing
   * to a restaurant owner. Translate the ones we have actually hit into the
   * action that fixes them; anything unrecognised passes through untouched so
   * we never hide a new failure behind a guess.
   *
   * "The default printing device is missing" is by far the common one. Clover
   * routes a print event to a printer owned by a registered Clover terminal —
   * a Station, Mini, Flex or Duo. A merchant with no terminal paired (or one
   * with no default order printer chosen on it) gets this even though the
   * order itself lands in Clover perfectly.
   */
  private explainPrintFailure(raw: string): string {
    if (/default printing device is missing/i.test(raw)) {
      return (
        'Clover has no default printer set for this merchant. On your Clover ' +
        'terminal open the Printers app, add or select your kitchen printer, ' +
        'and set it as the printer for online orders. Orders will keep arriving ' +
        'in Clover in the meantime — you can reprint them from there.'
      )
    }
    if (/printer.*(offline|not responding|unreachable)/i.test(raw)) {
      return (
        'Clover could not reach your kitchen printer — it looks powered off or ' +
        'off the network. Check the printer, then use Print again.'
      )
    }
    return raw
  }

  /** Customer context belongs on the ticket header, not in a line item. */
  private orderNote(order: MealOrder): string {
    return [
      `Online order ${order.id.slice(0, 8)}`,
      order.phone ? `Phone: ${order.phone}` : '',
      order.email ? `Email: ${order.email}` : '',
      order.notes ? `Notes: ${order.notes}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 255)
  }
}
