/**
 * Skirts for photogrammetry tiles. Neighbouring tiles (and tiles at
 * different levels of detail) don't share edge vertices exactly, so thin
 * cracks open between them and the sky shows through. A skirt is a short
 * strip hanging down from every boundary edge of a tile mesh, textured with
 * the edge's own texture coordinates; it fills the crack with matching
 * colour. (Terrain engines such as Cesium do the same.)
 */

export interface SkirtInput {
  /** Non-indexed triangle soup, xyz per vertex. */
  position: Float32Array
  /** uv per vertex (same vertex order). */
  uv: Float32Array
  /** Normal per vertex (same order). */
  normal: Float32Array
  /** Unit "down" direction in the mesh's local frame. */
  down: [number, number, number]
  /** Skirt length in local units. */
  length: number
}

export interface SkirtOutput {
  position: Float32Array
  uv: Float32Array
  normal: Float32Array
  /** Number of boundary edges skirted. */
  edges: number
}

/** Position key, welding vertices that coincide (UV seams duplicate them). */
function key(p: Float32Array, i: number, quantum: number): string {
  return `${Math.round(p[i * 3]! / quantum)},${Math.round(p[i * 3 + 1]! / quantum)},${Math.round(p[i * 3 + 2]! / quantum)}`
}

export function addSkirts(input: SkirtInput): SkirtOutput {
  const { position, uv, normal, down, length } = input
  const vertexCount = position.length / 3
  // Weld by position with a tolerance relative to the mesh size.
  let min = Infinity
  let max = -Infinity
  for (const v of position) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const quantum = Math.max(1e-6, (max - min) * 1e-6)
  const ids = new Int32Array(vertexCount)
  const welded = new Map<string, number>()
  for (let i = 0; i < vertexCount; ++i) {
    const k = key(position, i, quantum)
    let id = welded.get(k)
    if (id == null) {
      id = welded.size
      welded.set(k, id)
    }
    ids[i] = id
  }

  // Edge use counts (undirected, by welded ids); remember one occurrence.
  const edges = new Map<string, { count: number; a: number; b: number }>()
  for (let t = 0; t < vertexCount; t += 3) {
    for (let e = 0; e < 3; ++e) {
      const a = t + e
      const b = t + ((e + 1) % 3)
      const ia = ids[a]!
      const ib = ids[b]!
      if (ia === ib) continue
      const k = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`
      const entry = edges.get(k)
      if (entry == null) edges.set(k, { count: 1, a, b })
      else entry.count += 1
    }
  }
  const boundary: Array<{ a: number; b: number }> = []
  for (const entry of edges.values()) if (entry.count === 1) boundary.push(entry)

  // Each boundary edge: a quad (two triangles), both windings so it shows
  // from either side = 12 vertices.
  const extra = boundary.length * 12
  const outPosition = new Float32Array(position.length + extra * 3)
  const outUv = new Float32Array(uv.length + extra * 2)
  const outNormal = new Float32Array(normal.length + extra * 3)
  outPosition.set(position)
  outUv.set(uv)
  outNormal.set(normal)
  let o = vertexCount
  const dx = down[0] * length
  const dy = down[1] * length
  const dz = down[2] * length
  const put = (src: number, lowered: boolean): void => {
    outPosition[o * 3] = position[src * 3]! + (lowered ? dx : 0)
    outPosition[o * 3 + 1] = position[src * 3 + 1]! + (lowered ? dy : 0)
    outPosition[o * 3 + 2] = position[src * 3 + 2]! + (lowered ? dz : 0)
    outUv[o * 2] = uv[src * 2]!
    outUv[o * 2 + 1] = uv[src * 2 + 1]!
    outNormal[o * 3] = normal[src * 3]!
    outNormal[o * 3 + 1] = normal[src * 3 + 1]!
    outNormal[o * 3 + 2] = normal[src * 3 + 2]!
    ++o
  }
  for (const { a, b } of boundary) {
    // a, b, b' and a, b', a'
    put(a, false); put(b, false); put(b, true)
    put(a, false); put(b, true); put(a, true)
    // Reverse winding.
    put(b, false); put(a, false); put(b, true)
    put(b, true); put(a, false); put(a, true)
  }
  return { position: outPosition, uv: outUv, normal: outNormal, edges: boundary.length }
}
