import type { LodgingConfig, LodgingRoom } from '../entities/site.entity'

export const DEFAULT_LODGING_CONFIG: Required<LodgingConfig> = {
  timezone: process.env.LODGING_DEFAULT_TZ || 'America/Denver',
  currency: 'USD',
  minNights: 1,
  maxNights: 14,
  windowDays: 180,
  checkInTime: '15:00',
  checkOutTime: '11:00',
  rooms: [],
}

export function resolveLodgingConfig(override?: LodgingConfig | null): Required<LodgingConfig> {
  if (!override) return DEFAULT_LODGING_CONFIG
  return {
    timezone: override.timezone ?? DEFAULT_LODGING_CONFIG.timezone,
    currency: override.currency ?? DEFAULT_LODGING_CONFIG.currency,
    minNights: override.minNights ?? DEFAULT_LODGING_CONFIG.minNights,
    maxNights: override.maxNights ?? DEFAULT_LODGING_CONFIG.maxNights,
    windowDays: override.windowDays ?? DEFAULT_LODGING_CONFIG.windowDays,
    checkInTime: override.checkInTime ?? DEFAULT_LODGING_CONFIG.checkInTime,
    checkOutTime: override.checkOutTime ?? DEFAULT_LODGING_CONFIG.checkOutTime,
    rooms: override.rooms ?? DEFAULT_LODGING_CONFIG.rooms,
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDateString(s: string): boolean {
  return DATE_RE.test(s) && !isNaN(new Date(`${s}T00:00:00Z`).getTime())
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(`${checkIn}T00:00:00Z`).getTime()
  const b = new Date(`${checkOut}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86400_000)
}

/** Open-interval overlap: [aIn, aOut) overlaps [bIn, bOut) iff aIn < bOut && bIn < aOut. */
export function rangesOverlap(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return aIn < bOut && bIn < aOut
}

export function findRoom(config: Required<LodgingConfig>, roomId: string): LodgingRoom | undefined {
  return config.rooms.find(r => r.id === roomId)
}
