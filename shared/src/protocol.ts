import type { AircraftState } from './aircraft'
import type { RouteInfo } from './routes'
import type { WeatherGridCell, WeatherSample } from './weather'

/**
 * WebSocket protocol between client and server (JSON text frames).
 *
 * Aircraft travel as positional tuples instead of objects: with thousands of
 * aircraft at 1 Hz the repeated key names would dominate the payload. Units
 * are unchanged (feet, knots, ft/min, degrees).
 */

/** What a client is looking at: a ground circle. */
export interface Viewport {
  /** Degrees. */
  lat: number
  /** Degrees. */
  lon: number
  /** Nautical miles. */
  radiusNm: number
}

export type ClientMessage =
  | { type: 'viewport'; viewport: Viewport }
  /** The aircraft this client's camera is attached to (null = none). */
  | { type: 'follow'; hex: string | null }

export interface Attribution {
  text: string
  url: string | null
}

export interface HelloMessage {
  type: 'hello'
  serverTime: number
  /** Name of the upstream source, e.g. "adsb.lol" or "replay". */
  source: string
  /** Attribution line the client must show for this source. */
  attribution: string
  attributionUrl: string | null
  /**
   * Extra source used for followed aircraft (fast updates), if any; shown
   * while the client follows an aircraft.
   */
  followAttribution: Attribution | null
}

export interface AircraftMessage {
  type: 'aircraft'
  serverTime: number
  /** True when the client should discard everything it has first. */
  reset: boolean
  upserts: AircraftTuple[]
  /** Hex codes that left the viewport or went stale. */
  removals: string[]
}

/** Routes for callsigns in the client's view (sent once per callsign). */
export interface RoutesMessage {
  type: 'routes'
  serverTime: number
  routes: RouteInfo[]
}

/** Current weather for the client's view center (drives the clouds). */
export interface WeatherMessage {
  type: 'weather'
  serverTime: number
  weather: WeatherSample
  attribution: Attribution
}

/**
 * Cloud cover on a grid of 1° cells around the view, so clouds vary across
 * the map instead of the whole sky following one sample.
 */
export interface WeatherGridMessage {
  type: 'weatherGrid'
  serverTime: number
  cells: WeatherGridCell[]
}

export type ServerMessage =
  | HelloMessage
  | AircraftMessage
  | RoutesMessage
  | WeatherMessage
  | WeatherGridMessage

export type AircraftTuple = [
  hex: string,
  callsign: string | null,
  registration: string | null,
  typeCode: string | null,
  category: string | null,
  squawk: string | null,
  lat: number,
  lon: number,
  altBaro: number | null,
  altGeom: number | null,
  onGround: 0 | 1,
  groundSpeed: number | null,
  track: number | null,
  verticalRate: number | null,
  positionTimestamp: number
]

function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value == null ? null : round(value, digits)
}

export function encodeAircraft(a: AircraftState): AircraftTuple {
  return [
    a.hex,
    a.callsign,
    a.registration,
    a.typeCode,
    a.category,
    a.squawk,
    // 1e-6° ≈ 0.1 m, finer than ADS-B position resolution.
    round(a.lat, 6),
    round(a.lon, 6),
    a.altBaro,
    a.altGeom,
    a.onGround ? 1 : 0,
    roundOrNull(a.groundSpeed, 1),
    roundOrNull(a.track, 2),
    a.verticalRate,
    a.positionTimestamp
  ]
}

export function decodeAircraft(t: AircraftTuple): AircraftState {
  return {
    hex: t[0],
    callsign: t[1],
    registration: t[2],
    typeCode: t[3],
    category: t[4],
    squawk: t[5],
    lat: t[6],
    lon: t[7],
    altBaro: t[8],
    altGeom: t[9],
    onGround: t[10] === 1,
    groundSpeed: t[11],
    track: t[12],
    verticalRate: t[13],
    positionTimestamp: t[14]
  }
}

/** `GET /api/search?q=` result: aircraft found anywhere in the world. */
export interface SearchResult {
  hex: string
  callsign: string | null
  registration: string | null
  typeCode: string | null
  lat: number
  lon: number
  /** Feet; null on the ground or unknown. */
  altitude: number | null
  onGround: boolean
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  /** True when only already-tracked traffic was searched (no live lookups). */
  localOnly: boolean
}
