import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isAirlineCallsign, type RouteAirport, type RouteInfo } from '@windowseat/shared'

import { USER_AGENT } from './sources/adsbLol'

/**
 * Callsign → scheduled route, from vradarserver's standing data (CC0) as
 * static JSON files mirrored by adsb.lol. (adsb.lol's batch
 * `POST /api/0/routeset` returns an empty 201 to anonymous clients as of
 * October 2026; the per-callsign files are what it redirects to anyway.)
 *
 * One request at a time, spaced out; results cached in memory and on disk
 * (positive 12 h, negative 6 h) so restarts and replay loops don't refetch.
 */

const BASE_URL = 'https://vrs-standing-data.adsb.lol/routes'
const POSITIVE_TTL_MS = 12 * 3600_000
const NEGATIVE_TTL_MS = 6 * 3600_000
const REQUEST_SPACING_MS = 400
const MAX_QUEUE = 500

interface CacheEntry {
  route: RouteInfo | null
  fetchedAt: number
}

interface StandingDataAirport {
  icao?: string
  iata?: string
  name?: string
  location?: string
  countryiso2?: string
  lat?: number
  lon?: number
}

interface StandingDataRoute {
  callsign?: string
  _airports?: StandingDataAirport[]
}

export function parseStandingDataRoute(callsign: string, body: StandingDataRoute): RouteInfo | null {
  const airports: RouteAirport[] = []
  for (const a of body._airports ?? []) {
    if (a.icao == null || typeof a.lat !== 'number' || typeof a.lon !== 'number') continue
    airports.push({
      icao: a.icao,
      iata: a.iata != null && a.iata !== '' ? a.iata : null,
      name: a.name ?? a.icao,
      location: a.location ?? null,
      countryiso2: a.countryiso2 ?? null,
      lat: a.lat,
      lon: a.lon
    })
  }
  return airports.length >= 2 ? { callsign, airports } : null
}

export class RouteResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly cachePath: string | null = null) {
    if (cachePath != null) {
      try {
        const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, CacheEntry>
        for (const [callsign, entry] of Object.entries(saved)) this.cache.set(callsign, entry)
      } catch {
        // No cache yet.
      }
    }
  }

  start(): void {
    this.timer ??= setInterval(() => {
      void this.work()
    }, REQUEST_SPACING_MS)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }

  /** Cached route (undefined = unknown yet, null = no route). Queues a lookup if needed. */
  get(callsign: string | null): RouteInfo | null | undefined {
    if (!isAirlineCallsign(callsign)) return null
    const entry = this.cache.get(callsign)
    const ttl = entry?.route == null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS
    if (entry != null && Date.now() - entry.fetchedAt < ttl) return entry.route
    if (!this.queued.has(callsign) && this.queue.length < MAX_QUEUE) {
      this.queued.add(callsign)
      this.queue.push(callsign)
    }
    return entry?.route
  }

  private async work(): Promise<void> {
    if (this.busy) return
    const callsign = this.queue.shift()
    if (callsign == null) return
    this.busy = true
    try {
      const response = await fetch(`${BASE_URL}/${callsign.slice(0, 2)}/${callsign}.json`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(8000)
      })
      if (response.status === 404) {
        this.store(callsign, null)
      } else if (response.ok) {
        this.store(callsign, parseStandingDataRoute(callsign, (await response.json()) as StandingDataRoute))
      } else {
        console.warn(`[routes] ${response.status} for ${callsign}`)
      }
    } catch (error) {
      console.warn(`[routes] ${callsign}:`, error instanceof Error ? error.message : error)
    } finally {
      this.queued.delete(callsign)
      this.busy = false
    }
  }

  private store(callsign: string, route: RouteInfo | null): void {
    this.cache.set(callsign, { route, fetchedAt: Date.now() })
    if (this.cachePath == null || this.saveTimer != null) return
    // Debounced write so a burst of lookups is one file write.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        mkdirSync(dirname(this.cachePath!), { recursive: true })
        writeFileSync(this.cachePath!, JSON.stringify(Object.fromEntries(this.cache)))
      } catch (error) {
        console.warn('[routes] could not write cache:', error)
      }
    }, 5000)
  }
}
