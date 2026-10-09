import { WGS84_A } from '@windowseat/shared'

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Fraction of the sun disc visible from height `height` (m) when the sun's
 * elevation sine relative to the local vertical is `sunDotUp`. Accounts for
 * the horizon dip at altitude (sun still visible below the local horizontal)
 * and the sun's ~0.5° diameter. Three.js directional lights ignore the
 * Earth's shadow; this factor puts it back for aircraft.
 */
export function sunVisibility(sunDotUp: number, height: number): number {
  const h = Math.max(0, height)
  // sin(dip) where cos(dip) = R / (R + h).
  const dip = Math.sqrt(1 - (WGS84_A / (WGS84_A + h)) ** 2)
  return smoothstep(-dip - 0.006, -dip + 0.006, sunDotUp)
}

/**
 * Rough sky brightness factor vs. sun elevation (sine): full daylight sky
 * above ~10°, fading through civil twilight to a dim night floor.
 */
export function skyBrightness(sunDotUp: number): number {
  return 0.002 + smoothstep(-0.2, 0.17, sunDotUp)
}

/** How dark it is for marker glow purposes: 0 by day, 1 at night. */
export function nightFactor(sunDotUp: number): number {
  return smoothstep(0.05, -0.15, sunDotUp)
}

/** Emissive glow of icon-sized markers by day and at night. */
export const GLOW_DAY = 0.03
export const GLOW_NIGHT = 0.6

/**
 * Shading vector (glow, sun visibility, sky scale) for an aircraft at ECEF
 * `position` and ellipsoid `height`. `iconness` is 0 for true-size aircraft
 * and 1 for scaled-up icons; `anchorSky` is skyBrightness at the light
 * anchor (where the SkyLight probe is evaluated).
 */
export function aircraftShading(
  sunX: number,
  sunY: number,
  sunZ: number,
  x: number,
  y: number,
  z: number,
  height: number,
  iconness: number,
  anchorSky: number,
  highlight: boolean,
  out: { x: number; y: number; z: number }
): void {
  const radius = Math.sqrt(x * x + y * y + z * z)
  const sunDotUp = (sunX * x + sunY * y + sunZ * z) / radius
  out.x =
    iconness * (GLOW_DAY + (GLOW_NIGHT - GLOW_DAY) * nightFactor(sunDotUp)) * (highlight ? 2 : 1)
  out.y = sunVisibility(sunDotUp, height)
  out.z = Math.min(4, skyBrightness(sunDotUp) / Math.max(1e-3, anchorSky))
}
