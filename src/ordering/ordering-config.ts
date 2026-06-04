import type { OrderingConfig } from '../entities/site.entity'
import { localToUtc } from '../bookings/booking-hours'

export const DEFAULT_ORDERING_CONFIG: Required<OrderingConfig> = {
  timezone: process.env.BOOKING_DEFAULT_TZ || 'America/Denver',
  currency: 'USD',
  hours: {
    1: ['11:00-20:00'],
    2: ['11:00-20:00'],
    3: ['11:00-20:00'],
    4: ['11:00-20:00'],
    5: ['11:00-21:00'],
    6: ['11:00-21:00'],
  },
  slotMinutes: 15,
  prepMinutes: 30,
  maxOrdersPerSlot: 5,
  windowDays: 14,
  pickupInstructions: '',
  notifyEmail: '',
}

export function resolveOrderingConfig(override?: OrderingConfig | null): Required<OrderingConfig> {
  return {
    timezone: override?.timezone ?? DEFAULT_ORDERING_CONFIG.timezone,
    currency: override?.currency ?? DEFAULT_ORDERING_CONFIG.currency,
    hours: override?.hours ?? DEFAULT_ORDERING_CONFIG.hours,
    slotMinutes: override?.slotMinutes ?? DEFAULT_ORDERING_CONFIG.slotMinutes,
    prepMinutes: override?.prepMinutes ?? DEFAULT_ORDERING_CONFIG.prepMinutes,
    maxOrdersPerSlot: override?.maxOrdersPerSlot ?? DEFAULT_ORDERING_CONFIG.maxOrdersPerSlot,
    windowDays: override?.windowDays ?? DEFAULT_ORDERING_CONFIG.windowDays,
    pickupInstructions: override?.pickupInstructions ?? DEFAULT_ORDERING_CONFIG.pickupInstructions,
    notifyEmail: override?.notifyEmail ?? DEFAULT_ORDERING_CONFIG.notifyEmail,
  }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Returns pickup slot UTC start times across the configured window. Each slot
 * starts on a `slotMinutes` boundary inside the day's open ranges. `prepMinutes`
 * is subtracted from "now" to gate the earliest selectable slot. `existingByStart`
 * is a map (ISO string) -> count of confirmed/pending orders already in that slot;
 * slots at or above `maxOrdersPerSlot` are filtered out.
 */
export function generateOrderingSlots(opts: {
  config: Required<OrderingConfig>
  existingByStart: Map<string, number>
}): Date[] {
  const { config, existingByStart } = opts
  const out: Date[] = []
  const earliest = new Date(Date.now() + config.prepMinutes * 60_000)

  const dayCursor = new Date(earliest)
  dayCursor.setUTCHours(0, 0, 0, 0)
  for (let d = 0; d <= config.windowDays; d++) {
    const probe = new Date(dayCursor.getTime() + d * 86400_000)
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(probe)
    const wdShort = parts.find(p => p.type === 'weekday')?.value || ''
    const wd = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wdShort)) as 0 | 1 | 2 | 3 | 4 | 5 | 6
    const ranges = config.hours[wd]
    if (!ranges || ranges.length === 0) continue

    const y = parts.find(p => p.type === 'year')!.value
    const mo = parts.find(p => p.type === 'month')!.value
    const da = parts.find(p => p.type === 'day')!.value

    for (const range of ranges) {
      const [startStr, endStr] = range.split('-')
      const startMin = toMin(startStr)
      const endMin = toMin(endStr)
      for (let m = startMin; m < endMin; m += config.slotMinutes) {
        const hh = String(Math.floor(m / 60)).padStart(2, '0')
        const mm = String(m % 60).padStart(2, '0')
        const utc = localToUtc(`${y}-${mo}-${da}T${hh}:${mm}:00`, config.timezone)
        if (utc < earliest) continue
        const count = existingByStart.get(utc.toISOString()) ?? 0
        if (count >= config.maxOrdersPerSlot) continue
        out.push(utc)
      }
    }
  }
  return out
}

/** Round a Date down to the nearest `slotMinutes`-boundary minute. */
export function snapToSlot(date: Date, slotMinutes: number): Date {
  const ms = date.getTime()
  const slotMs = slotMinutes * 60_000
  return new Date(Math.floor(ms / slotMs) * slotMs)
}
