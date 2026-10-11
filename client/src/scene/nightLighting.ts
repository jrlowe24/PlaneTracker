import { Vector3 } from 'three'

/**
 * Night illumination the atmosphere library doesn't provide.
 *
 * takram's atmosphere lights the ground with the sun and the sky it
 * scatters, and draws the moon as a disc, but nothing lights the night: the
 * world goes pitch black after twilight. Real nights have moonlight (up to
 * ~0.25 lux at full moon) and a floor of starlight/airglow, and our eyes
 * adapt by orders of magnitude. This module computes, per frame:
 *
 * - `ambient`: extra irradiance on the ground and aircraft (moonlight scaled
 *   by phase and elevation, plus a starlight floor), slightly blue;
 * - `sky`: a faint night-sky glow added behind the stars;
 * - `exposureGain`: eye adaptation — exposure eases up as the sun sets.
 *
 * Values are perceptual rather than photometric: a full-moon night reads at
 * roughly 1/100 of daylight after adaptation.
 */
export const nightState = {
  ambient: new Vector3(),
  sky: new Vector3(),
  exposureGain: 1,
  /** 0 by day, 1 at full night (sun ≥ ~12° below the horizon). */
  night: 0,
  /** Moonlight irradiance (phase, elevation and night included). */
  moon: 0
}

/** Irradiance of a full moon high in the sky (renderer units; sun ≈ 1.5). */
const FULL_MOON = 0.012
/**
 * Starlight + airglow + diffuse sky glow floor. Perceptual: with full eye
 * adaptation a moonless night reads at ~1/30 of daylight, so terrain stays
 * faintly legible.
 */
export const STARLIGHT = 0.002
export const MOON_TINT = new Vector3(0.82, 0.9, 1.0)
export const STAR_TINT = new Vector3(0.6, 0.72, 1.0)
const SKY_GLOW = new Vector3(0.00008, 0.00013, 0.0003)
/** Exposure multiplier at full night. */
const MAX_GAIN = 4
const ADAPTATION_TIME = 1.5

const up = new Vector3()

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function updateNightLighting(
  observer: Vector3,
  sunDirection: Vector3,
  moonDirection: Vector3,
  dt: number
): void {
  up.copy(observer).normalize()
  const sunUp = sunDirection.dot(up)
  // Civil twilight → astronomical night.
  const night = smoothstep(0.02, -0.2, sunUp)
  nightState.night = night

  // Illuminated fraction: full when the moon is opposite the sun.
  const phase = (1 - sunDirection.dot(moonDirection)) / 2
  const moonUp = smoothstep(-0.02, 0.25, moonDirection.dot(up))
  const moon = FULL_MOON * phase * moonUp * night
  const stars = STARLIGHT * night
  nightState.ambient.copy(MOON_TINT).multiplyScalar(moon).addScaledVector(STAR_TINT, stars)
  nightState.moon = moon
  nightState.sky.copy(SKY_GLOW).multiplyScalar(night * (1 + 4 * phase * moonUp))

  const targetGain = 1 + (MAX_GAIN - 1) * night
  const k = 1 - Math.exp(-dt / ADAPTATION_TIME)
  nightState.exposureGain += (targetGain - nightState.exposureGain) * k
}
