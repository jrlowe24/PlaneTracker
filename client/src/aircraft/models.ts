import { Group, Mesh, MeshStandardMaterial, Vector3, type BufferGeometry, type Material, type Object3D } from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { createAircraftMaterial, patchAircraftMaterial } from './aircraftMaterial'
import { AIRFRAMES, buildAirframe, buildGear, type AircraftClass } from './airframes'
import type { LightAnchors } from './detailState'
import { AIRCRAFT_LAYER } from './layers'

/**
 * Model registry: `public/models/manifest.json` maps ICAO type designators
 * to glTF files; everything else gets the procedural placeholder for its
 * class. Detailed models are used for the followed aircraft and aircraft
 * close to the camera; distant aircraft are instanced class placeholders.
 */
export interface ModelEntry {
  /** Path relative to /models/, e.g. "a320.glb". */
  url: string
  /** Uniform scale to meters. */
  scale?: number
  /** Euler XYZ degrees to bring the model into +Z forward, +Y up. */
  rotationDeg?: [number, number, number]
  /** Meters, applied after rotation and scale. */
  offset?: [number, number, number]
  /** Attribution / license note (shown in dev tools, documented in README). */
  license?: string
  /**
   * Real [length, span] in meters of the model as transformed above. When
   * set, the model is stretched to each aircraft's actual type dimensions,
   * so one model can stand in for a whole family or class.
   */
  fit?: [length: number, span: number]
}

export interface ModelManifest {
  version: 1
  /** By ICAO type designator. */
  models: Record<string, ModelEntry>
  /** Fallback by aircraft class for types without their own model. */
  classes?: Partial<Record<AircraftClass, ModelEntry>>
  /**
   * By airline ICAO code (callsign prefix, e.g. "DAL"): the airline's
   * livery. Wins over type and class models, for airliner classes only.
   */
  liveries?: Record<string, ModelEntry>
}

/** Classes that carry airline liveries. */
const LIVERY_CLASSES: ReadonlySet<AircraftClass> = new Set(['narrowbody', 'widebody', 'regional'])

/** Airline ICAO code from an airline-style callsign ("DAL1234" → "DAL"). */
export function airlineCode(callsign: string | null): string | null {
  const match = callsign == null ? null : /^([A-Z]{3})\d/.exec(callsign.trim().toUpperCase())
  return match?.[1] ?? null
}

let manifestPromise: Promise<ModelManifest> | null = null

export function loadManifest(): Promise<ModelManifest> {
  manifestPromise ??= fetch('/models/manifest.json')
    .then(async response => (response.ok ? ((await response.json()) as ModelManifest) : null))
    .catch(() => null)
    .then(manifest => manifest ?? { version: 1, models: {} })
  return manifestPromise
}

/** The model for an aircraft: airline livery, else its type's, else its class's. */
export function findModelEntry(
  manifest: ModelManifest,
  typeCode: string | null,
  cls: AircraftClass,
  callsign: string | null = null
): ModelEntry | null {
  const airline = airlineCode(callsign)
  const livery = airline == null || !LIVERY_CLASSES.has(cls) ? undefined : manifest.liveries?.[airline]
  if (livery != null) return livery
  const own = typeCode == null ? undefined : manifest.models[typeCode.toUpperCase()]
  return own ?? manifest.classes?.[cls] ?? null
}

let gltfLoader: GLTFLoader | null = null
function getLoader(): GLTFLoader {
  if (gltfLoader == null) {
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    gltfLoader = new GLTFLoader()
    gltfLoader.setDRACOLoader(draco)
  }
  return gltfLoader
}

interface LoadedModel {
  object: Object3D
  anchors: LightAnchors
}

const gltfCache = new Map<string, Promise<LoadedModel | null>>()

/**
 * Nav light positions from a model's geometry (in its normalized body
 * frame): the leading edge of the left (+X) wingtip; along the
 * centerline (|x| < 0.6 m), the aft-most point below the fin for the tail
 * light and the highest/lowest points around mid-length for the beacons.
 */
export function computeLightAnchors(root: Object3D): LightAnchors {
  root.updateMatrixWorld(true)
  const wingtip = new Vector3(0, 0, 0)
  const tail = new Vector3(0, 0, Infinity)
  const top = new Vector3(0, -Infinity, 0)
  const bottom = new Vector3(0, Infinity, 0)
  let minZ = Infinity
  let maxZ = -Infinity
  const points: Vector3[] = []
  const v = new Vector3()
  root.traverse(child => {
    if (!(child instanceof Mesh)) return
    const position = (child.geometry as BufferGeometry).getAttribute('position')
    if (position == null) return
    const step = Math.max(1, Math.floor(position.count / 20_000))
    for (let i = 0; i < position.count; i += step) {
      v.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld)
      points.push(v.clone())
      if (v.x > wingtip.x) wingtip.copy(v)
      minZ = Math.min(minZ, v.z)
      maxZ = Math.max(maxZ, v.z)
    }
  })
  // Nav lights sit right at the tip: from the outermost point, take the
  // leading edge at that height (within ~0.6 m), and stand the light just
  // ahead of it so the tip itself doesn't hide it from the side or the
  // cabin.
  const outer = wingtip.clone()
  for (const p of points) {
    if (outer.x - p.x < 0.6 && Math.abs(p.y - outer.y) < 0.6 && p.z > wingtip.z) wingtip.copy(p)
  }
  wingtip.z += 0.15
  let lowest = Infinity
  for (const p of points) lowest = Math.min(lowest, p.y)
  const midZ = (minZ + maxZ) / 2
  const length = maxZ - minZ
  for (const p of points) {
    if (Math.abs(p.x) > 0.6) continue
    if (Math.abs(p.z - midZ) < length * 0.08) {
      if (p.y > top.y) top.copy(p)
      if (p.y < bottom.y) bottom.copy(p)
    }
  }
  // Tail light: aft-most centerline point no higher than the fuselage top.
  for (const p of points) {
    if (Math.abs(p.x) > 0.6 || p.y > top.y) continue
    if (p.z < tail.z) tail.copy(p)
  }
  if (!Number.isFinite(top.y)) top.set(0, 1, 0)
  if (!Number.isFinite(bottom.y)) bottom.set(0, -1, 0)
  if (!Number.isFinite(tail.z)) tail.set(0, 0, minZ)
  return { wingtip, tail, top, bottom, lowest: Number.isFinite(lowest) ? lowest : -1 }
}

/** Loads (once) and normalizes a glTF model; null on failure. */
function loadTypeModel(entry: ModelEntry): Promise<LoadedModel | null> {
  let promise = gltfCache.get(entry.url)
  if (promise == null) {
    promise = getLoader()
      .loadAsync(`/models/${entry.url}`)
      .then(gltf => {
        const root = new Group()
        const scene = gltf.scene
        const [rx = 0, ry = 0, rz = 0] = entry.rotationDeg ?? [0, 0, 0]
        scene.rotation.set((rx * Math.PI) / 180, (ry * Math.PI) / 180, (rz * Math.PI) / 180)
        scene.scale.setScalar(entry.scale ?? 1)
        const [ox = 0, oy = 0, oz = 0] = entry.offset ?? [0, 0, 0]
        scene.position.set(ox, oy, oz)
        root.add(scene)
        return { object: root as Object3D, anchors: computeLightAnchors(root) }
      })
      .catch((error: unknown) => {
        console.warn(`[models] failed to load ${entry.url}`, error)
        return null
      })
    gltfCache.set(entry.url, promise)
  }
  return promise
}

/** glTF base color scale: model textures sit near 1.0, real paint ~0.8. */
const PAINT_ALBEDO_SCALE = 0.8

const placeholderGeometry = new Map<AircraftClass, BufferGeometry>()
const gearGeometry = new Map<AircraftClass, BufferGeometry>()

/**
 * Higher-detail procedural model for a class. Geometry is shared; each model
 * gets its own material because the shading uniform is per aircraft.
 */
function placeholderModel(cls: AircraftClass): Object3D {
  let geometry = placeholderGeometry.get(cls)
  if (geometry == null) {
    geometry = buildAirframe(AIRFRAMES[cls], { segments: 20 })
    placeholderGeometry.set(cls, geometry)
  }
  let gear = gearGeometry.get(cls)
  if (gear == null) {
    gear = buildGear(AIRFRAMES[cls])
    gearGeometry.set(cls, gear)
  }
  const material = createAircraftMaterial({}, false)
  const group = new Group()
  group.add(new Mesh(geometry, material))
  const gearMesh = new Mesh(gear, material)
  // Toggled by DetailedAircraft: down on the ground and on approach.
  gearMesh.name = 'gear'
  gearMesh.visible = false
  group.add(gearMesh)
  return group
}

/**
 * Per-instance setup: aircraft lighting layer, no frustum culling (matrices
 * are huge ECEF values; culling is pointless for a handful of models), and
 * own patched copies of standard materials.
 */
function prepare(object: Object3D, cloneMaterials: boolean): Object3D {
  object.traverse(child => {
    child.layers.enable(AIRCRAFT_LAYER)
    child.frustumCulled = false
    if (cloneMaterials && child instanceof Mesh) {
      const patch = (material: Material): Material => {
        if (!(material instanceof MeshStandardMaterial)) return material
        const copy = material.clone()
        // Aircraft are painted (dielectric): AI-generated models often mark
        // the whole skin fully metallic, which mirrors the bright sky and
        // blows out in sunlight. Their albedo also tends to sit at 1.0;
        // white aircraft paint is ~0.8.
        copy.metalness = Math.min(copy.metalness, 0.15)
        copy.color.multiplyScalar(PAINT_ALBEDO_SCALE)
        patchAircraftMaterial(copy, false)
        return copy
      }
      child.material = Array.isArray(child.material)
        ? child.material.map(patch)
        : patch(child.material as Material)
    }
  })
  return object
}

/** Disposes per-instance materials of a detailed model (geometry is shared/cached). */
export function disposeDetailedModel(object: Object3D): void {
  const materials = new Set<Material>()
  object.traverse(child => {
    if (child instanceof Mesh) {
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        materials.add(material as Material)
      }
    }
  })
  for (const material of materials) material.dispose()
}

/**
 * A detailed model for an aircraft: immediately a procedural placeholder,
 * swapped for the glTF model once it loads (if the manifest has one).
 */
export function createDetailedModel(
  typeCode: string | null,
  cls: AircraftClass,
  callsign: string | null,
  onUpgrade: (model: Object3D, entry: ModelEntry, anchors: LightAnchors) => void
): Object3D {
  const placeholder = prepare(placeholderModel(cls), false)
  void loadManifest().then(manifest => {
    const entry = findModelEntry(manifest, typeCode, cls, callsign)
    if (entry == null) return
    void loadTypeModel(entry).then(model => {
      if (model != null) onUpgrade(prepare(model.object.clone(true), true), entry, model.anchors)
    })
  })
  return placeholder
}
