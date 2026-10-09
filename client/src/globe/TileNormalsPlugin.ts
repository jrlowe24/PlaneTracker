import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  Vector3,
  type Object3D,
  type Texture
} from 'three'

import type {
  CreasedNormalsRequest,
  CreasedNormalsResponse
} from './creasedNormals.worker'

/** Small round-robin pool of module workers computing creased normals. */
class NormalsWorkerPool {
  private readonly workers: Worker[] = []
  private readonly pending = new Map<
    number,
    { resolve: (result: CreasedNormalsResponse) => void; reject: (e: Error) => void }
  >()

  private nextId = 0
  private nextWorker = 0

  constructor(size: number) {
    for (let i = 0; i < size; ++i) {
      const worker = new Worker(
        new URL('./creasedNormals.worker.ts', import.meta.url),
        { type: 'module', name: `tile-normals-${i}` }
      )
      worker.onmessage = (event: MessageEvent<CreasedNormalsResponse>) => {
        const { id, normal, error } = event.data
        const entry = this.pending.get(id)
        if (entry == null) return
        this.pending.delete(id)
        if (normal != null) entry.resolve(event.data)
        else entry.reject(new Error(error ?? 'normals worker failed'))
      }
      this.workers.push(worker)
    }
  }

  compute(
    position: Float32Array,
    creaseAngle: number,
    skirt?: CreasedNormalsRequest['skirt']
  ): Promise<CreasedNormalsResponse> {
    const id = this.nextId++
    const worker = this.workers[this.nextWorker++ % this.workers.length]!
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const request: CreasedNormalsRequest = { id, position, creaseAngle, skirt }
      const transfer: Transferable[] = [position.buffer]
      if (skirt != null) transfer.push(skirt.uv.buffer)
      worker.postMessage(request, transfer)
    })
  }
}

const SKIRT_FRACTION = 0.015
const SKIRT_MIN_M = 1
const SKIRT_MAX_M = 60
const center = new Vector3()
const down = new Vector3()
const inverse = new Matrix4()

/**
 * Skirt for a tile mesh (see tileSkirts.ts): only for plain textured
 * terrain meshes (position + uv, nothing else). "Down" is toward the
 * Earth's center at the tile, in the mesh's local frame; length ~1.5% of the
 * tile size, 1–60 m.
 */
function skirtParameters(mesh: Mesh, geometry: BufferGeometry): CreasedNormalsRequest['skirt'] {
  const names = Object.keys(geometry.attributes)
  const uv = geometry.getAttribute('uv')
  if (!(uv instanceof BufferAttribute) || names.some(n => n !== 'position' && n !== 'uv')) {
    return undefined
  }
  mesh.updateWorldMatrix(true, false)
  geometry.computeBoundingSphere()
  const sphere = geometry.boundingSphere!
  center.copy(sphere.center).applyMatrix4(mesh.matrixWorld)
  if (center.lengthSq() < 1) return undefined
  const scale = mesh.matrixWorld.getMaxScaleOnAxis()
  inverse.copy(mesh.matrixWorld).invert()
  down.copy(center).normalize().negate().transformDirection(inverse)
  const worldRadius = sphere.radius * scale
  const lengthWorld = Math.min(SKIRT_MAX_M, Math.max(SKIRT_MIN_M, worldRadius * 2 * SKIRT_FRACTION))
  const uvCopy = new Float32Array(uv.count * 2)
  for (let i = 0; i < uv.count; ++i) {
    uvCopy[i * 2] = uv.getX(i)
    uvCopy[i * 2 + 1] = uv.getY(i)
  }
  return { uv: uvCopy, down: [down.x, down.y, down.z], length: lengthWorld / Math.max(scale, 1e-9) }
}

let pool: NormalsWorkerPool | undefined
function getPool(): NormalsWorkerPool {
  const cores = navigator.hardwareConcurrency || 4
  return (pool ??= new NormalsWorkerPool(Math.max(1, Math.min(4, cores - 1))))
}

export interface TileNormalsPluginOptions {
  /** Edges sharper than this (radians) stay hard. */
  creaseAngle?: number
  /** Max anisotropic filtering applied to tile textures (1 disables). */
  anisotropy?: number
}

/**
 * Prepares Google Photorealistic 3D Tiles for takram's post-process lighting:
 *
 * - generates creased vertex normals off the main thread (tiles have none);
 * - adds skirts along tile edges (also in the worker) so cracks between
 *   tiles don't show the sky;
 * - turns on anisotropic filtering, which matters a lot at the grazing angles
 *   you see from an aircraft window.
 *
 * Based on the TileCreasedNormalsPlugin in takram's three-geospatial storybook.
 */
export class TileNormalsPlugin {
  readonly name = 'TILE_NORMALS_PLUGIN'
  // Run before TileCompressionPlugin (-100) so positions are still float.
  readonly priority = -1000

  private readonly creaseAngle: number
  /** Mutable so it can be set once the WebGL renderer is known. */
  anisotropy: number

  constructor(options: TileNormalsPluginOptions = {}) {
    this.creaseAngle = options.creaseAngle ?? (30 * Math.PI) / 180
    this.anisotropy = options.anisotropy ?? 1
  }

  async processTileModel(scene: Object3D): Promise<void> {
    const meshes: Mesh[] = []
    scene.traverse(object => {
      if (object instanceof Mesh && object.geometry instanceof BufferGeometry) {
        // toCreasedNormals works on triangle soups.
        const geometry = object.geometry
        if (geometry.index != null) {
          object.geometry = geometry.toNonIndexed()
          geometry.dispose()
        }
        meshes.push(object)
        this.applyAnisotropy(object)
      }
    })

    await Promise.all(
      meshes.map(async mesh => {
        const geometry = mesh.geometry as BufferGeometry
        const position = geometry.getAttribute('position')
        if (!(position instanceof BufferAttribute)) return
        // Copy: the original stays attached for rendering/raycasting.
        const copy = new Float32Array(position.count * 3)
        for (let i = 0; i < position.count; ++i) {
          copy[i * 3] = position.getX(i)
          copy[i * 3 + 1] = position.getY(i)
          copy[i * 3 + 2] = position.getZ(i)
        }
        const skirt = skirtParameters(mesh, geometry)
        const result = await getPool().compute(copy, this.creaseAngle, skirt)
        if (result.position != null && result.uv != null) {
          // Skirted geometry replaces the original (same attributes, more
          // triangles); the old one is disposed.
          const skirted = new BufferGeometry()
          skirted.setAttribute('position', new BufferAttribute(result.position, 3))
          skirted.setAttribute('uv', new BufferAttribute(result.uv, 2))
          skirted.setAttribute('normal', new BufferAttribute(result.normal!, 3))
          skirted.boundingBox = geometry.boundingBox
          skirted.boundingSphere = geometry.boundingSphere
          mesh.geometry = skirted
          geometry.dispose()
        } else {
          geometry.setAttribute('normal', new BufferAttribute(result.normal!, 3))
        }
      })
    )
  }

  private applyAnisotropy(mesh: Mesh): void {
    if (this.anisotropy <= 1) return
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]
    for (const material of materials) {
      const map = (material as { map?: Texture | null }).map
      if (map != null) {
        map.anisotropy = this.anisotropy
      }
    }
  }
}
