import { GEOID_BASE64, GEOID_COLS, GEOID_ROWS } from './geoidGrid'

let grid: Int16Array | null = null

function decode(): Int16Array {
  const binary = atob(GEOID_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i)
  // Little-endian int16 (matches every platform we run on).
  return new Int16Array(bytes.buffer)
}

/**
 * EGM96 geoid undulation N in meters (mean sea level above the WGS84
 * ellipsoid), bilinear on a 1° grid; within ~1–2 m of the full model.
 * Ellipsoid height h = orthometric (MSL) height H + N.
 */
export function geoidHeight(latDeg: number, lonDeg: number): number {
  grid ??= decode()
  const lat = Math.max(-90, Math.min(90, latDeg))
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180
  const y = lat + 90
  const x = lon + 180
  const r0 = Math.min(GEOID_ROWS - 2, Math.floor(y))
  const c0 = Math.min(GEOID_COLS - 2, Math.floor(x))
  const fy = y - r0
  const fx = x - c0
  const i = r0 * GEOID_COLS + c0
  const v00 = grid[i]!
  const v01 = grid[i + 1]!
  const v10 = grid[i + GEOID_COLS]!
  const v11 = grid[i + GEOID_COLS + 1]!
  const v0 = v00 + (v01 - v00) * fx
  const v1 = v10 + (v11 - v10) * fx
  return (v0 + (v1 - v0) * fy) / 10
}

/** Mean-sea-level (orthometric) height in meters to WGS84 ellipsoid height. */
export function mslToEllipsoid(latDeg: number, lonDeg: number, msl: number): number {
  return msl + geoidHeight(latDeg, lonDeg)
}
