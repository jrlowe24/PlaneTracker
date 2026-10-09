import { Group, Mesh, MeshStandardMaterial, type BufferGeometry, type Material, type Object3D } from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { createAircraftMaterial, patchAircraftMaterial } from './aircraftMaterial'
import { AIRFRAMES, buildAirframe, buildGear, type AircraftClass } from './airframes'
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

const gltfCache = new Map<string, Promise<Object3D | null>>()

/** Loads (once) and normalizes a glTF model for a type; null on failure. */
function loadTypeModel(entry: ModelEntry): Promise<Object3D | null> {
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
        return root as Object3D
      })
      .catch((error: unknown) => {
        console.warn(`[models] failed to load ${entry.url}`, error)
        return null
      })
    gltfCache.set(entry.url, promise)
  }
  return promise
}

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
  onUpgrade: (model: Object3D, entry: ModelEntry) => void
): Object3D {
  const placeholder = prepare(placeholderModel(cls), false)
  void loadManifest().then(manifest => {
    const entry = findModelEntry(manifest, typeCode, cls, callsign)
    if (entry == null) return
    void loadTypeModel(entry).then(model => {
      if (model != null) onUpgrade(prepare(model.clone(true), true), entry)
    })
  })
  return placeholder
}
