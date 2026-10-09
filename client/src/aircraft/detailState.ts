import type { Vector3 } from 'three'

/** Hex codes currently drawn as detailed models (their instances are hidden). */
export const detailedHexes = new Set<string>()

/**
 * Light positions on a glTF model, body frame (meters; +X left, +Y up, +Z
 * forward): left wingtip (the right one mirrors it), tail, and the top and
 * bottom anti-collision beacons.
 */
export interface LightAnchors {
  wingtip: Vector3
  tail: Vector3
  top: Vector3
  bottom: Vector3
}

/**
 * Light anchors of aircraft drawn with a glTF model (scaled to the type), so
 * nav lights sit on that model instead of the class placeholder's shape.
 */
export const modelLightAnchors = new Map<string, LightAnchors>()
