import type { TilesRenderer } from '3d-tiles-renderer'
import { PerspectiveCamera, Quaternion, Vector2, Vector3, type Camera, type WebGLRenderer } from 'three'

import { flightConnection } from '../data/flightConnection'
import { cameraModeStore } from '../state/cameraMode'
import { isMobileDevice } from '../state/quality'

/**
 * Streams terrain ahead of a followed aircraft, the way flight simulators
 * do: a second, lower-resolution camera rides LOOKAHEAD_S seconds ahead of
 * the view along the aircraft's track (same orientation), and the tiles it
 * needs are loaded before the view gets there. Tile fetches are free within
 * a Google session (billing is per root tileset), so this only costs
 * bandwidth and cache.
 */

const LOOKAHEAD_S = 30
/** Lower resolution than the view: coarser tiles ahead are enough to avoid holes and blur. */
const RESOLUTION_SCALE = 0.25
/** Below this ground speed (m/s) there's nothing to stream ahead of. */
const MIN_SPEED = 40

const ahead = new Vector3()

export class TileLookahead {
  private readonly camera = new PerspectiveCamera()
  private active = false

  constructor(private readonly tiles: TilesRenderer) {}

  update(mainCamera: Camera, gl: WebGLRenderer): void {
    const { mode, targetHex } = cameraModeStore.get()
    const pose =
      mode !== 'globe' && targetHex != null ? flightConnection.registry.byHex.get(targetHex)?.pose : null
    const wanted = pose != null && pose.speed > MIN_SPEED && mainCamera instanceof PerspectiveCamera
    if (wanted !== this.active) {
      this.active = wanted
      if (wanted) this.tiles.setCamera(this.camera)
      else this.tiles.deleteCamera(this.camera)
    }
    if (!wanted) return
    const main = mainCamera as PerspectiveCamera
    // Where the view will be: shifted along the aircraft's direction of
    // travel (horizontal component of its forward axis) by speed × time.
    ahead.copy(pose.forward).multiplyScalar(pose.speed * LOOKAHEAD_S)
    const camera = this.camera
    camera.fov = main.fov
    camera.aspect = main.aspect
    camera.near = main.near
    camera.far = main.far
    camera.position.copy(main.position).add(ahead)
    camera.quaternion.copy(main.quaternion)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    const size = gl.getDrawingBufferSize(drawingBuffer)
    this.tiles.setResolution(
      camera,
      Math.max(1, Math.round(size.x * RESOLUTION_SCALE)),
      Math.max(1, Math.round(size.y * RESOLUTION_SCALE))
    )
  }

  dispose(): void {
    if (this.active) this.tiles.deleteCamera(this.camera)
    this.active = false
  }
}

const drawingBuffer = new Vector2()

/** Below this camera altitude (m) the surround ring is kept loaded. */
const SURROUND_MAX_ALTITUDE = 50_000
/** Surround cameras render tiles for this fraction of the screen resolution. */
const SURROUND_RESOLUTION_SCALE = 0.3
const SURROUND_YAWS = [Math.PI / 2, Math.PI, -Math.PI / 2]
/**
 * Not on phones: tiles the ring keeps in use can't be evicted, and in a
 * phone's small cache they crowded out the view itself (and its memory).
 */
const SURROUND_ENABLED = !isMobileDevice()

const up = new Vector3()
const yawQuaternion = new Quaternion()

/**
 * Keeps terrain all around the camera loaded, like flight simulators do:
 * three extra low-resolution cameras look left, right and behind (rotated
 * about the local vertical from the main view). Tiles they need stay "in
 * use", so they're neither evicted from the cache nor missing when you turn
 * around: coarse terrain is there instantly and refines in view.
 */
export class TileSurround {
  private readonly cameras = SURROUND_YAWS.map(() => new PerspectiveCamera(90, 1.5, 1, 1e7))
  private active = false

  constructor(private readonly tiles: TilesRenderer) {}

  update(mainCamera: Camera, gl: WebGLRenderer): void {
    const altitude = mainCamera.position.length() - 6_371_000
    const wanted =
      SURROUND_ENABLED && mainCamera instanceof PerspectiveCamera && altitude < SURROUND_MAX_ALTITUDE
    if (wanted !== this.active) {
      this.active = wanted
      for (const camera of this.cameras) {
        if (wanted) this.tiles.setCamera(camera)
        else this.tiles.deleteCamera(camera)
      }
    }
    if (!wanted) return
    const main = mainCamera as PerspectiveCamera
    up.copy(main.position).normalize()
    const size = gl.getDrawingBufferSize(drawingBuffer)
    const width = Math.max(1, Math.round(size.x * SURROUND_RESOLUTION_SCALE))
    const height = Math.max(1, Math.round(size.y * SURROUND_RESOLUTION_SCALE))
    this.cameras.forEach((camera, i) => {
      camera.near = main.near
      camera.far = main.far
      camera.position.copy(main.position)
      yawQuaternion.setFromAxisAngle(up, SURROUND_YAWS[i]!)
      camera.quaternion.copy(main.quaternion).premultiply(yawQuaternion)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      this.tiles.setResolution(camera, width, height)
    })
  }

  dispose(): void {
    if (this.active) for (const camera of this.cameras) this.tiles.deleteCamera(camera)
    this.active = false
  }
}
