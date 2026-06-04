import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Reservation } from '../entities/reservation.entity'
import { LodgingConfig, LodgingRoom, Site } from '../entities/site.entity'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'
import { findRoom, isDateString, nightsBetween, rangesOverlap, resolveLodgingConfig } from './lodging-config'

export interface CreateReservationDto {
  siteSlug: string
  roomId: string
  /** "YYYY-MM-DD". */
  checkIn: string
  /** "YYYY-MM-DD" (exclusive). */
  checkOut: string
  partySize: number
  name: string
  email: string
  phone?: string
  notes?: string
}

@Injectable()
export class LodgingService {
  private readonly logger = new Logger(LodgingService.name)

  constructor(
    @InjectRepository(Reservation) private readonly reservations: EntityRepository<Reservation>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    private readonly em: EntityManager,
    private readonly email: EmailService,
  ) {}

  /** Public — returns rooms with availability info for the given window. */
  async listAvailability(siteSlug: string, checkIn: string, checkOut: string, partySize: number) {
    const site = await this.sites.findOne({ slug: siteSlug })
    if (!site) throw new NotFoundException('Site not found')
    const config = resolveLodgingConfig(site.lodgingConfig)
    if (!isDateString(checkIn) || !isDateString(checkOut)) {
      throw new BadRequestException('Invalid checkIn/checkOut (use YYYY-MM-DD)')
    }
    if (checkOut <= checkIn) throw new BadRequestException('checkOut must be after checkIn')
    const nights = nightsBetween(checkIn, checkOut)
    if (nights < config.minNights) throw new BadRequestException(`Minimum stay is ${config.minNights} night(s)`)
    if (nights > config.maxNights) throw new BadRequestException(`Maximum stay is ${config.maxNights} night(s)`)

    // Filter rooms by capacity first.
    const candidate = config.rooms.filter(r => r.capacity >= partySize)
    if (!candidate.length) {
      return {
        checkIn, checkOut, nights,
        timezone: config.timezone, currency: config.currency,
        rooms: [] as Array<RoomAvailability>,
      }
    }

    // Pull all confirmed reservations that could overlap this window for this site.
    const overlapping = await this.reservations.find({
      site,
      status: 'confirmed',
      // postgres-friendly: only rows whose range could intersect
      checkIn: { $lt: checkOut },
      checkOut: { $gt: checkIn },
    })

    const rooms: RoomAvailability[] = candidate.map(r => {
      const conflict = overlapping.some(res => res.roomId === r.id && rangesOverlap(checkIn, checkOut, res.checkIn, res.checkOut))
      return {
        id: r.id,
        label: r.label,
        description: r.description,
        capacity: r.capacity,
        imageUrl: r.imageUrl,
        nightlyRateCents: r.nightlyRateCents,
        totalCents: r.nightlyRateCents != null ? r.nightlyRateCents * nights : undefined,
        available: !conflict,
      }
    })

    return {
      checkIn, checkOut, nights,
      timezone: config.timezone,
      currency: config.currency,
      checkInTime: config.checkInTime,
      checkOutTime: config.checkOutTime,
      rooms,
    }
  }

  async create(dto: CreateReservationDto) {
    const site = await this.sites.findOne({ slug: dto.siteSlug }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (!site.addOns?.includes('lodging')) throw new ForbiddenException('Lodging not enabled for this site')
    const config = resolveLodgingConfig(site.lodgingConfig)

    if (!isDateString(dto.checkIn) || !isDateString(dto.checkOut)) {
      throw new BadRequestException('Invalid checkIn/checkOut')
    }
    if (dto.checkOut <= dto.checkIn) throw new BadRequestException('checkOut must be after checkIn')
    const nights = nightsBetween(dto.checkIn, dto.checkOut)
    if (nights < config.minNights || nights > config.maxNights) {
      throw new BadRequestException(`Stay must be between ${config.minNights} and ${config.maxNights} nights`)
    }
    const room = findRoom(config, dto.roomId)
    if (!room) throw new BadRequestException('Unknown room')
    if (dto.partySize < 1 || dto.partySize > room.capacity) {
      throw new BadRequestException(`Party size must be 1-${room.capacity} for this room`)
    }

    // Race-check overlap.
    const overlapping = await this.reservations.find({
      site,
      status: 'confirmed',
      roomId: room.id,
      checkIn: { $lt: dto.checkOut },
      checkOut: { $gt: dto.checkIn },
    })
    if (overlapping.length) throw new BadRequestException('Those nights are no longer available')

    const totalCents = room.nightlyRateCents != null ? room.nightlyRateCents * nights : undefined
    const reservation = this.em.create(Reservation, {
      site,
      roomId: room.id,
      roomLabel: room.label,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      nights,
      partySize: dto.partySize,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      notes: dto.notes,
      totalCents,
      currency: totalCents != null ? config.currency : undefined,
    })
    await this.em.persistAndFlush(reservation)

    await this.sendConfirmation(reservation, site, room, config).catch(e =>
      this.logger.error(`Reservation email failed: ${(e as Error).message}`),
    )

    return this.publicView(reservation)
  }

  async getPublic(id: string) {
    const r = await this.reservations.findOne({ id })
    if (!r) throw new NotFoundException('Reservation not found')
    return this.publicView(r)
  }

  async cancelByToken(id: string, token: string) {
    const r = await this.reservations.findOne({ id }, { populate: ['site', 'site.owner'] })
    if (!r) throw new NotFoundException('Reservation not found')
    if (r.cancelToken !== token) throw new BadRequestException('Invalid cancel token')
    if (r.status === 'cancelled') return this.publicView(r)
    r.status = 'cancelled'
    await this.em.flush()
    await this.notifyCancellation(r).catch(e =>
      this.logger.error(`Reservation cancel email failed: ${(e as Error).message}`),
    )
    return this.publicView(r)
  }

  async listForSite(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    const all = await this.reservations.find({ site }, { orderBy: { checkIn: 'DESC' } })
    return all.map(r => this.publicView(r))
  }

  async adminCancel(id: string, owner: Owner) {
    const r = await this.reservations.findOne({ id }, { populate: ['site', 'site.owner'] })
    if (!r) throw new NotFoundException('Reservation not found')
    if (r.site.owner.id !== owner.id) throw new NotFoundException('Reservation not found')
    r.status = 'cancelled'
    await this.em.flush()
    await this.notifyCancellation(r).catch(() => undefined)
    return this.publicView(r)
  }

  async getLodgingConfig(siteId: string, owner: Owner) {
    const site = await this.assertOwned(siteId, owner)
    return {
      override: site.lodgingConfig ?? null,
      resolved: resolveLodgingConfig(site.lodgingConfig),
    }
  }

  async updateLodgingConfig(siteId: string, owner: Owner, override: LodgingConfig | null) {
    const site = await this.assertOwned(siteId, owner)
    site.lodgingConfig = override ?? undefined
    await this.em.flush()
    return this.getLodgingConfig(siteId, owner)
  }

  private async assertOwned(siteId: string, owner: Owner): Promise<Site> {
    const site = await this.sites.findOne({ id: siteId }, { populate: ['owner'] })
    if (!site) throw new NotFoundException('Site not found')
    if (site.owner.id !== owner.id) throw new ForbiddenException('Not your site')
    return site
  }

  private publicView(r: Reservation) {
    return {
      id: r.id,
      roomId: r.roomId,
      roomLabel: r.roomLabel,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      nights: r.nights,
      partySize: r.partySize,
      name: r.name,
      email: r.email,
      phone: r.phone,
      notes: r.notes,
      totalCents: r.totalCents,
      currency: r.currency,
      status: r.status,
      cancelToken: r.cancelToken,
    }
  }

  private async sendConfirmation(r: Reservation, site: Site, room: LodgingRoom, config: Required<LodgingConfig>) {
    const siteName = site.displayName || site.slug
    const cancelUrl = `${(process.env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '')}/v1/reservations/${r.id}/cancel?token=${r.cancelToken}`
    const total = r.totalCents != null && r.currency
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency }).format(r.totalCents / 100)
      : null
    await this.email.send({
      to: r.email,
      subject: `Your reservation at ${siteName} is confirmed`,
      html: `
        <p>Hi ${escapeHtml(r.name)},</p>
        <p>Your stay at <strong>${escapeHtml(siteName)}</strong> is confirmed.</p>
        <p>
          <strong>${escapeHtml(room.label)}</strong> · ${r.nights} night${r.nights === 1 ? '' : 's'}<br />
          Check-in: <strong>${escapeHtml(r.checkIn)}</strong> from ${escapeHtml(config.checkInTime)}<br />
          Check-out: <strong>${escapeHtml(r.checkOut)}</strong> by ${escapeHtml(config.checkOutTime)}<br />
          Guests: ${r.partySize}
          ${total ? `<br />Total: <strong>${escapeHtml(total)}</strong>` : ''}
        </p>
        <p><a href="${cancelUrl}">Cancel this reservation</a></p>
      `,
    })
  }

  private async notifyCancellation(r: Reservation) {
    await this.email.send({
      to: r.email,
      subject: 'Your reservation has been cancelled',
      html: `<p>Your reservation of <strong>${escapeHtml(r.roomLabel)}</strong> from ${escapeHtml(r.checkIn)} to ${escapeHtml(r.checkOut)} has been cancelled.</p>`,
    })
  }
}

interface RoomAvailability {
  id: string
  label: string
  description?: string
  capacity: number
  imageUrl?: string
  nightlyRateCents?: number
  totalCents?: number
  available: boolean
}

export type { RoomAvailability }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
