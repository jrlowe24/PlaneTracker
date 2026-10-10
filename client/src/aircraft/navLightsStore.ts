import { Vector3, Vector4 } from 'three'

/**
 * Nav light positions for the glow post effect, refilled every frame by
 * NavLights: camera-relative position (m), distance, and color (radiance,
 * already scaled for exposure and visibility).
 */
export interface GlowLight {
  x: number
  y: number
  z: number
  distance: number
  r: number
  g: number
  b: number
  /** Halo size relative to a steady nav light (strobes flare wider). */
  size: number
}

export const glowLights: GlowLight[] = []
/** Number of valid entries in glowLights this frame. */
export const glowState = { count: 0 }

/** Nav lights that light the detailed aircraft models around them. */
export const MAX_SURFACE_LIGHTS = 10

/**
 * Shared by every detailed model's material (aircraftMaterial.ts):
 * camera-relative position (m) with range (m) in w, and intensity
 * (renderer irradiance at 1 m) per light. Range 0 = unused.
 */
export const surfaceLights = {
  position: Array.from({ length: MAX_SURFACE_LIGHTS }, () => new Vector4()),
  color: Array.from({ length: MAX_SURFACE_LIGHTS }, () => new Vector3())
}
