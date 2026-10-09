import type { AircraftState } from '@windowseat/shared'

import { RegionPoller, UpstreamError, type RegionPollerOptions } from './regionPoller'
import type { FlightSource, FlightSourceListener, Region } from './types'

/**
 * adsb.lol v2 API (https://api.adsb.lol/docs), readsb JSON format.
 *
 * Findings that shape the poller (checked against adsblol/api source):
 * - `GET /v2/point/{lat}/{lon}/{radius}`: radius is an integer in nautical
 *   miles, 0..250.
 * - Responses are cached server-side for 5 s (REDIS_TTL), so polling a region
 *   faster than that only returns the same data.
 * - Rate limits are "dynamic based on load" and not published. Measured
 *   (nginx, per IP): a burst of ~2 requests, then ~1 request per 5 s. We
 *   keep one request in flight, ≥ 5.5 s apart, widen the interval on 429
 *   and back off on 5xx.
 * - Requests need a descriptive User-Agent with contact info; generic ones
 *   get 403 "User-Agent too generic".
 * - Data license: ODbL; attribution is shown on the client.
 */

export const ADSB_LOL_BASE_URL = 'https://api.adsb.lol'
export const ADSB_LOL_MAX_RADIUS_NM = 250

/** Subset of readsb aircraft fields we use. */
export interface ReadsbAircraft {
  hex?: string
  flight?: string
  r?: string
  t?: string
  category?: string
  squawk?: string
  lat?: number
  lon?: number
  /** Feet, or the string "ground". */
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  track?: number
  /** Degrees; mainly reported on the surface where track may be missing. */
  true_heading?: number
  baro_rate?: number
  geom_rate?: number
  /** Seconds since the position was last updated. */
  seen_pos?: number
  /** Seconds since any message. */
  seen?: number
  /** Last known position for aircraft without a current one. */
  lastPosition?: { lat: number; lon: number; seen_pos: number }
}

export interface ReadsbResponse {
  ac?: ReadsbAircraft[]
  /** Server time in epoch milliseconds. */
  now?: number
  msg?: string
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed == null || trimmed === '' ? null : trimmed
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Positions older than this in the upstream response are not useful. */
const MAX_POSITION_AGE_S = 60

/** Normalizes a readsb-format response (adsb.lol, airplanes.live) into AircraftState. */
export function normalizeReadsb(
  response: ReadsbResponse,
  fallbackNow: number
): AircraftState[] {
  const now = finite(response.now) ?? fallbackNow
  const result: AircraftState[] = []
  for (const ac of response.ac ?? []) {
    const hex = ac.hex?.trim().toLowerCase()
    const lat = finite(ac.lat)
    const lon = finite(ac.lon)
    // TIS-B/anonymous addresses start with "~"; they are still unique keys.
    if (hex == null || hex === '' || lat == null || lon == null) continue
    const seenPos = finite(ac.seen_pos) ?? finite(ac.seen) ?? 0
    if (seenPos > MAX_POSITION_AGE_S) continue
    const onGround = ac.alt_baro === 'ground'
    result.push({
      hex,
      callsign: text(ac.flight),
      registration: text(ac.r),
      typeCode: text(ac.t)?.toUpperCase() ?? null,
      category: text(ac.category),
      squawk: text(ac.squawk),
      lat,
      lon,
      altBaro: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
      altGeom: finite(ac.alt_geom),
      onGround,
      groundSpeed: finite(ac.gs),
      // Parked/taxiing aircraft often report a heading but no track.
      track: finite(ac.track) ?? finite(ac.true_heading),
      verticalRate: onGround ? 0 : (finite(ac.baro_rate) ?? finite(ac.geom_rate)),
      positionTimestamp: Math.round(now - seenPos * 1000)
    })
  }
  return result
}

export const USER_AGENT =
  'window-seat/0.1 (+https://github.com/jrlowe24/PlaneTracker)'

export async function fetchAdsbLolPoint(
  region: Region,
  signal: AbortSignal,
  baseUrl = ADSB_LOL_BASE_URL
): Promise<AircraftState[]> {
  const radius = Math.min(
    ADSB_LOL_MAX_RADIUS_NM,
    Math.max(1, Math.ceil(region.radiusNm))
  )
  return fetchAdsbLolPath(
    `/v2/point/${region.lat.toFixed(4)}/${region.lon.toFixed(4)}/${radius}`,
    signal,
    baseUrl
  )
}

/** GET an adsb.lol v2 path returning readsb JSON. */
export async function fetchAdsbLolPath(
  path: string,
  signal: AbortSignal,
  baseUrl = ADSB_LOL_BASE_URL
): Promise<AircraftState[]> {
  const url = `${baseUrl}${path}`
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT }
  })
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new UpstreamError(
      `adsb.lol ${response.status} for ${url}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
    )
  }
  const body = (await response.json()) as ReadsbResponse
  return normalizeReadsb(body, Date.now())
}

export class AdsbLolSource implements FlightSource {
  readonly name = 'adsb.lol'
  readonly attribution = 'Flight data © adsb.lol contributors (ODbL)'
  readonly attributionUrl = 'https://adsb.lol'

  private readonly poller: RegionPoller

  constructor(options: Partial<RegionPollerOptions> = {}) {
    this.poller = new RegionPoller(
      (region, signal) => fetchAdsbLolPoint(region, signal),
      options
    )
  }

  setRegions(regions: Region[]): void {
    this.poller.setRegions(regions)
  }

  /** Worldwide lookup by ICAO type (`/v2/type/A388`), in the poll slot. */
  lookupType(type: string): Promise<AircraftState[]> {
    return this.poller.request(signal => fetchAdsbLolPath(`/v2/type/${encodeURIComponent(type)}`, signal))
  }

  start(listener: FlightSourceListener): void {
    this.poller.start(listener.onAircraft)
  }

  stop(): void {
    this.poller.stop()
  }
}
