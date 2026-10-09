/// <reference lib="webworker" />
import { computeCreasedNormals } from './creasedNormals'
import { addSkirts } from './tileSkirts'

export interface CreasedNormalsRequest {
  id: number
  position: Float32Array
  creaseAngle: number
  /** When set, skirts are added (and positions/uvs returned extended). */
  skirt?: { uv: Float32Array; down: [number, number, number]; length: number }
}

export interface CreasedNormalsResponse {
  id: number
  normal?: Float32Array
  /** Extended geometry when skirts were added. */
  position?: Float32Array
  uv?: Float32Array
  error?: string
}

declare const self: DedicatedWorkerGlobalScope

self.onmessage = (event: MessageEvent<CreasedNormalsRequest>) => {
  const { id, position, creaseAngle, skirt } = event.data
  try {
    const normal = computeCreasedNormals(position, creaseAngle)
    if (skirt == null) {
      const response: CreasedNormalsResponse = { id, normal }
      self.postMessage(response, [normal.buffer])
      return
    }
    const out = addSkirts({ position, uv: skirt.uv, normal, down: skirt.down, length: skirt.length })
    const response: CreasedNormalsResponse = { id, normal: out.normal, position: out.position, uv: out.uv }
    self.postMessage(response, [out.normal.buffer, out.position.buffer, out.uv.buffer])
  } catch (error) {
    const response: CreasedNormalsResponse = { id, error: String(error) }
    self.postMessage(response)
  }
}
