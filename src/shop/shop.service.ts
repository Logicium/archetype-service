import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Product } from '../entities/product.entity'
import { ShopOrder, ShopOrderItem, ShippingAddress, FulfillmentType } from '../entities/shop-order.entity'
import { ShopConfig, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'
import { resolveShopConfig } from './shop-config'

export interface CreateShopOrderDto {
  siteSlug: string
  name: string
  email: string
  phone?: string
  notes?: string
  fulfillment: FulfillmentType
  shippingAddress?: ShippingAddress
  items: Array<{ productId: string; quantity: number }>
}

export interface ProductInput {
  sku: string
  name: string
  description?: string
  priceCents: number
  currency?: string
  imageUrl?: string
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

  async createOrder(dto: CreateShopOrderDto) {
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

    await this.sendOrderEmails(order, site, config).catch(e =>
      this.logger.error(`Shop order email failed: ${(e as Error).message}`),
    )

    return this.publicOrder(order)
  }

  async getPublicOrder(id: string) {
    const order = await this.orders.findOne({ id })
    if (!order) throw new NotFoundException('Order not found')
    return this.publicOrder(order)
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
    order.status = status
    await this.em.flush()
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
    }
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
