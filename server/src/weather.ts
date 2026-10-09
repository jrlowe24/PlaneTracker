import type { Attribution, WeatherGridCell, WeatherSample } from '@windowseat/shared'

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
    cape?: number | null
    weather_code?: number | null
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
    freezingLevel: c.freezing_level_height ?? null,
    cape: c.cape ?? null,
    weatherCode: c.weather_code ?? null
  }
}

interface Entry {
  sample: WeatherSample | null
  fetchedAt: number
  pending: Promise<WeatherSample | null> | null
}

export class WeatherService {
  private readonly cache = new Map<string, Entry>()
  /** Regional cloud cover grid (see WeatherGrid). */
  readonly grid = new WeatherGrid()

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
        'cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,dew_point_2m,freezing_level_height,cape,weather_code',
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

/**
 * Regional cloud cover: 1° cells (integer lat/lon centers) in a square
 * around the view, fetched from Open-Meteo in one multi-location request
 * for whichever cells are missing or older than 30 minutes.
 */
const GRID_TTL_MS = 30 * 60_000
/** Cells from the center cell to the edge: 3 → a 7×7 grid (~770 km). */
export const GRID_RADIUS_CELLS = 3

interface OpenMeteoGridItem {
  latitude: number
  longitude: number
  current?: {
    cloud_cover_low?: number
    cloud_cover_mid?: number
    cloud_cover_high?: number
    cape?: number | null
    weather_code?: number | null
  }
}

const gridKey = (lat: number, lon: number): string => `${lat},${lon}`

/** Integer cell centers of the grid around (lat, lon), longitudes wrapped. */
export function gridCells(lat: number, lon: number, radius = GRID_RADIUS_CELLS): Array<[number, number]> {
  const cLat = Math.round(lat)
  const cLon = Math.round(lon)
  const cells: Array<[number, number]> = []
  for (let dy = -radius; dy <= radius; ++dy) {
    const cellLat = cLat + dy
    if (cellLat < -89 || cellLat > 89) continue
    for (let dx = -radius; dx <= radius; ++dx) {
      const cellLon = ((((cLon + dx + 180) % 360) + 360) % 360) - 180
      cells.push([cellLat, cellLon])
    }
  }
  return cells
}

export class WeatherGrid {
  private readonly cells = new Map<string, { cell: WeatherGridCell; fetchedAt: number }>()
  private pending: Promise<void> | null = null

  /** Cover for the grid around (lat, lon); fetches missing/stale cells. */
  async around(lat: number, lon: number): Promise<WeatherGridCell[]> {
    const wanted = gridCells(lat, lon)
    const now = Date.now()
    const stale = wanted.filter(([a, b]) => {
      const entry = this.cells.get(gridKey(a, b))
      return entry == null || now - entry.fetchedAt > GRID_TTL_MS
    })
    if (stale.length > 0) {
      if (this.pending != null) await this.pending
      this.pending = this.fetch(stale).finally(() => {
        this.pending = null
      })
      await this.pending
    }
    return wanted.flatMap(([a, b]) => {
      const entry = this.cells.get(gridKey(a, b))
      return entry == null ? [] : [entry.cell]
    })
  }

  private async fetch(cells: Array<[number, number]>): Promise<void> {
    const params = new URLSearchParams({
      latitude: cells.map(c => c[0]).join(','),
      longitude: cells.map(c => c[1]).join(','),
      current: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,cape,weather_code',
      timezone: 'GMT'
    })
    try {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        console.warn(`[weather] Open-Meteo grid ${response.status}`)
        return
      }
      const body = (await response.json()) as OpenMeteoGridItem[] | OpenMeteoGridItem
      const items = Array.isArray(body) ? body : [body]
      const now = Date.now()
      items.forEach((item, i) => {
        const [lat, lon] = cells[i]!
        const c = item.current
        if (c == null) return
        this.cells.set(gridKey(lat, lon), {
          cell: {
            lat,
            lon,
            low: c.cloud_cover_low ?? 0,
            mid: c.cloud_cover_mid ?? 0,
            high: c.cloud_cover_high ?? 0,
            cape: c.cape ?? 0,
            code: c.weather_code ?? 0
          },
          fetchedAt: now
        })
      })
      // Bound memory: drop cells not refreshed for a few hours.
      for (const [key, entry] of this.cells) {
        if (now - entry.fetchedAt > 6 * GRID_TTL_MS) this.cells.delete(key)
      }
    } catch (error) {
      console.warn('[weather] grid', error instanceof Error ? error.message : error)
    }
  }
}
