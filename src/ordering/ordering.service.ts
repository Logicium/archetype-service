import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { MenuItem } from '../entities/menu-item.entity'
import { MealOrder, MealOrderLine } from '../entities/meal-order.entity'
import { OrderingConfig, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'
import { PosService } from '../pos/pos.service'
import { PaymentsService } from '../payments/payments.service'
import { CHECKOUT_HOLD_MINUTES, generateOrderingSlots, resolveOrderingConfig, snapToSlot } from './ordering-config'

/** Returns the `scheme://host` of a trusted origin, or undefined if invalid. */
function sanitizeOrigin(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined
  }
}

/** A same-site path the storefront wants Stripe to send the customer back to. */
function sanitizeReturnPath(raw?: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/menu'
  return raw.split(/[?#]/)[0] || '/menu'
}

export interface CreateMealOrderDto {
  siteSlug: string
  name: string
  email: string
  phone?: string
  notes?: string
  pickupAt: string // ISO
  items: Array<{ menuItemId: string; quantity: number; notes?: string }>
}

export interface MenuItemInput {
  sku: string
  name: string
  description?: string
  priceCents: number
  currency?: string
  category?: string
  imageUrl?: string
  active?: boolean
  sortOrder?: number
}

@Injectable()
export class OrderingService {
  private readonly logger = new Logger(OrderingService.name)

  constructor(
    @InjectRepository(MenuItem) private readonly items: EntityRepository<MenuItem>,
    @InjectRepository(MealOrder) private readonly orders: EntityRepository<MealOrder>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly email: EmailService,
    private readonly pos: PosService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Orders that occupy a pickup slot: anything live, except unpaid Stripe
   * checkouts whose session has expired — those are abandoned carts and must
   * not block the slot for the next customer.
   */
  private liveOrderWhere() {
    const holdCutoff = new Date(Date.now() - CHECKOUT_HOLD_MINUTES * 60_000)
    return {
      status: { $in: ['pending', 'confirmed', 'ready'] as MealOrder['status'][] },
      $or: [
        { paymentStatus: { $ne: 'awaiting' as const } },
        { createdAt: { $gte: holdCutoff } },
      ],
    }
  }

  // ----- Public -----

  async listPublicMenu(siteSlug: string) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    const config = resolveOrderingConfig(site.orderingConfig)
    const all = await this.items.find({ site, active: true }, { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } })
    return {
      currency: config.currency,
      categories: [...new Set(all.map(i => i.category).filter(Boolean))],
      items: all.map(i => this.publicItem(i)),
    }
  }

  async listSlots(siteSlug: string) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    const config = resolveOrderingConfig(site.orderingConfig)

    const windowEnd = new Date(Date.now() + (config.windowDays + 1) * 86400_000)
    const upcoming = await this.orders.find({
      site,
      ...this.liveOrderWhere(),
      pickupAt: { $gte: new Date(), $lte: windowEnd },
    })
    const countByStart = new Map<string, number>()
    for (const o of upcoming) {
      const key = o.pickupAt.toISOString()
      countByStart.set(key, (countByStart.get(key) ?? 0) + 1)
    }

    const slots = generateOrderingSlots({ config, existingByStart: countByStart })
    return {
      timezone: config.timezone,
      currency: config.currency,
      slotMinutes: config.slotMinutes,
      slots: slots.map(s => s.toISOString()),
    }
  }

  /**
   * Validates the cart and pickup slot, snapshots prices, and persists the
   * order. Shared by the pay-at-pickup and Stripe paths; sends nothing.
   */
  private async buildOrder(dto: CreateMealOrderDto) {
    const site = await this.sites.findOne({ slug: dto.siteSlug }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (!site.addOns?.includes('ordering')) throw new ForbiddenException('Ordering not enabled for this site')
    const config = resolveOrderingConfig(site.orderingConfig)

    if (!dto.items?.length) throw new BadRequestException('Order is empty')
    const pickupAt = new Date(dto.pickupAt)
    if (isNaN(pickupAt.getTime())) throw new BadRequestException('Invalid pickupAt')
    const snapped = snapToSlot(pickupAt, config.slotMinutes)
    if (snapped.getTime() !== pickupAt.getTime()) {
      throw new BadRequestException(`pickupAt must align to ${config.slotMinutes}-minute slots`)
    }
    const earliest = new Date(Date.now() + config.prepMinutes * 60_000)
    if (pickupAt < earliest) throw new BadRequestException(`Pickup needs at least ${config.prepMinutes} minutes prep`)

    // Capacity check.
    const sameSlot = await this.orders.count({
      site,
      pickupAt,
      ...this.liveOrderWhere(),
    })
    if (sameSlot >= config.maxOrdersPerSlot) throw new BadRequestException('That pickup slot is full')

    const wanted = new Map<string, { qty: number; notes?: string }>()
    for (const it of dto.items) {
      if (!it.menuItemId || it.quantity < 1) throw new BadRequestException('Invalid order line')
      const existing = wanted.get(it.menuItemId)
      if (existing) existing.qty += Math.floor(it.quantity)
      else wanted.set(it.menuItemId, { qty: Math.floor(it.quantity), notes: it.notes })
    }

    const itemList = await this.items.find({ id: { $in: [...wanted.keys()] }, site, active: true })
    if (itemList.length !== wanted.size) throw new BadRequestException('One or more items are unavailable')

    const lines: MealOrderLine[] = []
    let subtotalCents = 0
    for (const mi of itemList) {
      const entry = wanted.get(mi.id)!
      const lineTotal = mi.priceCents * entry.qty
      lines.push({
        menuItemId: mi.id,
        sku: mi.sku,
        name: mi.name,
        unitPriceCents: mi.priceCents,
        quantity: entry.qty,
        lineTotalCents: lineTotal,
        notes: entry.notes,
      })
      subtotalCents += lineTotal
    }

    const order = this.em.create(MealOrder, {
      site,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      notes: dto.notes,
      pickupAt,
      items: lines,
      subtotalCents,
      totalCents: subtotalCents,
      currency: config.currency,
    })
    await this.em.persistAndFlush(order)

    return { order, site, config }
  }

  /**
   * Emails both parties and prints the kitchen ticket. Runs once per order:
   * immediately for pay-at-pickup, or when Stripe confirms payment.
   * pushOrder never throws and records its own failure on the order, so a
   * POS outage cannot fail the customer's checkout — the dashboard shows the
   * error and offers a resend.
   */
  private async fulfilPlacedOrder(order: MealOrder, site: Site, config: Required<OrderingConfig>) {
    await this.sendOrderEmails(order, site, config).catch(e =>
      this.logger.error(`Meal order email failed: ${(e as Error).message}`),
    )
    await this.pos.pushOrder(order, site)
  }

  /** Pay-at-pickup order (owner not payment-onboarded, online payment off, or demo). */
  async createOrder(dto: CreateMealOrderDto) {
    const { order, site, config } = await this.buildOrder(dto)
    await this.fulfilPlacedOrder(order, site, config)
    return this.publicOrder(order)
  }

  /**
   * Create a pending order and a Stripe Checkout session that settles to the
   * site owner's Connect account. Falls back to a pay-at-pickup order (with
   * `checkoutUrl: null`) when the owner can't accept charges yet, Stripe isn't
   * configured, or the site has turned online payment off — the storefront
   * then shows its ordinary confirmation.
   */
  async createCheckoutSession(dto: CreateMealOrderDto, origin?: string, returnPath?: string) {
    const { order, site, config } = await this.buildOrder(dto)

    if (!config.collectPayment) {
      await this.fulfilPlacedOrder(order, site, config)
      return { orderId: order.id, checkoutUrl: null as string | null, order: this.publicOrder(order) }
    }

    const base = sanitizeOrigin(origin)
      || site.vercelProductionUrl
      || process.env.PUBLIC_APP_URL
      || 'http://localhost:5173'
    const path = sanitizeReturnPath(returnPath)
    const cleanBase = base.replace(/\/$/, '')
    const successUrl = `${cleanBase}${path}?order=${order.id}&status=success`
    const cancelUrl = `${cleanBase}${path}?order=${order.id}&status=cancelled`

    const lineItems = order.items.map(i => ({
      quantity: i.quantity,
      price_data: {
        currency: config.currency.toLowerCase(),
        product_data: { name: i.name, ...(i.notes ? { description: i.notes.slice(0, 500) } : {}) },
        unit_amount: i.unitPriceCents,
      },
    }))

    const checkout = await this.payments.createDestinationCheckout({
      owner: site.owner,
      lineItems,
      successUrl,
      cancelUrl,
      customerEmail: order.email,
      metadata: { mealOrderId: order.id, siteId: site.id },
      expiresAt: Math.floor(Date.now() / 1000) + CHECKOUT_HOLD_MINUTES * 60,
    }).catch(e => {
      this.logger.warn(`Meal checkout session failed, falling back to pay-at-pickup: ${(e as Error).message}`)
      return null
    })

    if (!checkout) {
      await this.fulfilPlacedOrder(order, site, config)
      return { orderId: order.id, checkoutUrl: null as string | null, order: this.publicOrder(order) }
    }

    order.paymentStatus = 'awaiting'
    if (checkout.provider === 'square') order.squareOrderId = checkout.squareOrderId
    else order.stripeSessionId = checkout.stripeSessionId
    await this.em.persistAndFlush(order)
    return { orderId: order.id, checkoutUrl: checkout.url, order: this.publicOrder(order) }
  }

  /**
   * Verify the hosted checkout (Stripe session or Square order) and mark the
   * order paid. Reached from the storefront success redirect AND the provider
   * webhook; idempotent,
   * so whichever lands first does the work and the other is a no-op.
   */
  async confirmCheckout(orderId: string) {
    const order = await this.orders.findOne({ id: orderId }, { populate: ['site', 'site.owner'] as never })
    if (!order) throw new NotFoundException('Order not found')
    if (order.paymentStatus !== 'awaiting' || (!order.stripeSessionId && !order.squareOrderId)) return this.publicOrder(order)

    const paid = await this.payments.checkPaid(order.site.owner, order)
    if (paid.paid) {
      const paymentPatch = paid.provider === 'square'
        ? { squarePaymentId: paid.paymentRef }
        : { stripePaymentIntentId: paid.paymentRef }
      // The webhook and the success redirect race each other; a conditional
      // UPDATE lets exactly one of them win and send the emails / ticket.
      const won = await this.em.nativeUpdate(
        MealOrder,
        { id: order.id, paymentStatus: 'awaiting' },
        { paymentStatus: 'paid', ...paymentPatch },
      )
      order.paymentStatus = 'paid'
      Object.assign(order, paymentPatch)
      if (won === 1) {
        const site = order.site
        await this.fulfilPlacedOrder(order, site, resolveOrderingConfig(site.orderingConfig))
      }
    }
    return this.publicOrder(order)
  }

  async getPublicOrder(id: string) {
    const order = await this.orders.findOne({ id })
    if (!order) throw new NotFoundException('Order not found')
    return this.publicOrder(order)
  }

  // ----- Admin: menu items -----

  async listMenuForSite(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    const all = await this.items.find({ site }, { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } })
    return all.map(i => this.publicItem(i))
  }

  async createMenuItem(siteId: string, owner: Owner, input: MenuItemInput) {
    const site = await this.assertOwned(siteId, owner)
    if (!input.sku?.trim()) throw new BadRequestException('sku is required')
    if (!input.name?.trim()) throw new BadRequestException('name is required')
    if (!Number.isFinite(input.priceCents) || input.priceCents < 0) throw new BadRequestException('priceCents must be >= 0')
    const item = this.em.create(MenuItem, {
      site,
      sku: input.sku.trim(),
      name: input.name.trim(),
      description: input.description,
      priceCents: input.priceCents,
      currency: input.currency ?? resolveOrderingConfig(site.orderingConfig).currency,
      category: input.category?.trim() ?? '',
      imageUrl: input.imageUrl,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    try {
      await this.em.persistAndFlush(item)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('unique') || msg.includes('duplicate')) {
        throw new BadRequestException(`SKU "${input.sku}" already exists`)
      }
      throw e
    }
    return this.publicItem(item)
  }

  async updateMenuItem(siteId: string, owner: Owner, itemId: string, input: Partial<MenuItemInput>) {
    const site = await this.assertOwned(siteId, owner)
    const item = await this.items.findOne({ id: itemId, site })
    if (!item) throw new NotFoundException('Menu item not found')
    if (input.sku != null) item.sku = input.sku.trim()
    if (input.name != null) item.name = input.name.trim()
    if (input.description !== undefined) item.description = input.description
    if (input.priceCents != null) {
      if (input.priceCents < 0) throw new BadRequestException('priceCents must be >= 0')
      item.priceCents = input.priceCents
    }
    if (input.currency != null) item.currency = input.currency
    if (input.category != null) item.category = input.category
    if (input.imageUrl !== undefined) item.imageUrl = input.imageUrl
    if (input.active != null) item.active = input.active
    if (input.sortOrder != null) item.sortOrder = input.sortOrder
    await this.em.flush()
    return this.publicItem(item)
  }

  async deleteMenuItem(siteId: string, owner: Owner, itemId: string) {
    const site = await this.assertOwned(siteId, owner)
    const item = await this.items.findOne({ id: itemId, site })
    if (!item) throw new NotFoundException('Menu item not found')
    await this.em.removeAndFlush(item)
    return { ok: true as const }
  }

  // ----- Admin: orders -----

  async listOrders(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    // Abandoned checkouts (never paid, session expired) are noise to a kitchen.
    const holdCutoff = new Date(Date.now() - CHECKOUT_HOLD_MINUTES * 60_000)
    const all = await this.orders.find({
      site,
      $or: [{ paymentStatus: { $ne: 'awaiting' } }, { createdAt: { $gte: holdCutoff } }],
    }, { orderBy: { pickupAt: 'ASC' } })
    return all.map(o => this.publicOrder(o))
  }

  async updateOrderStatus(siteId: string, owner: Owner, orderId: string, status: 'pending' | 'confirmed' | 'ready' | 'completed' | 'cancelled') {
    const site = await this.assertOwned(siteId, owner)
    const order = await this.orders.findOne({ id: orderId, site })
    if (!order) throw new NotFoundException('Order not found')
    order.status = status
    await this.em.flush()
    return this.publicOrder(order)
  }

  // ----- Admin: config -----

  async getOrderingConfig(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    return {
      override: site.orderingConfig ?? null,
      resolved: resolveOrderingConfig(site.orderingConfig),
    }
  }

  async updateOrderingConfig(siteId: string, owner: Owner, override: OrderingConfig | null) {
    const site = await this.assertOwned(siteId, owner)
    site.orderingConfig = override ?? undefined
    await this.em.flush()
    return this.getOrderingConfig(siteId, owner)
  }

  // ----- Internals -----

  private async assertOwned(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (site.owner.id !== owner.id) throw new ForbiddenException('Not your site')
    return site
  }

  private publicItem(i: MenuItem) {
    return {
      id: i.id,
      sku: i.sku,
      name: i.name,
      description: i.description,
      priceCents: i.priceCents,
      currency: i.currency,
      category: i.category,
      imageUrl: i.imageUrl,
      active: i.active,
      sortOrder: i.sortOrder,
    }
  }

  private publicOrder(o: MealOrder) {
    return {
      id: o.id,
      name: o.name,
      email: o.email,
      phone: o.phone,
      notes: o.notes,
      pickupAt: o.pickupAt.toISOString(),
      items: o.items,
      subtotalCents: o.subtotalCents,
      totalCents: o.totalCents,
      currency: o.currency,
      status: o.status,
      paymentStatus: o.paymentStatus,
      createdAt: o.createdAt.toISOString(),
      // POS sync state — drives the dashboard's ticket badge + resend button.
      posOrderId: o.posOrderId ?? null,
      posSyncedAt: o.posSyncedAt ? o.posSyncedAt.toISOString() : null,
      posSyncError: o.posSyncError ?? null,
    }
  }

  private async sendOrderEmails(order: MealOrder, site: Site, config: Required<OrderingConfig>) {
    const siteName = site.displayName || site.slug
    const fmt = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency }).format(cents / 100)
    const total = fmt(order.totalCents)
    const pickupLocal = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(order.pickupAt)
    const itemsHtml = order.items.map(it => {
      const note = it.notes ? ` <em>(${escapeHtml(it.notes)})</em>` : ''
      return `<li>${escapeHtml(it.name)} × ${it.quantity} — ${escapeHtml(fmt(it.lineTotalCents))}${note}</li>`
    }).join('')
    const paymentLine = order.paymentStatus === 'paid' ? 'Paid online' : 'Pay at pickup'

    await this.email.send({
      to: order.email,
      subject: `Your order from ${siteName} — pickup ${pickupLocal}`,
      html: `
        <p>Hi ${escapeHtml(order.name)},</p>
        <p>We've got your order. Pickup at <strong>${escapeHtml(pickupLocal)}</strong>.</p>
        <ul>${itemsHtml}</ul>
        <p><strong>Total: ${escapeHtml(total)}</strong> · ${paymentLine}</p>
        ${config.pickupInstructions ? `<p>${escapeHtml(config.pickupInstructions)}</p>` : ''}
      `,
    })

    const notify = config.notifyEmail || site.owner?.email
    if (notify) {
      await this.email.send({
        to: notify,
        subject: `New order — ${siteName} — pickup ${pickupLocal}`,
        html: `
          <p>New order from <strong>${escapeHtml(order.name)}</strong> (${escapeHtml(order.email)})${order.phone ? ` · ${escapeHtml(order.phone)}` : ''}</p>
          <p>Pickup: <strong>${escapeHtml(pickupLocal)}</strong></p>
          <ul>${itemsHtml}</ul>
          <p><strong>Total: ${escapeHtml(total)}</strong> · ${paymentLine}</p>
          ${order.notes ? `<p><em>${escapeHtml(order.notes)}</em></p>` : ''}
        `,
      })
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
