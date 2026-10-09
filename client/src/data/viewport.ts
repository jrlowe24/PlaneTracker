import {
  ecefToGeodetic,
  METERS_PER_NAUTICAL_MILE,
  WGS84_A,
  WGS84_B,
  type Viewport
} from '@windowseat/shared'
import { Ray, Vector3, type PerspectiveCamera } from 'three'

const ray = new Ray()
const scaledOrigin = new Vector3()
const scaledDirection = new Vector3()

/**
 * Intersects a ray with the WGS84 ellipsoid (in ECEF). Returns the distance
 * along the ray or null. Done in a space where the ellipsoid is a unit sphere.
 */
export function intersectEllipsoid(
  origin: Vector3,
  direction: Vector3,
  heightOffset = 0
): number | null {
  const a = WGS84_A + heightOffset
  const b = WGS84_B + heightOffset
  scaledOrigin.set(origin.x / a, origin.y / a, origin.z / b)
  scaledDirection.set(direction.x / a, direction.y / a, direction.z / b)
  const A = scaledDirection.dot(scaledDirection)
  const B = 2 * scaledOrigin.dot(scaledDirection)
  const C = scaledOrigin.dot(scaledOrigin) - 1
  const disc = B * B - 4 * A * C
  if (disc < 0) return null
  const sqrt = Math.sqrt(disc)
  const t0 = (-B - sqrt) / (2 * A)
  const t1 = (-B + sqrt) / (2 * A)
  if (t0 > 0) return t0
  if (t1 > 0) return t1
  return null
}

export interface ViewState extends Viewport {
  /** Ground point the view is centered on (ECEF). */
  center: Vector3
}

const forward = new Vector3()
const down = new Vector3()

/**
 * Approximates what the camera sees as a ground circle: centered where the
 * view direction hits the ellipsoid (or below the camera when looking at
 * the sky), with a radius that reaches past the camera's own ground point
 * but never beyond the horizon.
 */
export function computeViewState(camera: PerspectiveCamera, out: ViewState): ViewState {
  camera.getWorldDirection(forward)
  ray.origin.copy(camera.position)
  ray.direction.copy(forward)

  const geodetic = ecefToGeodetic(camera.position.x, camera.position.y, camera.position.z)
  const height = Math.max(1, geodetic.height)
  const horizon = Math.sqrt(2 * WGS84_A * height + height * height)

  let t = intersectEllipsoid(camera.position, forward)
  if (t == null || t > horizon) {
    // Looking above the horizon: center the circle between the camera's ground
    // point and the horizon along the view heading.
    down.copy(camera.position).normalize().multiplyScalar(-1)
    const tDown = intersectEllipsoid(camera.position, down) ?? height
    const groundBelow = camera.position.clone().addScaledVector(down, tDown)
    const horizontal = forward.clone().addScaledVector(down, -forward.dot(down)).normalize()
    out.center.copy(groundBelow).addScaledVector(horizontal, Math.min(horizon, 150_000) / 2)
    t = horizon
  } else {
    out.center.copy(camera.position).addScaledVector(forward, t)
  }
  const center = ecefToGeodetic(out.center.x, out.center.y, out.center.z)
  // Covers the camera's ground point and the visible area beyond the center.
  const radiusMeters = Math.min(horizon, Math.max(20_000, t * 1.3))
  out.lat = center.lat
  out.lon = center.lon
  out.radiusNm = radiusMeters / METERS_PER_NAUTICAL_MILE
  return out
}
