import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Booking, BookingType } from '../entities/booking.entity'
import { BookingConfig, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'
import { generateSlots, resolveBookingConfig } from './booking-hours'
import { bookingToIcs } from './ics'

export interface CreateBookingDto {
  siteSlug: string
  /** Platform type ('demo'|'walkthrough'|'photo-campaign') OR an owner-defined service id. */
  type: string
  name: string
  email: string
  phone?: string
  notes?: string
  /** ISO-8601 UTC timestamp of the chosen slot start. */
  scheduledAt: string
  timezone?: string
}

const PLATFORM_TYPES = new Set<BookingType>(['demo', 'walkthrough', 'photo-campaign'])

interface ResolvedType {
  kind: BookingType
  serviceId?: string
  label: string
  durationMinutes: number
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name)

  constructor(
    @InjectRepository(Booking) private readonly bookings: EntityRepository<Booking>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly email: EmailService,
  ) {}

  /** Available start times for `type` at `siteSlug` for the configured window. */
  async listAvailability(siteSlug: string, type: string) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    if (site.archetype === 'keystone' && !(site.addOns || []).includes('appointments')) {
      const config = resolveBookingConfig(site.bookingConfig)
      return this.emptyAvailability(config, site)
    }
    const config = resolveBookingConfig(site.bookingConfig)
    let resolved: ResolvedType
    try {
      resolved = this.resolveType(config, type)
    } catch {
      return this.emptyAvailability(config, site)
    }
    const from = new Date()
    const to = new Date(Date.now() + config.windowDays * 86400_000)
    const existing = await this.bookings.find(
      { site, status: 'confirmed', scheduledAt: { $gte: from, $lte: to } },
      { fields: ['scheduledAt', 'durationMinutes'] },
    )
    const slots = generateSlots({
      config,
      durationMinutes: resolved.durationMinutes,
      from,
      to,
      taken: existing.map(b => ({ start: b.scheduledAt, durationMinutes: b.durationMinutes })),
    })
    return {
      slots: slots.map(s => s.toISOString()),
      durationMinutes: resolved.durationMinutes,
      timezone: config.timezone,
      enabledTypes: config.enabledTypes,
      services: config.services ?? [],
    }
  }

  async create(dto: CreateBookingDto) {
    const site = await this.sites.findOne({ slug: dto.siteSlug }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (site.archetype === 'keystone' && !(site.addOns || []).includes('appointments')) {
      throw new BadRequestException('Appointments are not enabled for this site')
    }
    const config = resolveBookingConfig(site.bookingConfig)
    const resolved = this.resolveType(config, dto.type)
    const start = new Date(dto.scheduledAt)
    if (isNaN(start.getTime())) throw new BadRequestException('Invalid scheduledAt')
    const duration = resolved.durationMinutes

    // Re-validate the slot against current availability to avoid races.
    const windowFrom = new Date(start.getTime() - duration * 60_000)
    const windowTo = new Date(start.getTime() + duration * 60_000)
    const overlapping = await this.bookings.find({
      site,
      status: 'confirmed',
      scheduledAt: { $gte: windowFrom, $lte: windowTo },
    })
    const taken = overlapping.some(b => {
      const bs = b.scheduledAt.getTime()
      const be = bs + b.durationMinutes * 60_000
      const ns = start.getTime()
      const ne = ns + duration * 60_000
      return ns < be && ne > bs
    })
    if (taken) throw new BadRequestException('Slot no longer available')

    const booking = this.em.create(Booking, {
      site,
      type: resolved.kind,
      serviceId: resolved.serviceId,
      serviceLabel: resolved.serviceId ? resolved.label : undefined,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      notes: dto.notes,
      scheduledAt: start,
      durationMinutes: duration,
      timezone: dto.timezone,
    })
    await this.em.persistAndFlush(booking)

    await this.sendConfirmation(booking, site).catch(e =>
      this.logger.error(`Confirmation email failed: ${(e as Error).message}`),
    )

    return this.publicView(booking)
  }

  private emptyAvailability(config: Required<BookingConfig>, _site: Site) {
    return {
      slots: [] as string[],
      durationMinutes: 0,
      timezone: config.timezone,
      enabledTypes: config.enabledTypes,
      services: config.services ?? [],
    }
  }

  private resolveType(config: Required<BookingConfig>, type: string): ResolvedType {
    // Owner-defined service?
    const service = (config.services ?? []).find(s => s.id === type)
    if (service) {
      return {
        kind: 'service',
        serviceId: service.id,
        label: service.label,
        durationMinutes: service.durationMinutes || config.slotMinutes,
      }
    }
    // Platform built-in type?
    if (PLATFORM_TYPES.has(type as BookingType) && config.enabledTypes.includes(type as Exclude<BookingType, 'service'>)) {
      const t = type as Exclude<BookingType, 'service'>
      return {
        kind: t,
        label: t === 'photo-campaign' ? 'Photo Campaign' : t.charAt(0).toUpperCase() + t.slice(1),
        durationMinutes: config.durations[t] ?? config.slotMinutes,
      }
    }
    throw new BadRequestException('Booking type not offered by this site')
  }

  async getPublic(id: string) {
    const b = await this.bookings.findOne({ id }, { populate: ['site'] })
    if (!b) throw new NotFoundException('Booking not found')
    return this.publicView(b)
  }

  async getIcs(id: string): Promise<{ filename: string; body: string }> {
    const b = await this.bookings.findOne({ id }, { populate: ['site', 'site.owner'] })
    if (!b) throw new NotFoundException('Booking not found')
    const body = bookingToIcs(b, {
      siteName: b.site.displayName || b.site.slug,
      organizerEmail: b.site.owner?.email || (process.env.EMAIL_FROM || 'noreply@apotomelabs.com'),
    })
    return { filename: `booking-${b.id}.ics`, body }
  }

  async cancelByToken(id: string, token: string) {
    const b = await this.bookings.findOne({ id }, { populate: ['site', 'site.owner'] })
    if (!b) throw new NotFoundException('Booking not found')
    if (b.cancelToken !== token) throw new BadRequestException('Invalid cancel token')
    if (b.status === 'cancelled') return this.publicView(b)
    b.status = 'cancelled'
    await this.em.flush()
    await this.notifyCancellation(b).catch(e =>
      this.logger.error(`Cancel email failed: ${(e as Error).message}`),
    )
    return this.publicView(b)
  }

  async listForOwner(owner: Owner) {
    const sites = await this.sites.find({ owner })
    if (sites.length === 0) return []
    const all = await this.bookings.find(
      { site: { $in: sites } },
      { populate: ['site'], orderBy: { scheduledAt: 'DESC' } },
    )
    return all.map(b => ({
      ...this.publicView(b),
      siteSlug: b.site.slug,
    }))
  }

  async adminCancel(id: string, owner: Owner) {
    const b = await this.bookings.findOne({ id }, { populate: ['site', 'site.owner'] })
    if (!b) throw new NotFoundException('Booking not found')
    if (b.site.owner.id !== owner.id) throw new NotFoundException('Booking not found')
    b.status = 'cancelled'
    await this.em.flush()
    await this.notifyCancellation(b).catch(() => undefined)
    return this.publicView(b)
  }

  /** Owner-scoped: list this site's bookings for the admin dashboard. */
  async listForSite(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    const all = await this.bookings.find(
      { site },
      { orderBy: { scheduledAt: 'DESC' } },
    )
    return all.map(b => ({ ...this.publicView(b), siteSlug: site.slug }))
  }

  /** Owner-scoped: read the site's bookingConfig (resolved with defaults). */
  async getBookingConfig(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    return {
      override: site.bookingConfig ?? null,
      resolved: resolveBookingConfig(site.bookingConfig),
    }
  }

  /** Owner-scoped: replace the site's bookingConfig (null clears override). */
  async updateBookingConfig(siteId: string, owner: Owner, override: BookingConfig | null) {
    const site = await this.assertOwned(siteId, owner)
    site.bookingConfig = override ?? undefined
    await this.em.flush()
    return this.getBookingConfig(siteId, owner)
  }

  /** Owner-scoped: toggle an add-on for the site. */
  async setAddOn(siteId: string, owner: Owner, addOn: string, enabled: boolean) {
    const site = await this.assertOwned(siteId, owner)
    const set = new Set(site.addOns || [])
    if (enabled) set.add(addOn)
    else set.delete(addOn)
    site.addOns = Array.from(set)
    await this.em.flush()
    return { addOns: site.addOns }
  }

  private async assertOwned(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (site.owner.id !== owner.id) throw new ForbiddenException('Not your site')
    return site
  }

  // ---- internals -------------------------------------------------------

  private publicView(b: Booking) {
    return {
      id: b.id,
      type: b.type,
      serviceId: b.serviceId,
      serviceLabel: b.serviceLabel,
      name: b.name,
      email: b.email,
      phone: b.phone,
      notes: b.notes,
      scheduledAt: b.scheduledAt.toISOString(),
      durationMinutes: b.durationMinutes,
      timezone: b.timezone,
      status: b.status,
      cancelToken: b.cancelToken,
      icsUrl: this.icsUrl(b.id),
    }
  }

  private icsUrl(id: string) {
    const base = process.env.PUBLIC_API_BASE_URL || ''
    return `${base.replace(/\/$/, '')}/v1/bookings/${id}/calendar.ics`
  }

  private async sendConfirmation(b: Booking, site: Site) {
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: b.timezone || 'America/Denver',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(b.scheduledAt)
    const typeLabel = b.serviceLabel || (b.type === 'photo-campaign' ? 'photo campaign' : b.type)
    const siteName = site.displayName || site.slug
    const cancelUrl = `${(process.env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '')}/v1/bookings/${b.id}/cancel?token=${b.cancelToken}`
    const icsUrl = this.icsUrl(b.id)

    await this.email.send({
      to: b.email,
      subject: `Your ${typeLabel} with ${siteName} is confirmed`,
      html: `
        <p>Hi ${escapeHtml(b.name)},</p>
        <p>Your <strong>${typeLabel}</strong> with <strong>${escapeHtml(siteName)}</strong> is confirmed for:</p>
        <p style="font-size:1.1rem"><strong>${escapeHtml(when)}</strong> (${escapeHtml(b.timezone || 'local time')})</p>
        <p><a href="${icsUrl}">Add to your calendar</a> · <a href="${cancelUrl}">Cancel</a></p>
      `,
    })

    if (site.owner?.email) {
      await this.email.send({
        to: site.owner.email,
        subject: `New ${typeLabel} booking: ${b.name}`,
        html: `
          <p>${escapeHtml(b.name)} (${escapeHtml(b.email)}${b.phone ? `, ${escapeHtml(b.phone)}` : ''})
          booked a <strong>${typeLabel}</strong> for <strong>${escapeHtml(when)}</strong>.</p>
          ${b.notes ? `<p>Notes:<br>${escapeHtml(b.notes)}</p>` : ''}
        `,
        ccAdmin: true,
      })
    }
  }

  private async notifyCancellation(b: Booking) {
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: b.timezone || 'America/Denver',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(b.scheduledAt)
    await this.email.send({
      to: b.email,
      subject: 'Your booking has been cancelled',
      html: `<p>Your ${escapeHtml(b.serviceLabel || b.type)} previously scheduled for ${escapeHtml(when)} has been cancelled.</p>`,
    })
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
