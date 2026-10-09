import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import type { PerspectiveCamera } from 'three'

import { flightConnection } from '../data/flightConnection'
import { followAircraft } from '../state/cameraMode'
import { selectionStore } from '../state/selection'

/**
 * Camera jumps to anywhere on the globe (worldwide search results, airport
 * shortcuts). The live view only receives traffic around the camera, so to
 * follow an aircraft found elsewhere we first move the camera over it; it
 * is followed as soon as its data arrives.
 */

export interface JumpTarget {
  lat: number
  lon: number
  /** Meters above the ellipsoid of the point looked at. */
  height?: number
  /** Camera distance from that point, meters. */
  distance?: number
  /** Degrees. */
  heading?: number
  /** Degrees (negative looks down). */
  pitch?: number
}

/** Give up waiting for a jumped-to aircraft after this long. */
const FOLLOW_TIMEOUT_MS = 45_000

let pendingJump: JumpTarget | null = null
let pendingFollow: { hex: string; until: number } | null = null

export function jumpTo(target: JumpTarget, followHex?: string): void {
  pendingJump = target
  pendingFollow = followHex == null ? null : { hex: followHex, until: Date.now() + FOLLOW_TIMEOUT_MS }
  if (followHex != null) selectionStore.set({ selectedHex: followHex })
}

/** Aircraft waiting to be followed after a jump, if any. */
export function pendingFollowHex(): string | null {
  return pendingFollow?.hex ?? null
}

/** Takes the pending camera jump (CameraRig applies it), if any. */
export function takeJump(): JumpTarget | null {
  const jump = pendingJump
  pendingJump = null
  return jump
}

/** Places the camera for a jump. */
export function applyJump(camera: PerspectiveCamera, target: JumpTarget): void {
  const { lat, lon, height = 0, distance = 40_000, heading = 0, pitch = -45 } = target
  new PointOfView(distance, radians(heading), radians(pitch)).decompose(
    new Geodetic(radians(lon), radians(lat), height).toECEF(),
    camera.position,
    camera.quaternion,
    camera.up
  )
  camera.updateMatrixWorld()
}

/** Follows the jumped-to aircraft once it has a pose (call every frame). */
export function updatePendingFollow(): void {
  if (pendingFollow == null) return
  if (Date.now() > pendingFollow.until) {
    pendingFollow = null
    return
  }
  const aircraft = flightConnection.registry.byHex.get(pendingFollow.hex)
  if (aircraft?.pose == null) return
  followAircraft(pendingFollow.hex)
  pendingFollow = null
}
