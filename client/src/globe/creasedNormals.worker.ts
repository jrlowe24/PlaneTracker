/// <reference lib="webworker" />
import { computeCreasedNormals } from './creasedNormals'
import { addSkirts } from './tileSkirts'

/**
 * Tile mesh preparation off the main thread: de-index (if indexed), creased
 * normals, and optional skirts. The main thread only wraps the returned
 * arrays in a BufferGeometry, so finishing a tile costs it almost nothing.
 */
export interface CreasedNormalsRequest {
  id: number
  /** xyz per vertex (indexed or not). */
  position: Float32Array
  /** Triangle indices, if the geometry is indexed. */
  index?: Uint32Array | Uint16Array
  /** uv per vertex, if present. */
  uv?: Float32Array
  creaseAngle: number
  /** When set, skirts are added (needs uv). */
  skirt?: { down: [number, number, number]; length: number }
}

export interface CreasedNormalsResponse {
  id: number
  /** Non-indexed results. */
  position?: Float32Array
  uv?: Float32Array
  normal?: Float32Array
  error?: string
}

declare const self: DedicatedWorkerGlobalScope

function deindex(source: Float32Array, index: ArrayLike<number>, size: number): Float32Array {
  const out = new Float32Array(index.length * size)
  for (let i = 0; i < index.length; ++i) {
    const s = index[i]! * size
    for (let k = 0; k < size; ++k) out[i * size + k] = source[s + k]!
  }
  return out
}

self.onmessage = (event: MessageEvent<CreasedNormalsRequest>) => {
  const { id, creaseAngle, skirt, index } = event.data
  try {
    let position = event.data.position
    let uv = event.data.uv
    if (index != null) {
      position = deindex(position, index, 3)
      if (uv != null) uv = deindex(uv, index, 2)
    }
    const normal = computeCreasedNormals(position, creaseAngle)
    if (skirt != null && uv != null) {
      const out = addSkirts({ position, uv, normal, down: skirt.down, length: skirt.length })
      const response: CreasedNormalsResponse = { id, position: out.position, uv: out.uv, normal: out.normal }
      self.postMessage(response, [out.position.buffer, out.uv.buffer, out.normal.buffer])
      return
    }
    const response: CreasedNormalsResponse = { id, position, uv, normal }
    const transfer: Transferable[] = [position.buffer, normal.buffer]
    if (uv != null) transfer.push(uv.buffer)
    self.postMessage(response, transfer)
  } catch (error) {
    const response: CreasedNormalsResponse = { id, error: String(error) }
    self.postMessage(response)
  }
}
