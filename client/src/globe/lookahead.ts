import type { TilesRenderer } from '3d-tiles-renderer'
import { PerspectiveCamera, Vector2, Vector3, type Camera, type WebGLRenderer } from 'three'

import { flightConnection } from '../data/flightConnection'
import { cameraModeStore } from '../state/cameraMode'

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
