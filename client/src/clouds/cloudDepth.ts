import type { Texture } from 'three'

/**
 * The clouds' own front-depth buffer (r: distance to the first cloud along
 * each ray, or the scene depth where none), at the clouds' render
 * resolution. AerialPerspective uses it to keep upsampled cloud overlay
 * off aircraft that are in front of the clouds.
 */
export const cloudDepth: {
  texture: Texture | null
  /**
   * 1 below ~25 km camera altitude, fading to 0 by ~70 km: volumetric
   * clouds (their overlay, shadows and light shafts) only exist up close;
   * from higher up the tiled cloud noise reads as a uniform blanket.
   */
  fade: number
  /** Low cloud layer base above the ellipsoid (m); 0 when there is none. */
  baseAltitude: number
} = { texture: null, fade: 1, baseAltitude: 0 }
