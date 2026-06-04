import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { MenuItem } from '../entities/menu-item.entity'
import { MealOrder, MealOrderLine } from '../entities/meal-order.entity'
import { OrderingConfig, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'
import { generateOrderingSlots, resolveOrderingConfig, snapToSlot } from './ordering-config'

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
  ) {}

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
      status: { $in: ['pending', 'confirmed', 'ready'] },
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

  async createOrder(dto: CreateMealOrderDto) {
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
      status: { $in: ['pending', 'confirmed', 'ready'] },
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

    await this.sendOrderEmails(order, site, config).catch(e =>
      this.logger.error(`Meal order email failed: ${(e as Error).message}`),
    )

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
    const all = await this.orders.find({ site }, { orderBy: { pickupAt: 'ASC' } })
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
      createdAt: o.createdAt.toISOString(),
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

    await this.email.send({
      to: order.email,
      subject: `Your order from ${siteName} — pickup ${pickupLocal}`,
      html: `
        <p>Hi ${escapeHtml(order.name)},</p>
        <p>We've got your order. Pickup at <strong>${escapeHtml(pickupLocal)}</strong>.</p>
        <ul>${itemsHtml}</ul>
        <p><strong>Total: ${escapeHtml(total)}</strong></p>
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
          <p><strong>Total: ${escapeHtml(total)}</strong></p>
          ${order.notes ? `<p><em>${escapeHtml(order.notes)}</em></p>` : ''}
        `,
      })
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
