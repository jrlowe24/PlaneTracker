import {
  destinationPoint,
  greatCircleDistance,
  initialBearing,
  METERS_PER_NAUTICAL_MILE,
  type Viewport
} from '@windowseat/shared'

import type { Region } from './sources/types'

/** Largest circle one upstream query can cover (adsb.lol: 250 nm). */
export const MAX_QUERY_RADIUS_NM = 250
const MIN_RADIUS_NM = 10
/** Grid used to snap viewport centers so nearby clients share regions. */
const SNAP_DEGREES = 0.25
const RADIUS_STEP_NM = 25
/**
 * Largest viewport we cover with upstream queries: 7 circles of radius ρ
 * (one central, six at √3·ρ) exactly cover a disc of radius 2ρ. ρ leaves
 * room for snapping (≤ ~11 nm center shift, radius rounded up to 25 nm).
 */
export const MAX_COVERAGE_RADIUS_NM = 2 * (MAX_QUERY_RADIUS_NM - RADIUS_STEP_NM)

function distanceNm(a: Region, b: Region): number {
  return greatCircleDistance(a.lat, a.lon, b.lat, b.lon) / METERS_PER_NAUTICAL_MILE
}

export function regionKey(region: Region): string {
  return `${region.lat.toFixed(3)},${region.lon.toFixed(3)},${Math.round(region.radiusNm)}`
}

/**
 * Snaps a circle to a coarse grid (center to SNAP_DEGREES, radius up to a
 * multiple of RADIUS_STEP_NM) while still containing the original circle, so
 * small camera moves keep the same region keys and their poll schedule.
 */
export function snapRegion(region: Region, maxRadiusNm = MAX_QUERY_RADIUS_NM): Region {
  const lat = Math.max(-89.75, Math.min(89.75, Math.round(region.lat / SNAP_DEGREES) * SNAP_DEGREES))
  const lon = Math.round(region.lon / SNAP_DEGREES) * SNAP_DEGREES
  const snapped = { lat, lon, radiusNm: 0 }
  const needed = region.radiusNm + distanceNm(region, snapped)
  snapped.radiusNm = Math.min(
    maxRadiusNm,
    Math.ceil(needed / RADIUS_STEP_NM) * RADIUS_STEP_NM
  )
  return snapped
}

/** Circles (each ≤ MAX_QUERY_RADIUS_NM) that cover a viewport, capped at MAX_COVERAGE_RADIUS_NM. */
export function viewportToRegions(viewport: Viewport): Region[] {
  const radiusNm = Math.max(
    MIN_RADIUS_NM,
    Math.min(MAX_COVERAGE_RADIUS_NM, viewport.radiusNm)
  )
  if (radiusNm <= MAX_QUERY_RADIUS_NM) {
    return [snapRegion({ lat: viewport.lat, lon: viewport.lon, radiusNm })]
  }
  // Hexagonal 7-circle cover of a disc of radius R with circles of R/2.
  const rho = radiusNm / 2
  const ringMeters = Math.sqrt(3) * rho * METERS_PER_NAUTICAL_MILE
  const circles: Region[] = [{ lat: viewport.lat, lon: viewport.lon, radiusNm: rho }]
  for (let i = 0; i < 6; ++i) {
    const p = destinationPoint(viewport.lat, viewport.lon, i * 60, ringMeters)
    circles.push({ lat: p.lat, lon: p.lon, radiusNm: rho })
  }
  return circles.map(c => snapRegion(c))
}

/** Smallest circle containing both circles (great-circle approximation). */
export function enclosingRegion(a: Region, b: Region): Region {
  const d = distanceNm(a, b)
  if (d + b.radiusNm <= a.radiusNm) return a
  if (d + a.radiusNm <= b.radiusNm) return b
  const radiusNm = (d + a.radiusNm + b.radiusNm) / 2
  const bearing = initialBearing(a.lat, a.lon, b.lat, b.lon)
  const center = destinationPoint(
    a.lat,
    a.lon,
    bearing,
    (radiusNm - a.radiusNm) * METERS_PER_NAUTICAL_MILE
  )
  return { lat: center.lat, lon: center.lon, radiusNm }
}

function contains(outer: Region, inner: Region): boolean {
  return distanceNm(outer, inner) + inner.radiusNm <= outer.radiusNm + 1e-6
}

/**
 * Merges all clients' viewports into a small set of upstream query regions:
 * every viewport is covered, contained circles are dropped, and two circles
 * are merged when one query can cover both without fetching much more area
 * than the two separately.
 */
export function mergeViewports(
  viewports: readonly Viewport[],
  maxAreaGrowth = 1.4
): Region[] {
  let regions = viewports.flatMap(viewportToRegions)

  // Drop duplicates and circles inside other circles.
  regions = regions.filter(
    (r, i) =>
      !regions.some(
        (other, j) =>
          j !== i &&
          contains(other, r) &&
          // Keep the first of two identical circles.
          (!contains(r, other) || j < i)
      )
  )

  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < regions.length; ++i) {
      for (let j = i + 1; j < regions.length; ++j) {
        const a = regions[i]!
        const b = regions[j]!
        const union = enclosingRegion(a, b)
        if (union.radiusNm > MAX_QUERY_RADIUS_NM) continue
        const area = union.radiusNm ** 2
        if (area <= maxAreaGrowth * (a.radiusNm ** 2 + b.radiusNm ** 2)) {
          const snapped = snapRegion(union)
          // Snapping is capped at the query limit; it must still cover both.
          if (!contains(snapped, a) || !contains(snapped, b)) continue
          regions.splice(j, 1)
          regions.splice(i, 1, snapped)
          merged = true
          break outer
        }
      }
    }
  }
  return regions
}
