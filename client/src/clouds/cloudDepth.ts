import type { Texture, Vector3 } from 'three'

/** A cloud layer's extent (m above the ellipsoid) and how opaque it is overall. */
export interface CloudSlab {
  bottom: number
  top: number
  /** 0 … 1: chance a line of sight through the slab is blocked. */
  opacity: number
  /** Index of the layer (0 low, 1 mid, 2 cirrus) for local cover. */
  layer: number
}

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
  /** The cloud layers now (for CPU-side occlusion: nav light halos). */
  slabs: CloudSlab[]
  /** Local cover per layer at an ECEF point (regional weather), if known. */
  coverAt: ((point: Vector3) => [low: number, mid: number, high: number] | null) | null
} = { texture: null, fade: 1, baseAltitude: 0, slabs: [], coverAt: null }

/**
 * How much of a light at `point` (ellipsoid height `height`) shows through
 * the clouds to a camera at `cameraHeight`: each layer between them blocks
 * by its cover there (a solid deck hides it, broken cloud in part).
 */
export function cloudTransmittance(point: Vector3, height: number, cameraHeight: number): number {
  const fade = cloudDepth.fade
  if (fade <= 0 || cloudDepth.slabs.length === 0) return 1
  const lo = Math.min(height, cameraHeight)
  const hi = Math.max(height, cameraHeight)
  let local: [number, number, number] | null | undefined
  let t = 1
  for (const slab of cloudDepth.slabs) {
    const crossed = Math.min(hi, slab.top) - Math.max(lo, slab.bottom)
    if (crossed <= 0) continue
    local ??= cloudDepth.coverAt?.(point) ?? null
    const cover = local != null ? local[slab.layer]! : slab.opacity
    // Through most of a layer's depth, a gap is needed to see through.
    const depth = Math.min(1, crossed / Math.max(1, slab.top - slab.bottom) * 2)
    t *= 1 - Math.min(1, cover * (slab.layer === 2 ? 0.25 : 1) * depth * fade) ** 0.7
  }
  return t
}
