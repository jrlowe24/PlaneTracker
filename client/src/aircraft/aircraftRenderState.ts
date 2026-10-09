import { Vector3 } from 'three'

/**
 * Per-frame render data kept for picking: positions (float64) relative to
 * `origin`, the camera position when the frame was built.
 */
export const aircraftRenderState = {
  origin: new Vector3(),
  positions: new Float64Array(16_384 * 3),
  hexes: [] as string[],
  count: 0
}
