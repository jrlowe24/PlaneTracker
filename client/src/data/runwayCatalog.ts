import { DEG, geoidHeight } from '@windowseat/shared'

/**
 * Worldwide lit runways (OurAirports, built at deploy time by
 * scripts/build-runways.mjs): [lat1, lon1, lat2, lon2, lighting,
 * elevation1, elevation2] (degrees; meters above sea level or null).
 * Loaded once, shared by the runway lights and the approach model.
 */
export type CatalogEntry = [number, number, number, number, number, number | null, number | null]

const CATALOG_URL = '/runways/runways.json'

let loading: Promise<CatalogEntry[]> | null = null

export function loadRunwayCatalog(): Promise<CatalogEntry[]> {
  loading ??= fetch(CATALOG_URL)
    .then(async response => (response.ok ? ((await response.json()) as CatalogEntry[]) : []))
    .catch(() => [])
    .then(list => {
      index(list)
      return list
    })
  return loading
}

/** A runway end and the direction of landing on it. */
export interface RunwayEnd {
  lat: number
  lon: number
  /** Ellipsoid height of the threshold, meters. */
  height: number
  /** Landing direction, degrees from true north. */
  bearing: number
  /** Runway length, meters. */
  length: number
}

/** Runways by 1° cell, both landing directions. */
const cells = new Map<number, RunwayEnd[]>()

function cellKey(lat: number, lon: number): number {
  return Math.floor(lat + 90) * 400 + Math.floor(lon + 180)
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG)
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG)
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360
}

function index(list: readonly CatalogEntry[]): void {
  for (const [lat1, lon1, lat2, lon2, , e1, e2] of list) {
    const geoid = geoidHeight((lat1 + lat2) / 2, (lon1 + lon2) / 2)
    const h1 = (e1 ?? e2 ?? 0) + geoid
    const h2 = (e2 ?? e1 ?? 0) + geoid
    const n = (lat2 - lat1) * 111_320
    const e = (lon2 - lon1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * DEG)
    const length = Math.hypot(n, e)
    const ends: RunwayEnd[] = [
      { lat: lat1, lon: lon1, height: h1, bearing: bearing(lat1, lon1, lat2, lon2), length },
      { lat: lat2, lon: lon2, height: h2, bearing: bearing(lat2, lon2, lat1, lon1), length }
    ]
    const key = cellKey((lat1 + lat2) / 2, (lon1 + lon2) / 2)
    let cell = cells.get(key)
    if (cell == null) cells.set(key, (cell = []))
    cell.push(...ends)
  }
}

const nearby: RunwayEnd[] = []

/** Runway ends within about a degree of a point (after the catalog loaded). */
export function runwayEndsNear(lat: number, lon: number): readonly RunwayEnd[] {
  nearby.length = 0
  const la = Math.floor(lat + 90)
  const lo = Math.floor(lon + 180)
  for (let dy = -1; dy <= 1; ++dy) {
    for (let dx = -1; dx <= 1; ++dx) {
      const cell = cells.get((la + dy) * 400 + ((lo + dx + 360) % 360))
      if (cell != null) nearby.push(...cell)
    }
  }
  return nearby
}
