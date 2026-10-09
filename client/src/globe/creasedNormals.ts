import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

const v0 = new Vector3()
const v1 = new Vector3()
const v2 = new Vector3()

/**
 * Computes per-vertex normals for a non-indexed triangle soup, smoothing only
 * across edges whose dihedral angle is below `creaseAngle` (radians).
 *
 * Google Photorealistic 3D Tiles ship without normals, but the atmosphere's
 * post-process lighting needs a normal buffer for sun/sky irradiance.
 */
export function computeCreasedNormals(
  position: Float32Array,
  creaseAngle: number
): Float32Array {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  const result = toCreasedNormals(geometry, creaseAngle)
  const normal = result.getAttribute('normal') as BufferAttribute

  // Degenerate (zero-area) triangles produce zero normals, which become NaN
  // in the spherical-harmonics sky light. Replace them with any unit normal;
  // they are invisible anyway.
  for (let i = 0; i < normal.count; i += 3) {
    v0.fromBufferAttribute(normal, i)
    v1.fromBufferAttribute(normal, i + 1)
    v2.fromBufferAttribute(normal, i + 2)
    if (v0.lengthSq() < 0.25 || v1.lengthSq() < 0.25 || v2.lengthSq() < 0.25) {
      normal.setXYZ(i, 0, 0, 1)
      normal.setXYZ(i + 1, 0, 0, 1)
      normal.setXYZ(i + 2, 0, 0, 1)
    }
  }
  return normal.array as Float32Array
}
