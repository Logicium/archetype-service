import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Product } from '../entities/product.entity'
import { ShopOrder, ShopOrderItem, ShippingAddress, FulfillmentType, FulfillmentStatus, FulfillmentEvent } from '../entities/shop-order.entity'
import { ShopConfig, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'
import { PaymentsService } from '../payments/payments.service'
import { resolveShopConfig } from './shop-config'

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

export interface CreateShopOrderDto {
  siteSlug: string
  name: string
  email: string
  phone?: string
  notes?: string
  fulfillment: FulfillmentType
  shippingAddress?: ShippingAddress
  items: Array<{ productId: string; quantity: number }>
  /** "/order" from the checkout page; older storefronts send nothing and land back on /shop. */
  returnPath?: string
}

export interface FulfillmentInput {
  status: FulfillmentStatus
  trackingNumber?: string
  trackingCarrier?: string
  trackingUrl?: string
  note?: string
  notify?: boolean
}

/** Which steps make sense for each fulfillment type, in order. */
export const FULFILLMENT_STEPS: Record<FulfillmentType, FulfillmentStatus[]> = {
  shipping: ['received', 'label_printed', 'shipped', 'delivered'],
  pickup: ['received', 'ready_for_pickup', 'picked_up'],
}

const STEP_LABEL: Record<FulfillmentStatus, string> = {
  received: 'Order received',
  label_printed: 'Label printed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  ready_for_pickup: 'Ready for pickup',
  picked_up: 'Picked up',
}

/** Public tracking page for the common carriers, when the owner gives no URL. */
function carrierTrackingUrl(carrier: string | undefined, number: string | undefined): string | undefined {
  if (!number) return undefined
  const c = (carrier || '').toLowerCase().replace(/[^a-z]/g, '')
  const n = encodeURIComponent(number.trim())
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${n}`
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`
  return undefined
}

/** Where this site lives on the web, for links in customer emails. */
function siteUrl(site: Site): string | null {
  const base = site.customDomain ? `https://${site.customDomain}` : site.vercelProductionUrl
  return base ? base.replace(/\/$/, '') : null
}

export interface ProductInput {
  sku: string
  name: string
  description?: string
  priceCents: number
  currency?: string
  imageUrl?: string
  category?: string
  inventory?: number
  active?: boolean
  sortOrder?: number
}

@Injectable()
export class ShopService {
  private readonly logger = new Logger(ShopService.name)

  constructor(
    @InjectRepository(Product) private readonly products: EntityRepository<Product>,
    @InjectRepository(ShopOrder) private readonly orders: EntityRepository<ShopOrder>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly email: EmailService,
    private readonly payments: PaymentsService,
  ) {}

  // ----- Public -----

  async listPublicProducts(siteSlug: string) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    const config = resolveShopConfig(site.shopConfig)
    const all = await this.products.find(
      { site, active: true },
      { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } },
    )
    return {
      currency: config.currency,
      fulfillment: config.fulfillment,
      shippingFlatCents: config.shippingFlatCents,
      products: all.map(p => this.publicProduct(p)),
    }
  }

  /**
   * Validate the cart, snapshot line items, decrement inventory, and persist a
   * pending ShopOrder. Shared by the no-payment path (`createOrder`) and the
   * Stripe path (`createCheckoutSession`).
   */
  private async buildOrder(dto: CreateShopOrderDto) {
    const site = await this.sites.findOne({ slug: dto.siteSlug }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (!site.addOns?.includes('eshop')) throw new ForbiddenException('Shop not enabled for this site')
    const config = resolveShopConfig(site.shopConfig)

    if (!dto.items?.length) throw new BadRequestException('Cart is empty')
    if (!config.fulfillment.includes(dto.fulfillment)) {
      throw new BadRequestException(`Fulfillment "${dto.fulfillment}" not offered`)
    }
    if (dto.fulfillment === 'shipping') {
      if (!dto.shippingAddress?.line1 || !dto.shippingAddress.city || !dto.shippingAddress.postalCode || !dto.shippingAddress.country) {
        throw new BadRequestException('Shipping address is incomplete')
      }
    }

    // Aggregate quantities by productId.
    const wanted = new Map<string, number>()
    for (const it of dto.items) {
      if (!it.productId || it.quantity < 1) throw new BadRequestException('Invalid cart line')
      wanted.set(it.productId, (wanted.get(it.productId) ?? 0) + Math.floor(it.quantity))
    }

    const productList = await this.products.find({ id: { $in: [...wanted.keys()] }, site, active: true })
    if (productList.length !== wanted.size) throw new BadRequestException('One or more products are unavailable')

    const items: ShopOrderItem[] = []
    let subtotalCents = 0
    for (const product of productList) {
      const qty = wanted.get(product.id) ?? 0
      if (product.inventory !== -1 && qty > product.inventory) {
        throw new BadRequestException(`Only ${product.inventory} of "${product.name}" left in stock`)
      }
      const lineTotal = product.priceCents * qty
      items.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: qty,
        lineTotalCents: lineTotal,
      })
      subtotalCents += lineTotal
    }

    const shippingCents = dto.fulfillment === 'shipping' ? config.shippingFlatCents : 0
    const totalCents = subtotalCents + shippingCents

    // Decrement inventory.
    for (const product of productList) {
      if (product.inventory !== -1) {
        const qty = wanted.get(product.id) ?? 0
        product.inventory = Math.max(0, product.inventory - qty)
      }
    }

    const order = this.em.create(ShopOrder, {
      site,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      notes: dto.notes,
      fulfillment: dto.fulfillment,
      shippingAddress: dto.fulfillment === 'shipping' ? dto.shippingAddress : undefined,
      items,
      subtotalCents,
      shippingCents,
      totalCents,
      currency: config.currency,
    })
    await this.em.persistAndFlush(order)

    return { order, site, config }
  }

  /** No-payment order (pickup/pay-later, or demo/sandbox without Connect). */
  async createOrder(dto: CreateShopOrderDto) {
    const { order, site, config } = await this.buildOrder(dto)
    await this.sendOrderEmails(order, site, config).catch(e =>
      this.logger.error(`Shop order email failed: ${(e as Error).message}`),
    )
    return this.publicOrder(order)
  }

  /**
   * Create a pending order and a Stripe Checkout session that settles to the
   * site owner's Connect account. When the owner hasn't finished payment
   * onboarding (or Stripe isn't configured), falls back to a no-payment order
   * so the storefront still works — `checkoutUrl` is null in that case and the
   * caller shows the ordinary confirmation.
   */
  async createCheckoutSession(dto: CreateShopOrderDto, origin?: string) {
    const { order, site, config } = await this.buildOrder(dto)

    const base = sanitizeOrigin(origin)
      || site.vercelProductionUrl
      || process.env.PUBLIC_APP_URL
      || 'http://localhost:5173'
    const cleanBase = base.replace(/\/$/, '')
    // The checkout page sends the buyer to the order status page afterwards;
    // storefronts built before it still land back on /shop.
    const orderPage = dto.returnPath === '/order'
    const successUrl = orderPage
      ? `${cleanBase}/order/${order.id}?status=success`
      : `${cleanBase}/shop?order=${order.id}&status=success`
    const cancelUrl = orderPage
      ? `${cleanBase}/checkout?order=${order.id}&status=cancelled`
      : `${cleanBase}/shop?order=${order.id}&status=cancelled`

    const lineItems = order.items.map(i => ({
      quantity: i.quantity,
      price_data: {
        currency: config.currency.toLowerCase(),
        product_data: { name: i.name },
        unit_amount: i.unitPriceCents,
      },
    }))
    if (order.shippingCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: config.currency.toLowerCase(),
          product_data: { name: 'Shipping' },
          unit_amount: order.shippingCents,
        },
      })
    }

    const checkout = await this.payments.createDestinationCheckout({
      owner: site.owner,
      lineItems,
      successUrl,
      cancelUrl,
      customerEmail: order.email,
      metadata: { shopOrderId: order.id, siteId: site.id },
      sourceName: site.displayName || site.slug,
    }).catch(e => {
      this.logger.warn(`Shop checkout session failed, falling back to no-payment: ${(e as Error).message}`)
      return null
    })

    if (!checkout) {
      // Owner can't accept charges yet — treat as a normal placed order.
      await this.sendOrderEmails(order, site, config).catch(e =>
        this.logger.error(`Shop order email failed: ${(e as Error).message}`))
      return { orderId: order.id, checkoutUrl: null as string | null, order: this.publicOrder(order) }
    }

    if (checkout.provider === 'square') order.squareOrderId = checkout.squareOrderId
    else order.stripeSessionId = checkout.stripeSessionId
    await this.em.persistAndFlush(order)
    return { orderId: order.id, checkoutUrl: checkout.url, order: this.publicOrder(order) }
  }

  /**
   * Verify the hosted checkout (Stripe session or Square order) and flip the
   * order to paid. Reached from the storefront success redirect and the
   * provider webhook; idempotent and safe to re-run.
   */
  async confirmCheckout(orderId: string) {
    const order = await this.orders.findOne({ id: orderId }, { populate: ['site', 'site.owner'] as never })
    if (!order) throw new NotFoundException('Order not found')
    if (order.status !== 'pending' || (!order.stripeSessionId && !order.squareOrderId)) return this.publicOrder(order)

    const paid = await this.payments.checkPaid(order.site.owner, order)
    if (paid.paid) {
      order.status = 'paid'
      if (paid.provider === 'square') order.squarePaymentId = paid.paymentRef
      else order.stripePaymentIntentId = paid.paymentRef
      await this.em.persistAndFlush(order)
      const site = order.site
      await this.sendOrderEmails(order, site, resolveShopConfig(site.shopConfig)).catch(e =>
        this.logger.error(`Shop order email failed: ${(e as Error).message}`))
    }
    return this.publicOrder(order)
  }

  async getPublicOrder(id: string) {
    const order = await this.orders.findOne({ id }, { populate: ['site'] })
    if (!order) throw new NotFoundException('Order not found')
    const config = resolveShopConfig(order.site.shopConfig)
    return { ...this.publicOrder(order), pickupInstructions: config.pickupInstructions || null }
  }

  // ----- Admin: products -----

  async listForSite(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    const all = await this.products.find({ site }, { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } })
    return all.map(p => this.publicProduct(p))
  }

  async createProduct(siteId: string, owner: Owner, input: ProductInput) {
    const site = await this.assertOwned(siteId, owner)
    this.validateProduct(input)
    const product = this.em.create(Product, {
      site,
      sku: input.sku.trim(),
      name: input.name.trim(),
      description: input.description,
      priceCents: input.priceCents,
      currency: input.currency ?? resolveShopConfig(site.shopConfig).currency,
      imageUrl: input.imageUrl,
      category: input.category?.trim() || undefined,
      inventory: input.inventory ?? -1,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    try {
      await this.em.persistAndFlush(product)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('unique') || msg.includes('duplicate')) {
        throw new BadRequestException(`SKU "${input.sku}" already exists`)
      }
      throw e
    }
    return this.publicProduct(product)
  }

  async updateProduct(siteId: string, owner: Owner, productId: string, input: Partial<ProductInput>) {
    const site = await this.assertOwned(siteId, owner)
    const product = await this.products.findOne({ id: productId, site })
    if (!product) throw new NotFoundException('Product not found')
    if (input.sku != null) product.sku = input.sku.trim()
    if (input.name != null) product.name = input.name.trim()
    if (input.description !== undefined) product.description = input.description
    if (input.priceCents != null) {
      if (input.priceCents < 0) throw new BadRequestException('priceCents must be >= 0')
      product.priceCents = input.priceCents
    }
    if (input.currency != null) product.currency = input.currency
    if (input.imageUrl !== undefined) product.imageUrl = input.imageUrl
    if (input.category !== undefined) product.category = input.category?.trim() || undefined
    if (input.inventory != null) product.inventory = input.inventory
    if (input.active != null) product.active = input.active
    if (input.sortOrder != null) product.sortOrder = input.sortOrder
    await this.em.flush()
    return this.publicProduct(product)
  }

  async deleteProduct(siteId: string, owner: Owner, productId: string) {
    const site = await this.assertOwned(siteId, owner)
    const product = await this.products.findOne({ id: productId, site })
    if (!product) throw new NotFoundException('Product not found')
    await this.em.removeAndFlush(product)
    return { ok: true as const }
  }

  // ----- Admin: orders -----

  async listOrders(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    const all = await this.orders.find({ site }, { orderBy: { createdAt: 'DESC' } })
    return all.map(o => this.publicOrder(o))
  }

  async updateOrderStatus(siteId: string, owner: Owner, orderId: string, status: 'pending' | 'paid' | 'fulfilled' | 'cancelled') {
    const site = await this.assertOwned(siteId, owner)
    const order = await this.orders.findOne({ id: orderId, site })
    if (!order) throw new NotFoundException('Order not found')
    const was = order.status
    order.status = status
    await this.em.flush()
    if (status === 'cancelled' && was !== 'cancelled') {
      await this.sendStatusEmail(order, site, {
        subject: `Your order from ${site.displayName || site.slug} was cancelled`,
        headline: 'Your order was cancelled.',
        body: 'If you were charged, the refund is on its way back to your card. Reply to this email with any questions.',
      }).catch(e => this.logger.error(`Shop cancellation email failed: ${(e as Error).message}`))
    }
    return this.publicOrder(order)
  }

  /**
   * Advance the fulfillment tracker. Steps are validated against the order's
   * fulfillment type, every change is appended to the history the customer
   * sees on their order page, and the customer is emailed unless told not to.
   */
  async updateFulfillment(siteId: string, owner: Owner, orderId: string, input: FulfillmentInput) {
    const site = await this.assertOwned(siteId, owner)
    const order = await this.orders.findOne({ id: orderId, site })
    if (!order) throw new NotFoundException('Order not found')
    if (order.status === 'cancelled') throw new BadRequestException('This order was cancelled')
    if (!FULFILLMENT_STEPS[order.fulfillment].includes(input.status)) {
      throw new BadRequestException(`"${STEP_LABEL[input.status]}" does not apply to a ${order.fulfillment} order`)
    }

    const trackingNumber = input.trackingNumber?.trim() || order.trackingNumber
    const trackingCarrier = input.trackingCarrier?.trim() || order.trackingCarrier
    if (input.status === 'shipped' && !trackingNumber) {
      throw new BadRequestException('Add the tracking number before marking the order shipped')
    }
    order.trackingNumber = trackingNumber
    order.trackingCarrier = trackingCarrier
    order.trackingUrl = input.trackingUrl?.trim() || order.trackingUrl || carrierTrackingUrl(trackingCarrier, trackingNumber)
    const note = input.note?.trim() || undefined
    if (note) order.fulfillmentNote = note

    const changed = order.fulfillmentStatus !== input.status
    order.fulfillmentStatus = input.status
    order.fulfillmentUpdatedAt = new Date()
    const event: FulfillmentEvent = { status: input.status, at: order.fulfillmentUpdatedAt.toISOString(), ...(note ? { note } : {}) }
    order.fulfillmentHistory = [...(order.fulfillmentHistory ?? []), event]
    // The last step closes the order's lifecycle too.
    if (input.status === 'delivered' || input.status === 'picked_up') order.status = 'fulfilled'
    await this.em.flush()

    if (input.notify !== false && (changed || note || input.status === 'shipped')) {
      await this.sendFulfillmentEmail(order, site).catch(e =>
        this.logger.error(`Shop fulfillment email failed: ${(e as Error).message}`))
    }
    return this.publicOrder(order)
  }

  // ----- Admin: config -----

  async getShopConfig(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    return {
      override: site.shopConfig ?? null,
      resolved: resolveShopConfig(site.shopConfig),
    }
  }

  async updateShopConfig(siteId: string, owner: Owner, override: ShopConfig | null) {
    const site = await this.assertOwned(siteId, owner)
    site.shopConfig = override ?? undefined
    await this.em.flush()
    return this.getShopConfig(siteId, owner)
  }

  // ----- Internals -----

  private async assertOwned(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (site.owner.id !== owner.id) throw new ForbiddenException('Not your site')
    return site
  }

  private validateProduct(input: ProductInput) {
    if (!input.sku?.trim()) throw new BadRequestException('sku is required')
    if (!input.name?.trim()) throw new BadRequestException('name is required')
    if (!Number.isFinite(input.priceCents) || input.priceCents < 0) throw new BadRequestException('priceCents must be >= 0')
  }

  private publicProduct(p: Product) {
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: p.currency,
      imageUrl: p.imageUrl,
      category: p.category,
      inventory: p.inventory,
      active: p.active,
      sortOrder: p.sortOrder,
    }
  }

  private publicOrder(o: ShopOrder) {
    return {
      id: o.id,
      name: o.name,
      email: o.email,
      phone: o.phone,
      notes: o.notes,
      fulfillment: o.fulfillment,
      shippingAddress: o.shippingAddress,
      items: o.items,
      subtotalCents: o.subtotalCents,
      shippingCents: o.shippingCents,
      totalCents: o.totalCents,
      currency: o.currency,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      fulfillmentStatus: o.fulfillmentStatus ?? 'received',
      trackingNumber: o.trackingNumber ?? null,
      trackingCarrier: o.trackingCarrier ?? null,
      trackingUrl: o.trackingUrl ?? null,
      fulfillmentNote: o.fulfillmentNote ?? null,
      fulfillmentHistory: o.fulfillmentHistory ?? [],
      fulfillmentUpdatedAt: o.fulfillmentUpdatedAt ? o.fulfillmentUpdatedAt.toISOString() : null,
    }
  }

  /** One short customer email per fulfillment step. */
  private async sendFulfillmentEmail(order: ShopOrder, site: Site) {
    const siteName = site.displayName || site.slug
    const config = resolveShopConfig(site.shopConfig)
    const tracking = order.trackingNumber
      ? `<p>Tracking${order.trackingCarrier ? ` (${escapeHtml(order.trackingCarrier)})` : ''}: ${order.trackingUrl
          ? `<a href="${escapeHtml(order.trackingUrl)}">${escapeHtml(order.trackingNumber)}</a>`
          : `<strong>${escapeHtml(order.trackingNumber)}</strong>`}</p>`
      : ''
    const copy: Record<FulfillmentStatus, { subject: string; headline: string; body: string }> = {
      received: {
        subject: `We have your order from ${siteName}`,
        headline: 'We have your order.',
        body: 'It is in the queue and we will let you know as it moves along.',
      },
      label_printed: {
        subject: `Your ${siteName} order is being packed`,
        headline: 'Your order is being packed.',
        body: 'The shipping label is printed and your package goes out shortly. You will get another email with tracking once it ships.',
      },
      shipped: {
        subject: `Your ${siteName} order is on its way`,
        headline: 'Your order has shipped.',
        body: 'It is on its way to you. Use the tracking number below to follow it.',
      },
      delivered: {
        subject: `Your ${siteName} order was delivered`,
        headline: 'Your order was delivered.',
        body: 'We hope you love it. Reply to this email if anything is not right.',
      },
      ready_for_pickup: {
        subject: `Your ${siteName} order is ready for pickup`,
        headline: 'Your order is ready for pickup.',
        body: config.pickupInstructions || 'Come by whenever suits you during opening hours.',
      },
      picked_up: {
        subject: `Thanks for picking up your ${siteName} order`,
        headline: 'Thanks for picking up your order.',
        body: 'We hope you love it. Reply to this email if anything is not right.',
      },
    }
    const c = copy[order.fulfillmentStatus]
    await this.sendStatusEmail(order, site, { ...c, extraHtml: tracking })
  }

  /** Shared shell for every status email: headline, body, owner note, order link. */
  private async sendStatusEmail(order: ShopOrder, site: Site, msg: { subject: string; headline: string; body: string; extraHtml?: string }) {
    const siteName = site.displayName || site.slug
    const link = siteUrl(site)
    const itemsHtml = order.items.map(it => `<li>${escapeHtml(it.name)} × ${it.quantity}</li>`).join('')
    await this.email.send({
      to: order.email,
      subject: msg.subject,
      html: `
        <p>Hi ${escapeHtml(order.name)},</p>
        <p><strong>${escapeHtml(msg.headline)}</strong> ${escapeHtml(msg.body)}</p>
        ${order.fulfillmentNote ? `<p><em>From ${escapeHtml(siteName)}:</em> ${escapeHtml(order.fulfillmentNote)}</p>` : ''}
        ${msg.extraHtml ?? ''}
        <ul>${itemsHtml}</ul>
        ${link ? `<p><a href="${escapeHtml(link)}/order/${order.id}">View your order</a></p>` : ''}
        <p>${escapeHtml(siteName)}</p>
      `,
    })
  }

  private async sendOrderEmails(order: ShopOrder, site: Site, config: Required<ShopConfig>) {
    const siteName = site.displayName || site.slug
    const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency }).format(order.totalCents / 100)
    const subtotal = new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency }).format(order.subtotalCents / 100)
    const shipping = order.shippingCents
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency }).format(order.shippingCents / 100)
      : null
    const itemsHtml = order.items.map(it => {
      const line = new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency }).format(it.lineTotalCents / 100)
      return `<li>${escapeHtml(it.name)} × ${it.quantity} — ${escapeHtml(line)}</li>`
    }).join('')

    const fulfillmentBlock = order.fulfillment === 'pickup'
      ? `<p><strong>Pickup.</strong> ${escapeHtml(config.pickupInstructions || 'We\u2019ll be in touch with pickup details.')}</p>`
      : `<p><strong>Ship to:</strong><br />${escapeHtml(order.shippingAddress?.line1 || '')}${order.shippingAddress?.line2 ? '<br />' + escapeHtml(order.shippingAddress.line2) : ''}<br />${escapeHtml(order.shippingAddress?.city || '')}${order.shippingAddress?.region ? ', ' + escapeHtml(order.shippingAddress.region) : ''} ${escapeHtml(order.shippingAddress?.postalCode || '')}<br />${escapeHtml(order.shippingAddress?.country || '')}</p>`

    await this.email.send({
      to: order.email,
      subject: `Your order from ${siteName}`,
      html: `
        <p>Hi ${escapeHtml(order.name)},</p>
        <p>Thanks for your order with <strong>${escapeHtml(siteName)}</strong>. We received it and will follow up soon.</p>
        <ul>${itemsHtml}</ul>
        <p>Subtotal: ${escapeHtml(subtotal)}${shipping ? `<br />Shipping: ${escapeHtml(shipping)}` : ''}<br /><strong>Total: ${escapeHtml(total)}</strong></p>
        ${fulfillmentBlock}
        ${siteUrl(site) ? `<p><a href="${escapeHtml(siteUrl(site) as string)}/order/${order.id}">Track your order</a> — we will email you at each step.</p>` : ''}
      `,
    })

    const notify = config.notifyEmail || site.owner?.email
    if (notify) {
      await this.email.send({
        to: notify,
        subject: `New shop order — ${siteName} — ${total}`,
        html: `
          <p>New order from <strong>${escapeHtml(order.name)}</strong> (${escapeHtml(order.email)})${order.phone ? ` · ${escapeHtml(order.phone)}` : ''}</p>
          <ul>${itemsHtml}</ul>
          <p>Subtotal: ${escapeHtml(subtotal)}${shipping ? `<br />Shipping: ${escapeHtml(shipping)}` : ''}<br /><strong>Total: ${escapeHtml(total)}</strong></p>
          ${fulfillmentBlock}
          ${order.notes ? `<p><em>${escapeHtml(order.notes)}</em></p>` : ''}
        `,
      })
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
