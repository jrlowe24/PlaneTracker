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
}

export const glowLights: GlowLight[] = []
/** Number of valid entries in glowLights this frame. */
export const glowState = { count: 0 }
