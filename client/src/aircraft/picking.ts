import { WGS84_B } from '@windowseat/shared'
import { Vector3, type PerspectiveCamera } from 'three'

import { aircraftRenderState } from './aircraftRenderState'

const world = new Vector3()
const projected = new Vector3()
const toPoint = new Vector3()

/** True when the segment camera → point passes through the Earth (sphere at the polar radius). */
function occludedByEarth(camera: Vector3, point: Vector3): boolean {
  toPoint.subVectors(point, camera)
  const length = toPoint.length()
  toPoint.divideScalar(length)
  const b = camera.dot(toPoint)
  const c = camera.lengthSq() - WGS84_B * WGS84_B
  const disc = b * b - c
  if (disc <= 0) return false
  const t = -b - Math.sqrt(disc)
  return t > 0 && t < length
}

/**
 * Picks the aircraft nearest to a screen point. Markers can be a few pixels
 * wide, so instead of raycasting their triangles we project every aircraft
 * and take the closest one within `radiusPixels`, preferring nearer aircraft
 * on ties. Aircraft behind the Earth are skipped.
 */
export function pickAircraft(
  camera: PerspectiveCamera,
  pointerX: number,
  pointerY: number,
  width: number,
  height: number,
  radiusPixels = 22
): string | null {
  const { origin, positions, hexes, count } = aircraftRenderState
  let best: string | null = null
  let bestScore = Infinity
  for (let i = 0; i < count; ++i) {
    world.set(
      positions[i * 3]! + origin.x,
      positions[i * 3 + 1]! + origin.y,
      positions[i * 3 + 2]! + origin.z
    )
    projected.copy(world).project(camera)
    if (projected.z < -1 || projected.z > 1) continue
    const sx = (projected.x * 0.5 + 0.5) * width
    const sy = (-projected.y * 0.5 + 0.5) * height
    const d = Math.hypot(sx - pointerX, sy - pointerY)
    if (d > radiusPixels) continue
    // Slight preference for nearer aircraft among close candidates.
    const score = d + projected.z * 4
    if (score < bestScore && !occludedByEarth(camera.position, world)) {
      bestScore = score
      best = hexes[i] ?? null
    }
  }
  return best
}
