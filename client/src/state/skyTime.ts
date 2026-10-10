import { ecefToGeodetic } from '@windowseat/shared'

import { lightAnchor } from '../aircraft/lightAnchor'
import { getSimulatedDate, settingsStore } from './settings'

/**
 * Time of day as people think of it: the local (solar) time where you're
 * looking, rather than an offset from your own clock. Solar time ignores
 * time zones and the equation of time (±16 min), which is what decides the
 * light anyway.
 */

const HOUR = 3_600_000
const DEG = Math.PI / 180

/** Latitude/longitude (degrees) of the view center, or the followed aircraft. */
export function viewLatLon(): { lat: number; lon: number } {
  if (lightAnchor.lengthSq() < 1) return { lat: 0, lon: 0 }
  const g = ecefToGeodetic(lightAnchor.x, lightAnchor.y, lightAnchor.z)
  return { lat: g.lat, lon: g.lon }
}

/** Solar time (hours, 0 … 24) at a longitude. */
export function solarHours(date: Date, lon: number): number {
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  return (((utc + lon / 15) % 24) + 24) % 24
}

/** Sunrise and sunset (solar hours) at a latitude on a date; null in polar day/night. */
export function sunTimes(date: Date, lat: number): { sunrise: number; sunset: number } | null {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const day = (date.getTime() - start) / 86_400_000
  const declination = -23.44 * DEG * Math.cos(((2 * Math.PI) / 365) * (day + 10))
  const phi = lat * DEG
  const cosH =
    (Math.sin(-0.83 * DEG) - Math.sin(phi) * Math.sin(declination)) /
    (Math.cos(phi) * Math.cos(declination))
  if (!(Math.abs(cosH) <= 1)) return null
  const h = Math.acos(cosH) / DEG / 15
  return { sunrise: 12 - h, sunset: 12 + h }
}

/** Simulated solar time at the view. */
export function viewSolarHours(): number {
  const date = getSimulatedDate()
  // Before the view is placed: your own clock.
  if (lightAnchor.lengthSq() < 1) return date.getHours() + date.getMinutes() / 60
  return solarHours(date, viewLatLon().lon)
}

/** Sets the simulated clock so it is `hours` solar time at the view. */
export function setViewSolarHours(hours: number): void {
  const now = solarHours(new Date(), viewLatLon().lon)
  const delta = ((((hours - now) % 24) + 36) % 24) - 12
  settingsStore.set({ timeOffsetMs: delta * HOUR })
}

export function formatHours(hours: number): string {
  const total = Math.round(hours * 60) % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Presets for the time chips, at the view's latitude and date. */
export function timePresets(): Array<{ id: string; label: string; hours: number }> {
  const date = getSimulatedDate()
  const sun = sunTimes(date, viewLatLon().lat) ?? { sunrise: 6, sunset: 18 }
  return [
    { id: 'sunrise', label: 'Sunrise', hours: sun.sunrise + 0.3 },
    { id: 'midday', label: 'Midday', hours: 12.5 },
    { id: 'sunset', label: 'Sunset', hours: sun.sunset - 0.25 },
    { id: 'night', label: 'Night', hours: (sun.sunset + 3.5) % 24 }
  ]
}
