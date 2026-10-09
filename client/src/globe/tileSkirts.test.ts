import { describe, expect, it } from 'vitest'

import { addSkirts } from './tileSkirts'

describe('addSkirts', () => {
  it('skirts only the outer edges of a mesh, hanging down', () => {
    // A unit quad as two triangles sharing the diagonal (duplicated vertices,
    // as in a UV-seamed triangle soup).
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0])
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1])
    const normal = new Float32Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0))
    const out = addSkirts({ position, uv, normal, down: [0, 0, -1], length: 2 })
    // 4 boundary edges (the shared diagonal is interior), 12 vertices each.
    expect(out.edges).toBe(4)
    expect(out.position.length).toBe(position.length + 4 * 12 * 3)
    expect(out.uv.length).toBe(uv.length + 4 * 12 * 2)
    // Skirt vertices are either on the edge (z = 0) or 2 below it.
    const zs = new Set<number>()
    for (let i = position.length / 3; i < out.position.length / 3; ++i) zs.add(out.position[i * 3 + 2]!)
    expect([...zs].sort()).toEqual([-2, 0])
  })
})
