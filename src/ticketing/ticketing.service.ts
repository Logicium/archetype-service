import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { randomUUID } from 'crypto'
import { Event, Ticket, TicketTier } from '../entities/event.entity'
import { Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'

export interface EventInput {
  title: string
  description?: string
  startsAt: string
  endsAt?: string
  venue?: string
  imageUrl?: string
  capacity?: number
  currency?: string
  tiers: TicketTier[]
  status?: 'draft' | 'on_sale' | 'sold_out' | 'cancelled' | 'past'
}

export interface PurchaseTicketsDto {
  siteSlug: string
  eventId: string
  name: string
  email: string
  phone?: string
  items: Array<{ tierId: string; quantity: number }>
}

@Injectable()
export class TicketingService {
  private readonly logger = new Logger(TicketingService.name)

  constructor(
    @InjectRepository(Event) private readonly events: EntityRepository<Event>,
    @InjectRepository(Ticket) private readonly tickets: EntityRepository<Ticket>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly email: EmailService,
  ) {}

  // ----- Public -----

  async listPublicEvents(siteSlug: string) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    const all = await this.events.find(
      { site, status: { $in: ['on_sale', 'sold_out'] } },
      { orderBy: { startsAt: 'ASC' } },
    )
    return Promise.all(all.map(e => this.publicEvent(e)))
  }

  async getPublicEvent(siteSlug: string, eventId: string) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    const event = await this.events.findOne({ id: eventId, site })
    if (!event) throw new NotFoundException('Event not found')
    return this.publicEvent(event)
  }

  async purchase(dto: PurchaseTicketsDto) {
    const site = await this.sites.findOne({ slug: dto.siteSlug }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (!site.addOns?.includes('ticketing')) throw new ForbiddenException('Ticketing not enabled for this site')

    const event = await this.events.findOne({ id: dto.eventId, site })
    if (!event) throw new NotFoundException('Event not found')
    if (event.status !== 'on_sale') throw new BadRequestException('Tickets are not on sale for this event')
    if (event.startsAt < new Date()) throw new BadRequestException('Event has already started')

    if (!dto.items?.length) throw new BadRequestException('No tickets requested')

    // Aggregate by tier.
    const wanted = new Map<string, number>()
    for (const it of dto.items) {
      if (!it.tierId || it.quantity < 1) throw new BadRequestException('Invalid ticket line')
      wanted.set(it.tierId, (wanted.get(it.tierId) ?? 0) + Math.floor(it.quantity))
    }

    // Validate tiers exist + are active + have capacity.
    const tierMap = new Map(event.tiers.map(t => [t.id, t]))
    const totalWanted = [...wanted.values()].reduce((a, b) => a + b, 0)

    // Event-level capacity check.
    if (event.capacity !== -1) {
      const sold = await this.tickets.count({ event, status: { $in: ['confirmed', 'checked_in'] } })
      if (sold + totalWanted > event.capacity) throw new BadRequestException('Not enough seats remaining')
    }

    const created: Ticket[] = []
    const orderId = randomUUID()
    for (const [tierId, qty] of wanted) {
      const tier = tierMap.get(tierId)
      if (!tier) throw new BadRequestException(`Unknown tier "${tierId}"`)
      if (tier.active === false) throw new BadRequestException(`Tier "${tier.label}" is unavailable`)
      if (tier.capacity !== -1) {
        const sold = await this.tickets.count({ event, tierId, status: { $in: ['confirmed', 'checked_in'] } })
        if (sold + qty > tier.capacity) throw new BadRequestException(`Tier "${tier.label}" only has ${tier.capacity - sold} seat(s) left`)
      }
      for (let i = 0; i < qty; i++) {
        const ticket = this.em.create(Ticket, {
          event,
          tierId: tier.id,
          tierLabel: tier.label,
          unitPriceCents: tier.priceCents,
          currency: event.currency,
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          orderId,
        })
        created.push(ticket)
      }
    }
    await this.em.persistAndFlush(created)

    // Auto-mark sold out if event capacity exhausted.
    if (event.capacity !== -1) {
      const soldNow = await this.tickets.count({ event, status: { $in: ['confirmed', 'checked_in'] } })
      if (soldNow >= event.capacity) {
        event.status = 'sold_out'
        await this.em.flush()
      }
    }

    await this.sendConfirmation(event, site, created).catch(e =>
      this.logger.error(`Ticket email failed: ${(e as Error).message}`),
    )

    const totalCents = created.reduce((s, t) => s + t.unitPriceCents, 0)
    return {
      orderId,
      eventId: event.id,
      eventTitle: event.title,
      currency: event.currency,
      totalCents,
      tickets: created.map(t => this.publicTicket(t)),
    }
  }

  async getOrder(orderId: string) {
    const list = await this.tickets.find({ orderId }, { populate: ['event'] })
    if (!list.length) throw new NotFoundException('Order not found')
    const event = list[0]!.event
    const totalCents = list.reduce((s, t) => s + (t.status === 'cancelled' ? 0 : t.unitPriceCents), 0)
    return {
      orderId,
      eventId: event.id,
      eventTitle: event.title,
      eventStartsAt: event.startsAt.toISOString(),
      currency: event.currency,
      totalCents,
      tickets: list.map(t => this.publicTicket(t)),
    }
  }

  async cancelByToken(ticketId: string, token: string) {
    const ticket = await this.tickets.findOne({ id: ticketId })
    if (!ticket) throw new NotFoundException('Ticket not found')
    if (ticket.cancelToken !== token) throw new BadRequestException('Invalid cancel token')
    if (ticket.status !== 'cancelled') {
      ticket.status = 'cancelled'
      await this.em.flush()
    }
    return this.publicTicket(ticket)
  }

  // ----- Admin -----

  async listEvents(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    const all = await this.events.find({ site }, { orderBy: { startsAt: 'ASC' } })
    return Promise.all(all.map(e => this.publicEvent(e)))
  }

  async createEvent(siteId: string, owner: Owner, input: EventInput) {
    const site = await this.assertOwned(siteId, owner)
    this.validateEventInput(input)
    const event = this.em.create(Event, {
      site,
      title: input.title.trim(),
      description: input.description,
      startsAt: new Date(input.startsAt),
      endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
      venue: input.venue,
      imageUrl: input.imageUrl,
      capacity: input.capacity ?? -1,
      currency: input.currency ?? 'USD',
      tiers: this.cleanTiers(input.tiers),
      status: input.status ?? 'draft',
    })
    await this.em.persistAndFlush(event)
    return this.publicEvent(event)
  }

  async updateEvent(siteId: string, owner: Owner, eventId: string, input: Partial<EventInput>) {
    const site = await this.assertOwned(siteId, owner)
    const event = await this.events.findOne({ id: eventId, site })
    if (!event) throw new NotFoundException('Event not found')
    if (input.title != null) event.title = input.title.trim()
    if (input.description !== undefined) event.description = input.description
    if (input.startsAt != null) event.startsAt = new Date(input.startsAt)
    if (input.endsAt !== undefined) event.endsAt = input.endsAt ? new Date(input.endsAt) : undefined
    if (input.venue !== undefined) event.venue = input.venue
    if (input.imageUrl !== undefined) event.imageUrl = input.imageUrl
    if (input.capacity != null) event.capacity = input.capacity
    if (input.currency != null) event.currency = input.currency
    if (input.tiers != null) event.tiers = this.cleanTiers(input.tiers)
    if (input.status != null) event.status = input.status
    await this.em.flush()
    return this.publicEvent(event)
  }

  async deleteEvent(siteId: string, owner: Owner, eventId: string) {
    const site = await this.assertOwned(siteId, owner)
    const event = await this.events.findOne({ id: eventId, site })
    if (!event) throw new NotFoundException('Event not found')
    const sold = await this.tickets.count({ event, status: { $in: ['confirmed', 'checked_in'] } })
    if (sold > 0) throw new BadRequestException('Cannot delete an event with sold tickets. Cancel it instead.')
    await this.em.removeAndFlush(event)
    return { ok: true as const }
  }

  async listEventTickets(siteId: string, owner: Owner, eventId: string) {
    const site = await this.assertOwned(siteId, owner)
    const event = await this.events.findOne({ id: eventId, site })
    if (!event) throw new NotFoundException('Event not found')
    const all = await this.tickets.find({ event }, { orderBy: { createdAt: 'DESC' } })
    return all.map(t => this.publicTicket(t))
  }

  async adminCancelTicket(siteId: string, owner: Owner, ticketId: string) {
    await this.assertOwned(siteId, owner)
    const ticket = await this.tickets.findOne({ id: ticketId }, { populate: ['event', 'event.site'] })
    if (!ticket) throw new NotFoundException('Ticket not found')
    if (ticket.event.site.id !== siteId) throw new NotFoundException('Ticket not found')
    ticket.status = 'cancelled'
    await this.em.flush()
    return this.publicTicket(ticket)
  }

  async checkInTicket(siteId: string, owner: Owner, ticketId: string) {
    await this.assertOwned(siteId, owner)
    const ticket = await this.tickets.findOne({ id: ticketId }, { populate: ['event', 'event.site'] })
    if (!ticket) throw new NotFoundException('Ticket not found')
    if (ticket.event.site.id !== siteId) throw new NotFoundException('Ticket not found')
    if (ticket.status === 'cancelled') throw new BadRequestException('Cannot check in a cancelled ticket')
    ticket.status = 'checked_in'
    await this.em.flush()
    return this.publicTicket(ticket)
  }

  // ----- Internals -----

  private async assertOwned(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (site.owner.id !== owner.id) throw new ForbiddenException('Not your site')
    return site
  }

  private validateEventInput(input: EventInput) {
    if (!input.title?.trim()) throw new BadRequestException('title is required')
    if (!input.startsAt || isNaN(new Date(input.startsAt).getTime())) throw new BadRequestException('startsAt must be a valid date')
    if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) throw new BadRequestException('endsAt must be after startsAt')
    if (!Array.isArray(input.tiers) || input.tiers.length === 0) throw new BadRequestException('At least one ticket tier is required')
  }

  private cleanTiers(tiers: TicketTier[]): TicketTier[] {
    return tiers
      .filter(t => t.id?.trim() && t.label?.trim() && Number.isFinite(t.priceCents) && t.priceCents >= 0)
      .map(t => ({
        id: t.id.trim(),
        label: t.label.trim(),
        description: t.description?.trim() || undefined,
        priceCents: Math.round(t.priceCents),
        capacity: Number.isFinite(t.capacity) ? Math.round(t.capacity) : -1,
        active: t.active ?? true,
      }))
  }

  private async publicEvent(e: Event) {
    const sold = await this.tickets.count({ event: e, status: { $in: ['confirmed', 'checked_in'] } })
    const soldByTier = new Map<string, number>()
    for (const tier of e.tiers) {
      soldByTier.set(tier.id, await this.tickets.count({ event: e, tierId: tier.id, status: { $in: ['confirmed', 'checked_in'] } }))
    }
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt?.toISOString(),
      venue: e.venue,
      imageUrl: e.imageUrl,
      capacity: e.capacity,
      currency: e.currency,
      status: e.status,
      sold,
      tiers: e.tiers.map(t => ({
        ...t,
        sold: soldByTier.get(t.id) ?? 0,
        remaining: t.capacity === -1 ? -1 : Math.max(0, t.capacity - (soldByTier.get(t.id) ?? 0)),
      })),
    }
  }

  private publicTicket(t: Ticket) {
    return {
      id: t.id,
      eventId: t.event.id,
      orderId: t.orderId,
      tierId: t.tierId,
      tierLabel: t.tierLabel,
      unitPriceCents: t.unitPriceCents,
      currency: t.currency,
      name: t.name,
      email: t.email,
      phone: t.phone,
      status: t.status,
      cancelToken: t.cancelToken,
      createdAt: t.createdAt.toISOString(),
    }
  }

  private async sendConfirmation(event: Event, site: Site, tickets: Ticket[]) {
    const siteName = site.displayName || site.slug
    const fmt = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: event.currency }).format(cents / 100)
    const totalCents = tickets.reduce((s, t) => s + t.unitPriceCents, 0)
    const when = event.startsAt.toUTCString()
    const counts = new Map<string, { label: string; qty: number; priceCents: number }>()
    for (const t of tickets) {
      const e = counts.get(t.tierId) ?? { label: t.tierLabel, qty: 0, priceCents: t.unitPriceCents }
      e.qty += 1
      counts.set(t.tierId, e)
    }
    const linesHtml = [...counts.values()]
      .map(c => `<li>${escapeHtml(c.label)} × ${c.qty} — ${escapeHtml(fmt(c.priceCents * c.qty))}</li>`)
      .join('')
    const customer = tickets[0]!

    await this.email.send({
      to: customer.email,
      subject: `Your tickets to ${event.title}`,
      html: `
        <p>Hi ${escapeHtml(customer.name)},</p>
        <p>Your tickets to <strong>${escapeHtml(event.title)}</strong> are confirmed.</p>
        <p><strong>${escapeHtml(when)}</strong>${event.venue ? `<br />${escapeHtml(event.venue)}` : ''}</p>
        <ul>${linesHtml}</ul>
        <p><strong>Total: ${escapeHtml(fmt(totalCents))}</strong></p>
        <p>Bring this email to the door. — ${escapeHtml(siteName)}</p>
      `,
    })
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
