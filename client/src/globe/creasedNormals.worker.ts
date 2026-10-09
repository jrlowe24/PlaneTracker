/// <reference lib="webworker" />
import { computeCreasedNormals } from './creasedNormals'

export interface CreasedNormalsRequest {
  id: number
  position: Float32Array
  creaseAngle: number
}

export interface CreasedNormalsResponse {
  id: number
  normal?: Float32Array
  error?: string
}

declare const self: DedicatedWorkerGlobalScope

self.onmessage = (event: MessageEvent<CreasedNormalsRequest>) => {
  const { id, position, creaseAngle } = event.data
  try {
    const normal = computeCreasedNormals(position, creaseAngle)
    const response: CreasedNormalsResponse = { id, normal }
    self.postMessage(response, [normal.buffer])
  } catch (error) {
    const response: CreasedNormalsResponse = { id, error: String(error) }
    self.postMessage(response)
  }
}
