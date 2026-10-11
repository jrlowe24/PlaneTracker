import { angleDifference, DEG } from '@windowseat/shared'

import { loadRunwayCatalog, runwayEndsNear } from '../data/runwayCatalog'

/**
 * Final approach and landing. Reported altitudes are coarse near the
 * ground (25 ft steps, barometric and GNSS errors of tens of feet), so a
 * landing aircraft drawn at its reported height floats over the threshold
 * or sinks into the runway before its "on ground" flag arrives. Aircraft
 * lined up with a runway end and descending are drawn on a 3° glide path
 * to that end, crossing the threshold at 50 ft and flaring onto the
 * surface, blended in with distance to the threshold and only while the
 * reported height agrees with the path (a go-around or an overflight
 * keeps its own height).
 */

void loadRunwayCatalog()

const GLIDE_SLOPE = Math.tan(3 * DEG)
/** Threshold crossing height (50 ft), meters. */
const THRESHOLD_HEIGHT = 15
/** Past the threshold, the wheels meet the runway this far along, meters. */
const FLARE_LENGTH = 450
/** Approach considered from this far out, full weight within FULL_WITHIN. */
const APPROACH_FROM = 10_000
const FULL_WITHIN = 4000
/** Lined up: heading within this of the runway (degrees). */
const MAX_HEADING_OFF = 20
/** Lateral tolerance at the threshold (m), widening with distance. */
const CROSS_TOLERANCE = 150
const CROSS_WIDENING = 0.1
/** Reported height this far off the path (m) means not landing here. */
const MAX_DEVIATION = 120
/** Climbing faster than this (m/s): departing, not landing. */
const MAX_CLIMB = 1.5

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export interface GlidePath {
  /** Ellipsoid height of the wheels on the path, meters. */
  height: number
  /** Vertical speed along the path, m/s. */
  verticalSpeed: number
  /** 0 (reported height) … 1 (on the path). */
  weight: number
}

const result: GlidePath = { height: 0, verticalSpeed: 0, weight: 0 }

/**
 * The glide path for an aircraft at this position, heading and height
 * (ellipsoid, meters), or null when it isn't on final to a known runway.
 * `surface` is the measured ground height under it, when known.
 */
export function glidePath(
  lat: number,
  lon: number,
  heading: number,
  height: number,
  verticalSpeed: number,
  speed: number,
  surface: number | null
): GlidePath | null {
  if (verticalSpeed > MAX_CLIMB) return null
  const mNorth = 111_320
  const mEast = 111_320 * Math.cos(lat * DEG)
  let best: GlidePath | null = null
  for (const end of runwayEndsNear(lat, lon)) {
    if (Math.abs(angleDifference(heading, end.bearing)) > MAX_HEADING_OFF) continue
    const dn = (lat - end.lat) * mNorth
    const de = (lon - end.lon) * mEast
    const b = end.bearing * DEG
    const along = dn * Math.cos(b) + de * Math.sin(b)
    if (along < -APPROACH_FROM || along > end.length) continue
    const cross = Math.abs(-dn * Math.sin(b) + de * Math.cos(b))
    if (cross > CROSS_TOLERANCE + Math.max(0, -along) * CROSS_WIDENING) continue
    // Over and just before the runway, the measured surface is the
    // reference (what's drawn); farther out, the listed threshold height.
    const reference = surface != null && along > -600 ? surface : end.height
    let target: number
    let slope: number
    if (along < 0) {
      target = reference + THRESHOLD_HEIGHT - along * GLIDE_SLOPE
      slope = GLIDE_SLOPE
    } else {
      const flare = smoothstep(0, FLARE_LENGTH, along)
      target = reference + THRESHOLD_HEIGHT * (1 - flare)
      slope = (THRESHOLD_HEIGHT / FLARE_LENGTH) * 1.5 * (1 - flare) * flare * 4
    }
    const deviation = Math.abs(height - target)
    if (deviation > MAX_DEVIATION) continue
    const weight =
      (1 - smoothstep(FULL_WITHIN, APPROACH_FROM, -along)) *
      (1 - smoothstep(MAX_DEVIATION * 0.5, MAX_DEVIATION, deviation))
    if (best == null || weight > best.weight) {
      result.height = target
      result.verticalSpeed = -speed * slope
      result.weight = weight
      best = result
    }
  }
  return best != null && best.weight > 0 ? best : null
}
