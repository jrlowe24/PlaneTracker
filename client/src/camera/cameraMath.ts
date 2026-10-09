import { DEG, WGS84_A } from '@windowseat/shared'
import { Matrix4, Vector3, type PerspectiveCamera, type Quaternion } from 'three'

import type { Pose } from '../aircraft/pose'

/** Orbit of the chase camera around the followed aircraft. */
export interface Orbit {
  /** Degrees around the aircraft, 0 = directly behind, positive = to its right. */
  yaw: number
  /** Degrees above the aircraft's horizontal plane. */
  pitch: number
  /** Meters from the aircraft. */
  distance: number
}

const forwardH = new Vector3()
const leftH = new Vector3()
const localUp = new Vector3()

/** Level heading frame at the aircraft: forward (no pitch), left, local up. */
export function headingFrame(pose: Pose): { forward: Vector3; left: Vector3; up: Vector3 } {
  const h = pose.heading * DEG
  const lat = pose.lat * DEG
  const lon = pose.lon * DEG
  const east = new Vector3(-Math.sin(lon), Math.cos(lon), 0)
  const north = new Vector3(
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat)
  )
  localUp.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
  forwardH.copy(north).multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h))
  leftH.crossVectors(localUp, forwardH)
  return { forward: forwardH, left: leftH, up: localUp }
}

/** Chase-camera position for an orbit around a pose. */
export function orbitPosition(pose: Pose, orbit: Orbit, out: Vector3): Vector3 {
  const { forward, left, up } = headingFrame(pose)
  const yaw = orbit.yaw * DEG
  const pitch = orbit.pitch * DEG
  const horizontal = Math.cos(pitch) * orbit.distance
  return out
    .copy(pose.position)
    .addScaledVector(forward, -Math.cos(yaw) * horizontal)
    .addScaledVector(left, -Math.sin(yaw) * horizontal)
    .addScaledVector(up, Math.sin(pitch) * orbit.distance)
}

const lookMatrix = new Matrix4()

/** Orientation looking from `eye` at `target` with `up` as the vertical. */
export function lookAtQuaternion(
  eye: Vector3,
  target: Vector3,
  up: Vector3,
  out: Quaternion
): Quaternion {
  lookMatrix.lookAt(eye, target, up)
  return out.setFromRotationMatrix(lookMatrix)
}

/** Horizon distance from a height above the ellipsoid (meters). */
export function horizonDistance(height: number): number {
  const h = Math.max(0, height)
  return Math.sqrt(2 * WGS84_A * h + h * h)
}

/**
 * Near/far planes like GlobeControls: near small enough for close objects,
 * far at the horizon (with a minimum elevation so distant mountains and the
 * far terrain beyond a low camera aren't clipped).
 */
export function setClipPlanes(camera: PerspectiveCamera, near: number): void {
  const height = camera.position.length() - WGS84_A
  camera.near = near
  camera.far = horizonDistance(Math.max(height, 2550)) + 0.1
  camera.updateProjectionMatrix()
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}
