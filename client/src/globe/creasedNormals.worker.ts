/// <reference lib="webworker" />
import { computeCreasedNormals } from './creasedNormals'
import { addSkirts } from './tileSkirts'

/**
 * Tile mesh preparation off the main thread: de-index (if indexed), creased
 * normals, optional skirts, then weld back into an indexed mesh with
 * compact attributes. The main thread only wraps the returned arrays in a
 * BufferGeometry, so finishing a tile costs it almost nothing.
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
  /** Indexed results: float positions (raycasts need them exact). */
  position?: Float32Array
  /** uv: normalized Uint16 when within 0…1, else float. */
  uv?: Uint16Array | Float32Array
  /** Normals: normalized Int8, xyz + padding (4-byte aligned). */
  normal?: Int8Array
  index?: Uint16Array | Uint32Array
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

/**
 * Merges vertices that are identical (position and uv bit for bit, normal
 * after quantization) back into an indexed mesh. Creased normals need
 * de-indexed triangles to compute, but kept that way every triangle
 * carried its own three float vertices: ~5x the memory of the indexed
 * mesh, on the GPU and in the browser's copy.
 */
function weld(
  position: Float32Array,
  uv: Float32Array | undefined,
  normal: Float32Array
): Required<Pick<CreasedNormalsResponse, 'position' | 'normal' | 'index'>> & { uv?: Uint16Array | Float32Array } {
  const count = position.length / 3
  const positionBits = new Uint32Array(position.buffer, position.byteOffset, position.length)
  const uvBits = uv == null ? null : new Uint32Array(uv.buffer, uv.byteOffset, uv.length)
  const normal8 = new Int8Array(count * 4)
  for (let i = 0; i < count; ++i) {
    for (let k = 0; k < 3; ++k) normal8[i * 4 + k] = Math.round(Math.max(-1, Math.min(1, normal[i * 3 + k]!)) * 127)
  }
  let size = 1
  while (size < count * 2) size <<= 1
  const table = new Int32Array(size).fill(-1)
  const remap = new Uint32Array(count)
  const first: number[] = []
  for (let i = 0; i < count; ++i) {
    let h = 2166136261
    for (let k = 0; k < 3; ++k) h = Math.imul(h ^ positionBits[i * 3 + k]!, 16777619)
    if (uvBits != null) for (let k = 0; k < 2; ++k) h = Math.imul(h ^ uvBits[i * 2 + k]!, 16777619)
    for (let k = 0; k < 3; ++k) h = Math.imul(h ^ (normal8[i * 4 + k]! & 0xff), 16777619)
    let slot = (h >>> 0) & (size - 1)
    for (;;) {
      const v = table[slot]!
      if (v < 0) {
        table[slot] = first.length
        remap[i] = first.length
        first.push(i)
        break
      }
      const j = first[v]!
      let same =
        positionBits[i * 3] === positionBits[j * 3] &&
        positionBits[i * 3 + 1] === positionBits[j * 3 + 1] &&
        positionBits[i * 3 + 2] === positionBits[j * 3 + 2] &&
        normal8[i * 4] === normal8[j * 4] &&
        normal8[i * 4 + 1] === normal8[j * 4 + 1] &&
        normal8[i * 4 + 2] === normal8[j * 4 + 2]
      if (same && uvBits != null) same = uvBits[i * 2] === uvBits[j * 2] && uvBits[i * 2 + 1] === uvBits[j * 2 + 1]
      if (same) {
        remap[i] = v
        break
      }
      slot = (slot + 1) & (size - 1)
    }
  }
  const unique = first.length
  const outPosition = new Float32Array(unique * 3)
  const outNormal = new Int8Array(unique * 4)
  let inUnitRange = uv != null
  const outUvFloat = uv == null ? null : new Float32Array(unique * 2)
  first.forEach((i, v) => {
    outPosition[v * 3] = position[i * 3]!
    outPosition[v * 3 + 1] = position[i * 3 + 1]!
    outPosition[v * 3 + 2] = position[i * 3 + 2]!
    outNormal[v * 4] = normal8[i * 4]!
    outNormal[v * 4 + 1] = normal8[i * 4 + 1]!
    outNormal[v * 4 + 2] = normal8[i * 4 + 2]!
    if (outUvFloat != null) {
      const u = uv![i * 2]!
      const w = uv![i * 2 + 1]!
      outUvFloat[v * 2] = u
      outUvFloat[v * 2 + 1] = w
      if (!(u >= 0 && u <= 1 && w >= 0 && w <= 1)) inUnitRange = false
    }
  })
  let outUv: Uint16Array | Float32Array | undefined
  if (outUvFloat != null) {
    if (inUnitRange) {
      const u16 = new Uint16Array(outUvFloat.length)
      for (let k = 0; k < u16.length; ++k) u16[k] = Math.round(outUvFloat[k]! * 65535)
      outUv = u16
    } else {
      outUv = outUvFloat
    }
  }
  const index = unique < 65536 ? new Uint16Array(count) : new Uint32Array(count)
  index.set(remap)
  return { position: outPosition, uv: outUv, normal: outNormal, index }
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
    let normal = computeCreasedNormals(position, creaseAngle)
    if (skirt != null && uv != null) {
      const out = addSkirts({ position, uv, normal, down: skirt.down, length: skirt.length })
      position = out.position
      uv = out.uv
      normal = out.normal
    }
    const welded = weld(position, uv, normal)
    const response: CreasedNormalsResponse = { id, ...welded }
    const transfer: Transferable[] = [welded.position.buffer, welded.normal.buffer, welded.index.buffer]
    if (welded.uv != null) transfer.push(welded.uv.buffer)
    self.postMessage(response, transfer)
  } catch (error) {
    const response: CreasedNormalsResponse = { id, error: String(error) }
    self.postMessage(response)
  }
}
