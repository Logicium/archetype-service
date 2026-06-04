import type { Booking } from '../entities/booking.entity'

function fmtIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function escapeText(s: string): string {
  return s.replace(/[\\,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n')
}

export interface IcsInput {
  uid: string
  start: Date
  durationMinutes: number
  summary: string
  description: string
  location?: string
  organizerEmail: string
  attendeeEmail: string
  attendeeName?: string
  cancelled?: boolean
}

export function buildIcs(i: IcsInput): string {
  const end = new Date(i.start.getTime() + i.durationMinutes * 60_000)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apotome Labs//Archetype Bookings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${i.cancelled ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${i.uid}`,
    `DTSTAMP:${fmtIcsUtc(new Date())}`,
    `DTSTART:${fmtIcsUtc(i.start)}`,
    `DTEND:${fmtIcsUtc(end)}`,
    `SUMMARY:${escapeText(i.summary)}`,
    `DESCRIPTION:${escapeText(i.description)}`,
    i.location ? `LOCATION:${escapeText(i.location)}` : null,
    `ORGANIZER:mailto:${i.organizerEmail}`,
    `ATTENDEE;CN=${escapeText(i.attendeeName || i.attendeeEmail)};RSVP=TRUE:mailto:${i.attendeeEmail}`,
    i.cancelled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean)
  return lines.join('\r\n') + '\r\n'
}

export function bookingToIcs(b: Booking, opts: { siteName: string; organizerEmail: string }): string {
  const typeLabel = b.serviceLabel
    || (b.type === 'photo-campaign' ? 'Photo Campaign' : b.type.charAt(0).toUpperCase() + b.type.slice(1))
  return buildIcs({
    uid: `${b.id}@archetype.apotomelabs.com`,
    start: b.scheduledAt,
    durationMinutes: b.durationMinutes,
    summary: `${typeLabel} — ${opts.siteName}`,
    description: b.notes ? `${typeLabel} booking.\n\nNotes: ${b.notes}` : `${typeLabel} booking with ${opts.siteName}.`,
    organizerEmail: opts.organizerEmail,
    attendeeEmail: b.email,
    attendeeName: b.name,
    cancelled: b.status === 'cancelled',
  })
}
