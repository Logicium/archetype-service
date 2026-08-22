import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { MealOrder } from '../entities/meal-order.entity'
import { PosConfig, PosProvider, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { CloverAdapter } from './clover.adapter'
import { resolvePosConfig } from './pos-config'
import { PosAuthError, type PosAdapter, type PosTokens } from './pos-provider'

/** Refresh this far ahead of expiry so a push never races the clock. */
const REFRESH_SKEW_MS = 5 * 60_000

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name)

  /** Registry. Adding Square/Toast means adding an adapter here. */
  private readonly adapters: PosAdapter[] = [new CloverAdapter()]

  constructor(
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    @InjectRepository(MealOrder) private readonly orders: EntityRepository<MealOrder>,
    private readonly em: EntityManager,
  ) {}

  adapterFor(provider: PosProvider): PosAdapter {
    const a = this.adapters.find(x => x.id === provider)
    if (!a) throw new BadRequestException(`Unsupported POS provider: ${provider}`)
    return a
  }

  /** Vendors this deployment can actually offer, for the dashboard picker. */
  listProviders() {
    return this.adapters.map(a => ({ id: a.id, label: a.label, configured: a.isConfigured() }))
  }

  async getOwnedSite(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId, owner: owner.id })
    if (!site) throw new NotFoundException('Site not found')
    return site
  }

  status(site: Site) {
    const cfg = resolvePosConfig(site.posConfig)
    const refreshDead = !!site.posRefreshTokenExpiresAt && site.posRefreshTokenExpiresAt.getTime() < Date.now()
    return {
      connected: !!site.posProvider && !!site.posAccessToken,
      provider: site.posProvider ?? null,
      merchantId: site.posMerchantId ?? null,
      merchantName: site.posMerchantName ?? null,
      connectedAt: site.posConnectedAt ?? null,
      accessTokenExpiresAt: site.posAccessTokenExpiresAt ?? null,
      /** True when the owner must reconnect — refresh token itself has died. */
      needsReconnect: refreshDead,
      config: cfg,
      providers: this.listProviders(),
    }
  }

  /** Persists a freshly-issued token set onto the site. */
  private applyTokens(site: Site, provider: PosProvider, t: PosTokens) {
    site.posProvider = provider
    site.posAccessToken = t.accessToken
    if (t.refreshToken) site.posRefreshToken = t.refreshToken
    site.posAccessTokenExpiresAt = t.accessTokenExpiresAt
    if (t.refreshTokenExpiresAt) site.posRefreshTokenExpiresAt = t.refreshTokenExpiresAt
    if (t.merchantId) site.posMerchantId = t.merchantId
  }

  async completeConnection(site: Site, provider: PosProvider, tokens: PosTokens): Promise<void> {
    this.applyTokens(site, provider, tokens)
    site.posConnectedAt = new Date()
    const adapter = this.adapterFor(provider)
    if (adapter.fetchMerchantName && site.posMerchantId) {
      site.posMerchantName = await adapter.fetchMerchantName({
        accessToken: tokens.accessToken,
        merchantId: site.posMerchantId,
      })
    }
    await this.em.persistAndFlush(site)
    this.logger.log(`POS connected: ${provider} -> site ${site.slug} (merchant ${site.posMerchantId ?? '?'})`)
  }

  async disconnect(site: Site): Promise<void> {
    site.posProvider = undefined
    site.posMerchantId = undefined
    site.posMerchantName = undefined
    site.posAccessToken = undefined
    site.posRefreshToken = undefined
    site.posAccessTokenExpiresAt = undefined
    site.posRefreshTokenExpiresAt = undefined
    site.posConnectedAt = undefined
    await this.em.persistAndFlush(site)
  }

  async saveConfig(site: Site, config: PosConfig | null): Promise<Required<PosConfig>> {
    site.posConfig = config ?? undefined
    await this.em.persistAndFlush(site)
    return resolvePosConfig(site.posConfig)
  }

  /**
   * Returns a usable access token, refreshing first when it is expired or
   * about to be. Throws PosAuthError when the owner has to reconnect.
   */
  private async freshAccessToken(site: Site): Promise<string> {
    if (!site.posProvider || !site.posAccessToken) {
      throw new PosAuthError('No POS is connected for this site.')
    }
    const expires = site.posAccessTokenExpiresAt?.getTime()
    if (!expires || expires - REFRESH_SKEW_MS > Date.now()) return site.posAccessToken

    const adapter = this.adapterFor(site.posProvider)
    if (!adapter.refresh || !site.posRefreshToken) {
      // Non-expiring token style, or nothing to refresh with.
      return site.posAccessToken
    }
    if (site.posRefreshTokenExpiresAt && site.posRefreshTokenExpiresAt.getTime() < Date.now()) {
      throw new PosAuthError('The POS connection has expired. Please reconnect from your dashboard.')
    }
    const tokens = await adapter.refresh(site.posRefreshToken)
    this.applyTokens(site, site.posProvider, tokens)
    await this.em.persistAndFlush(site)
    this.logger.log(`Refreshed ${site.posProvider} token for site ${site.slug}`)
    return tokens.accessToken
  }

  /**
   * Sends one meal order to the connected POS and records the outcome on the
   * order. Never throws: a POS problem must not fail a customer's checkout,
   * so the failure is stored and surfaced in the dashboard for a resend.
   */
  async pushOrder(order: MealOrder, site: Site, opts: { force?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    if (!site.posProvider || !site.posAccessToken) return { ok: false, error: 'No POS connected' }
    const cfg = resolvePosConfig(site.posConfig)
    if (!cfg.autoSend && !opts.force) return { ok: false, error: 'Auto-send is off' }
    if (order.posOrderId && !opts.force) return { ok: true }

    try {
      const accessToken = await this.freshAccessToken(site)
      const adapter = this.adapterFor(site.posProvider)
      const { posOrderId, printed, printError } = await adapter.pushOrder({
        accessToken,
        merchantId: site.posMerchantId ?? '',
        order,
        site,
        config: cfg,
        print: cfg.autoPrint,
      })
      order.posOrderId = posOrderId
      order.posSyncedAt = new Date()
      // The order IS in the POS, so this is not a sync failure — but if the
      // ticket did not print, the owner needs to know rather than see a
      // confident "Printed" badge while the kitchen has no paper.
      order.posSyncError = printError
        ? `Order reached ${site.posProvider}, but the kitchen ticket did not print: ${printError}`.slice(0, 1000)
        : undefined
      await this.em.persistAndFlush(order)
      this.logger.log(
        `Order ${order.id.slice(0, 8)} -> ${site.posProvider} order ${posOrderId}` +
        (cfg.autoPrint ? (printed ? ' (ticket printed)' : ' (TICKET DID NOT PRINT)') : ' (printing off)'),
      )
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      order.posSyncError = message.slice(0, 1000)
      await this.em.persistAndFlush(order).catch(() => { /* keep the original error */ })
      this.logger.error(`POS push failed for order ${order.id}: ${message}`)
      return { ok: false, error: message }
    }
  }

  /** Dashboard "send to POS" for one order (also used to retry a failure). */
  async resendOrder(siteId: string, owner: Owner, orderId: string) {
    const site = await this.getOwnedSite(siteId, owner)
    const order = await this.orders.findOne({ id: orderId, site: site.id })
    if (!order) throw new NotFoundException('Order not found')
    const res = await this.pushOrder(order, site, { force: true })
    if (!res.ok) throw new BadRequestException(res.error || 'Could not send the order to your POS')
    return { ok: true, posOrderId: order.posOrderId ?? null, posSyncedAt: order.posSyncedAt ?? null }
  }
}
