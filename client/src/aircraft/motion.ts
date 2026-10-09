import {
  DEG,
  feetPerMinuteToMetersPerSecond,
  feetToMeters,
  geoidHeight,
  knotsToMetersPerSecond,
  WGS84_A,
  WGS84_E2,
  type AircraftState
} from '@windowseat/shared'

/**
 * Aircraft motion: converts ADS-B states into kinematic samples (geodetic
 * position + ENU velocity, SI units, ellipsoid heights) and evaluates a
 * smooth trajectory at a render time some seconds behind the newest data,
 * like a netcode interpolation buffer.
 */

export interface MotionSample {
  /** Epoch ms. */
  t: number
  lat: number
  lon: number
  /** Meters above the WGS84 ellipsoid. */
  height: number
  /** m/s north, east, up. */
  vn: number
  ve: number
  vu: number
  onGround: boolean
}

export interface KinematicState {
  lat: number
  lon: number
  height: number
  vn: number
  ve: number
  vu: number
  onGround: boolean
  /** Seconds the evaluation is past the newest sample (0 when interpolating). */
  extrapolation: number
}

/** Radii of curvature: meters per radian of latitude / longitude at `lat`. */
export function metersPerRadian(latDeg: number): { north: number; east: number } {
  const s = Math.sin(latDeg * DEG)
  const w = Math.sqrt(1 - WGS84_E2 * s * s)
  const meridian = (WGS84_A * (1 - WGS84_E2)) / (w * w * w)
  const prime = WGS84_A / w
  return { north: meridian, east: prime * Math.cos(latDeg * DEG) }
}

export interface HeightContext {
  /**
   * Ellipsoid height of the ground under an on-ground aircraft (from tile
   * raycasts), if known.
   */
  groundHeight?: (hex: string, lat: number, lon: number) => number | null
  /**
   * Per-aircraft offset geometric − barometric altitude (feet) learned from
   * states that reported both; corrects baro-only states.
   */
  baroOffsetFt?: number | null
}

/**
 * Best ellipsoid height for a state:
 * - on ground: tile raycast height, else the geoid (sea level);
 * - alt_geom (readsb: WGS84 ellipsoid height) when present;
 * - else alt_baro (pressure altitude ≈ MSL) + learned geom−baro offset + geoid.
 */
export function stateEllipsoidHeight(state: AircraftState, context: HeightContext = {}): number {
  if (state.onGround) {
    return context.groundHeight?.(state.hex, state.lat, state.lon) ?? geoidHeight(state.lat, state.lon)
  }
  if (state.altGeom != null) return feetToMeters(state.altGeom)
  if (state.altBaro != null) {
    if (context.baroOffsetFt != null) return feetToMeters(state.altBaro + context.baroOffsetFt)
    return feetToMeters(state.altBaro) + geoidHeight(state.lat, state.lon)
  }
  return geoidHeight(state.lat, state.lon)
}

export function toSample(state: AircraftState, height: number): MotionSample {
  const speed = knotsToMetersPerSecond(state.groundSpeed ?? 0)
  const track = (state.track ?? 0) * DEG
  return {
    t: state.positionTimestamp,
    lat: state.lat,
    lon: state.lon,
    height,
    vn: speed * Math.cos(track),
    ve: speed * Math.sin(track),
    vu: state.onGround ? 0 : feetPerMinuteToMetersPerSecond(state.verticalRate ?? 0),
    onGround: state.onGround
  }
}

/** Longitude difference b − a wrapped to (−180, 180]. */
function lonDelta(a: number, b: number): number {
  let d = b - a
  if (d > 180) d -= 360
  else if (d <= -180) d += 360
  return d
}

export interface MotionOptions {
  /** Longest forward extrapolation past the newest sample, seconds. */
  maxExtrapolation: number
  /**
   * Longest vertical extrapolation, seconds: climb/descent rates change
   * quickly (flare, level-off), so height is only extrapolated briefly.
   */
  maxVerticalExtrapolation: number
  /** Longest backward extrapolation before the first sample, seconds. */
  maxBackfill: number
  /**
   * Segments implying a speed above this (m/s) are treated as a data jump
   * and not interpolated across.
   */
  maxPlausibleSpeed: number
}

export const defaultMotionOptions: MotionOptions = {
  maxExtrapolation: 20,
  maxVerticalExtrapolation: 4,
  maxBackfill: 15,
  maxPlausibleSpeed: 450
}

function linear(
  s: MotionSample,
  dtSeconds: number,
  out: KinematicState,
  extrapolation: number,
  maxVertical = Infinity
): KinematicState {
  const m = metersPerRadian(s.lat)
  out.lat = s.lat + ((s.vn * dtSeconds) / m.north) / DEG
  out.lon = s.lon + ((s.ve * dtSeconds) / m.east) / DEG
  const dtVertical = Math.sign(dtSeconds) * Math.min(Math.abs(dtSeconds), maxVertical)
  out.height = s.height + s.vu * dtVertical
  out.vn = s.vn
  out.ve = s.ve
  out.vu = s.vu
  out.onGround = s.onGround
  out.extrapolation = extrapolation
  return out
}

/**
 * Cubic Hermite between two samples in a local tangent frame at the first,
 * using each sample's reported velocity as the tangent. Positions and
 * velocities are continuous across samples, so motion has no visible kinks.
 */
export function hermite(
  a: MotionSample,
  b: MotionSample,
  t: number,
  out: KinematicState
): KinematicState {
  const dt = (b.t - a.t) / 1000
  const m = metersPerRadian(a.lat)
  // Local offsets of b from a, in meters.
  const n1 = (b.lat - a.lat) * DEG * m.north
  const e1 = lonDelta(a.lon, b.lon) * DEG * m.east
  const u1 = b.height - a.height
  const s = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))
  const s2 = s * s
  const s3 = s2 * s
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  // Derivatives (per unit s); the h00 basis multiplies a zero offset.
  const d10 = 3 * s2 - 4 * s + 1
  const d01 = -6 * s2 + 6 * s
  const d11 = 3 * s2 - 2 * s
  const n = h10 * dt * a.vn + h01 * n1 + h11 * dt * b.vn
  const e = h10 * dt * a.ve + h01 * e1 + h11 * dt * b.ve
  const u = h10 * dt * a.vu + h01 * u1 + h11 * dt * b.vu
  out.lat = a.lat + n / m.north / DEG
  out.lon = a.lon + e / m.east / DEG
  out.height = a.height + u
  // d/dt = (d/ds) / dt.
  out.vn = (d10 * dt * a.vn + d01 * n1 + d11 * dt * b.vn) / dt
  out.ve = (d10 * dt * a.ve + d01 * e1 + d11 * dt * b.ve) / dt
  out.vu = (d10 * dt * a.vu + d01 * u1 + d11 * dt * b.vu) / dt
  out.onGround = s < 0.5 ? a.onGround : b.onGround
  out.extrapolation = 0
  return out
}

function segmentPlausible(a: MotionSample, b: MotionSample, maxSpeed: number): boolean {
  const dt = (b.t - a.t) / 1000
  if (dt <= 0) return false
  const m = metersPerRadian(a.lat)
  const dn = (b.lat - a.lat) * DEG * m.north
  const de = lonDelta(a.lon, b.lon) * DEG * m.east
  const du = b.height - a.height
  return Math.sqrt(dn * dn + de * de + du * du) / dt <= maxSpeed
}

/**
 * Evaluates the trajectory at time `t` (epoch ms). Samples must be sorted by
 * time. Returns null when there are no samples.
 */
export function evaluateMotion(
  samples: readonly MotionSample[],
  t: number,
  out: KinematicState,
  options: MotionOptions = defaultMotionOptions
): KinematicState | null {
  const count = samples.length
  if (count === 0) return null
  const first = samples[0]!
  const last = samples[count - 1]!
  if (t <= first.t) {
    const back = Math.max(-options.maxBackfill, (t - first.t) / 1000)
    return linear(first, back, out, 0, options.maxVerticalExtrapolation)
  }
  if (t >= last.t) {
    const ahead = (t - last.t) / 1000
    return linear(
      last,
      Math.min(ahead, options.maxExtrapolation),
      out,
      ahead,
      options.maxVerticalExtrapolation
    )
  }
  // Newest segments are the most likely to contain t: search backwards.
  let i = count - 2
  while (i > 0 && samples[i]!.t > t) --i
  const a = samples[i]!
  const b = samples[i + 1]!
  if (!segmentPlausible(a, b, options.maxPlausibleSpeed)) {
    // A jump in the data: hold the older sample until the newer one is due.
    return linear(a, 0, out, 0)
  }
  return hermite(a, b, t, out)
}

/** Track (degrees from north) of a velocity, or null when too slow to tell. */
export function trackOf(vn: number, ve: number, minSpeed = 1.5): number | null {
  if (vn * vn + ve * ve < minSpeed * minSpeed) return null
  return ((Math.atan2(ve, vn) / DEG) % 360 + 360) % 360
}

export const GRAVITY = 9.80665
export const MAX_BANK_DEG = 30
/** Cruise angle of attack added to the flight-path angle. */
export const CRUISE_AOA_DEG = 2.5

/**
 * Coordinated-turn bank angle (degrees, positive = right wing down) for a
 * ground speed (m/s) and turn rate (degrees/s, positive = turning right).
 */
export function bankAngle(speed: number, turnRateDegPerS: number): number {
  const bank = Math.atan((speed * turnRateDegPerS * DEG) / GRAVITY) / DEG
  return Math.max(-MAX_BANK_DEG, Math.min(MAX_BANK_DEG, bank))
}

/**
 * Pitch (degrees, nose up) from the flight-path angle plus angle of attack;
 * the AoA term fades in with airspeed so slow taxiing aircraft stay level.
 */
export function pitchAngle(groundSpeed: number, verticalSpeed: number, onGround: boolean): number {
  if (onGround) return 0
  const gamma = Math.atan2(verticalSpeed, Math.max(1, groundSpeed)) / DEG
  const aoa = CRUISE_AOA_DEG * Math.min(1, groundSpeed / 60)
  return Math.max(-20, Math.min(25, gamma + aoa))
}

/** Exponential smoothing factor for a time constant (s) over a frame (s). */
export function smoothingFactor(dtSeconds: number, timeConstant: number): number {
  return 1 - Math.exp(-dtSeconds / Math.max(1e-3, timeConstant))
}
