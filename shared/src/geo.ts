/**
 * WGS84 geodesy helpers. Angles in the public API are degrees unless the name
 * says otherwise; distances are meters. Functions that run per aircraft per
 * frame write into caller-provided output objects to avoid allocations.
 */

export const WGS84_A = 6_378_137
export const WGS84_F = 1 / 298.257223563
export const WGS84_B = WGS84_A * (1 - WGS84_F)
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)
/** Mean Earth radius (IUGG), used for great-circle approximations. */
export const EARTH_MEAN_RADIUS = 6_371_008.8

export const DEG = Math.PI / 180

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface GeodeticPosition {
  /** Degrees. */
  lat: number
  /** Degrees. */
  lon: number
  /** Meters above the WGS84 ellipsoid. */
  height: number
}

/** Geodetic (degrees, meters above ellipsoid) to Earth-centered, Earth-fixed meters. */
export function geodeticToEcef(
  latDeg: number,
  lonDeg: number,
  height: number,
  out: Vec3 = { x: 0, y: 0, z: 0 }
): Vec3 {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  out.x = (n + height) * cosLat * Math.cos(lon)
  out.y = (n + height) * cosLat * Math.sin(lon)
  out.z = (n * (1 - WGS84_E2) + height) * sinLat
  return out
}

/**
 * ECEF to geodetic using Bowring's method with two refinement steps; error is
 * well below a millimeter for anything between the Earth's center and orbit.
 */
export function ecefToGeodetic(
  x: number,
  y: number,
  z: number,
  out: GeodeticPosition = { lat: 0, lon: 0, height: 0 }
): GeodeticPosition {
  const p = Math.hypot(x, y)
  const lon = Math.atan2(y, x)
  if (p < 1e-9) {
    out.lat = z >= 0 ? 90 : -90
    out.lon = 0
    out.height = Math.abs(z) - WGS84_B
    return out
  }
  const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B)
  let beta = Math.atan2(WGS84_A * z, WGS84_B * p)
  let lat = 0
  for (let i = 0; i < 3; ++i) {
    const sinB = Math.sin(beta)
    const cosB = Math.cos(beta)
    lat = Math.atan2(
      z + ep2 * WGS84_B * sinB * sinB * sinB,
      p - WGS84_E2 * WGS84_A * cosB * cosB * cosB
    )
    beta = Math.atan2(WGS84_B * Math.sin(lat), WGS84_A * Math.cos(lat))
  }
  const sinLat = Math.sin(lat)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  // Use the better-conditioned formula depending on latitude.
  const height =
    Math.abs(lat) < Math.PI / 4
      ? p / Math.cos(lat) - n
      : z / sinLat - n * (1 - WGS84_E2)
  out.lat = lat / DEG
  out.lon = lon / DEG
  out.height = height
  return out
}

/** Local East-North-Up unit vectors at a geodetic position, in ECEF. */
export interface EnuBasis {
  east: Vec3
  north: Vec3
  up: Vec3
}

export function enuBasis(
  latDeg: number,
  lonDeg: number,
  out: EnuBasis = {
    east: { x: 0, y: 0, z: 0 },
    north: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 0 }
  }
): EnuBasis {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const sinLon = Math.sin(lon)
  const cosLon = Math.cos(lon)
  out.east.x = -sinLon
  out.east.y = cosLon
  out.east.z = 0
  out.north.x = -sinLat * cosLon
  out.north.y = -sinLat * sinLon
  out.north.z = cosLat
  out.up.x = cosLat * cosLon
  out.up.y = cosLat * sinLon
  out.up.z = sinLat
  return out
}

/** Great-circle distance in meters (haversine on the mean sphere). */
export function greatCircleDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = (lat2 - lat1) * DEG
  const dLon = (lon2 - lon1) * DEG
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_MEAN_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Initial great-circle bearing from point 1 to point 2, degrees [0, 360). */
export function initialBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const φ1 = lat1 * DEG
  const φ2 = lat2 * DEG
  const Δλ = (lon2 - lon1) * DEG
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) / DEG + 360) % 360
}

/** Point reached from (lat, lon) after `distance` meters along `bearing` degrees. */
export function destinationPoint(
  lat: number,
  lon: number,
  bearing: number,
  distance: number
): { lat: number; lon: number } {
  const δ = distance / EARTH_MEAN_RADIUS
  const θ = bearing * DEG
  const φ1 = lat * DEG
  const λ1 = lon * DEG
  const sinφ2 =
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)))
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * sinφ2
    )
  return { lat: φ2 / DEG, lon: normalizeLongitude(λ2 / DEG) }
}

/** Wraps a longitude into [-180, 180). */
export function normalizeLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/** Signed smallest difference b - a between two angles in degrees, in (-180, 180]. */
export function angleDifference(a: number, b: number): number {
  const d = (((b - a) % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}
