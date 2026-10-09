import type { Attribution, WeatherSample } from '@windowseat/shared'

import { USER_AGENT } from './sources/adsbLol'

/**
 * Current weather from Open-Meteo (free, no key; CC BY 4.0, attribution
 * required). Requests are snapped to a 0.25° grid and cached for 15 minutes
 * (the model's time step), so any number of clients cost a handful of
 * requests per hour.
 */

export const OPEN_METEO_ATTRIBUTION: Attribution = {
  text: 'Weather: Open-Meteo.com (CC BY 4.0)',
  url: 'https://open-meteo.com/'
}

const CELL_DEGREES = 0.25
const TTL_MS = 15 * 60_000
const FAILURE_RETRY_MS = 2 * 60_000

interface OpenMeteoResponse {
  latitude: number
  longitude: number
  elevation: number
  current?: {
    time: string
    cloud_cover_low?: number
    cloud_cover_mid?: number
    cloud_cover_high?: number
    temperature_2m?: number
    dew_point_2m?: number
    freezing_level_height?: number | null
  }
}

export function weatherCell(lat: number, lon: number): string {
  const snap = (v: number): string => (Math.round(v / CELL_DEGREES) * CELL_DEGREES).toFixed(2)
  return `${snap(lat)},${snap(lon)}`
}

export function parseOpenMeteo(body: OpenMeteoResponse): WeatherSample | null {
  const c = body.current
  if (c == null) return null
  return {
    lat: body.latitude,
    lon: body.longitude,
    time: Date.parse(`${c.time}Z`),
    elevation: body.elevation,
    cloudCoverLow: c.cloud_cover_low ?? 0,
    cloudCoverMid: c.cloud_cover_mid ?? 0,
    cloudCoverHigh: c.cloud_cover_high ?? 0,
    temperature: c.temperature_2m ?? 15,
    dewPoint: c.dew_point_2m ?? 5,
    freezingLevel: c.freezing_level_height ?? null
  }
}

interface Entry {
  sample: WeatherSample | null
  fetchedAt: number
  pending: Promise<WeatherSample | null> | null
}

export class WeatherService {
  private readonly cache = new Map<string, Entry>()

  /** Cached sample for the cell around (lat, lon), fetching it if stale. */
  async get(lat: number, lon: number): Promise<WeatherSample | null> {
    const cell = weatherCell(lat, lon)
    const entry = this.cache.get(cell)
    const now = Date.now()
    if (entry != null) {
      if (entry.pending != null) return entry.pending
      const ttl = entry.sample == null ? FAILURE_RETRY_MS : TTL_MS
      if (now - entry.fetchedAt < ttl) return entry.sample
    }
    const [cellLat, cellLon] = cell.split(',').map(Number) as [number, number]
    const pending = this.fetch(cellLat, cellLon)
    this.cache.set(cell, { sample: entry?.sample ?? null, fetchedAt: entry?.fetchedAt ?? 0, pending })
    const sample = await pending
    this.cache.set(cell, { sample: sample ?? entry?.sample ?? null, fetchedAt: Date.now(), pending: null })
    return sample ?? entry?.sample ?? null
  }

  private async fetch(lat: number, lon: number): Promise<WeatherSample | null> {
    const params = new URLSearchParams({
      latitude: lat.toFixed(2),
      longitude: lon.toFixed(2),
      current:
        'cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,dew_point_2m,freezing_level_height',
      timezone: 'GMT'
    })
    try {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(8000)
      })
      if (!response.ok) {
        console.warn(`[weather] Open-Meteo ${response.status} for ${lat},${lon}`)
        return null
      }
      return parseOpenMeteo((await response.json()) as OpenMeteoResponse)
    } catch (error) {
      console.warn('[weather]', error instanceof Error ? error.message : error)
      return null
    }
  }
}
