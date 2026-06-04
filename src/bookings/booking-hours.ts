import type { BookingConfig } from '../entities/site.entity'

/** Platform-wide fallback used when a Site has no `bookingConfig` override. */
export const DEFAULT_BOOKING_CONFIG: Required<BookingConfig> = {
  timezone: process.env.BOOKING_DEFAULT_TZ || 'America/Denver',
  hours: {
    1: ['09:00-17:00'],
    2: ['09:00-17:00'],
    3: ['09:00-17:00'],
    4: ['09:00-17:00'],
    5: ['09:00-15:00'],
  },
  slotMinutes: 30,
  durations: { demo: 30, walkthrough: 45, 'photo-campaign': 60 },
  minLeadHours: 24,
  windowDays: 30,
  enabledTypes: ['demo', 'walkthrough', 'photo-campaign'],
  services: [],
}

export function resolveBookingConfig(override?: BookingConfig | null): Required<BookingConfig> {
  if (!override) return DEFAULT_BOOKING_CONFIG
  return {
    timezone: override.timezone ?? DEFAULT_BOOKING_CONFIG.timezone,
    hours: override.hours ?? DEFAULT_BOOKING_CONFIG.hours,
    slotMinutes: override.slotMinutes ?? DEFAULT_BOOKING_CONFIG.slotMinutes,
    durations: { ...DEFAULT_BOOKING_CONFIG.durations, ...(override.durations || {}) },
    minLeadHours: override.minLeadHours ?? DEFAULT_BOOKING_CONFIG.minLeadHours,
    windowDays: override.windowDays ?? DEFAULT_BOOKING_CONFIG.windowDays,
    enabledTypes: override.enabledTypes ?? DEFAULT_BOOKING_CONFIG.enabledTypes,
    services: override.services ?? DEFAULT_BOOKING_CONFIG.services,
  }
}

/** "HH:MM" -> minutes-since-midnight. */
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Returns the start times (as UTC `Date`s) of every bookable slot of the given
 * `durationMinutes` between `from` and `to`, given a config and the set of times already taken.
 *
 * Note: this evaluates hours in the *configured* IANA timezone using
 * `Intl.DateTimeFormat` rather than the host's `TZ`. That keeps the service host-tz agnostic.
 */
export function generateSlots(opts: {
  config: Required<BookingConfig>
  durationMinutes: number
  from: Date
  to: Date
  taken: Array<{ start: Date; durationMinutes: number }>
}): Date[] {
  const { config, durationMinutes: duration, from, to, taken } = opts
  const slots: Date[] = []

  const leadCutoff = new Date(Date.now() + config.minLeadHours * 3600_000)
  const effectiveFrom = from > leadCutoff ? from : leadCutoff

  // Iterate day by day in config.timezone.
  const dayCursor = new Date(effectiveFrom)
  dayCursor.setUTCHours(0, 0, 0, 0)
  for (let d = 0; d <= config.windowDays; d++) {
    const probe = new Date(dayCursor.getTime() + d * 86400_000)
    if (probe > to) break

    // Determine weekday in config.timezone for this calendar day.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
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
      for (let m = startMin; m + duration <= endMin; m += config.slotMinutes) {
        const hh = String(Math.floor(m / 60)).padStart(2, '0')
        const mm = String(m % 60).padStart(2, '0')
        const localIso = `${y}-${mo}-${da}T${hh}:${mm}:00`
        const utc = localToUtc(localIso, config.timezone)
        if (utc < effectiveFrom || utc > to) continue
        if (overlapsTaken(utc, duration, taken)) continue
        slots.push(utc)
      }
    }
  }
  return slots
}

function overlapsTaken(start: Date, durationMin: number, taken: Array<{ start: Date; durationMinutes: number }>): boolean {
  const end = start.getTime() + durationMin * 60_000
  for (const t of taken) {
    const ts = t.start.getTime()
    const te = ts + t.durationMinutes * 60_000
    if (start.getTime() < te && end > ts) return true
  }
  return false
}

/**
 * Convert a local wall-clock string (e.g. "2026-06-01T09:30:00") in `tz`
 * to a UTC Date. Works by computing the tz's offset at that instant via Intl.
 */
export function localToUtc(localIso: string, tz: string): Date {
  // Treat the string as if it were UTC, then subtract the tz offset at that moment.
  const asUtc = new Date(localIso + 'Z')
  const offsetMin = tzOffsetMinutes(asUtc, tz)
  return new Date(asUtc.getTime() - offsetMin * 60_000)
}

/** Offset of `tz` from UTC in minutes at `date` (e.g. -360 for MDT). */
function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value
    return acc
  }, {})
  const asTz = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return (asTz - date.getTime()) / 60_000
}
