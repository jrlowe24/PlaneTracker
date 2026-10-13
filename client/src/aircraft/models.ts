import {
  Group,
  Mesh,
  MeshStandardMaterial,
  Texture,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer
} from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { createAircraftMaterial, patchAircraftMaterial } from './aircraftMaterial'
import { AIRFRAMES, buildAirframe, buildGear, type AircraftClass } from './airframes'
import type { LightAnchors } from './detailState'
import { isMobileDevice } from '../state/device'
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
   * livery. Wins over type and class models for narrowbodies and regional
   * jets; widebodies use it only from `classes.widebody` (a 737 livery
   * stretched to an A350 looked wrong), else their type or class model.
   */
  liveries?: Record<string, LiveryEntry>
}

/** An airline's livery model, optionally with its own model per class. */
export interface LiveryEntry extends ModelEntry {
  classes?: Partial<Record<AircraftClass, ModelEntry>>
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
  if (livery != null) {
    const byClass = livery.classes?.[cls]
    if (byClass != null) return byClass
    if (cls !== 'widebody') return livery
  }
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
const instancedCache = new Map<string, Promise<InstancedModel | null>>()

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
  // The outermost vertex may be the TOP of a swept/upturned winglet.
  // Locate the main wing's outer low band first, then its leading edge.
  let wingBaseY = Infinity
  for (const p of points) {
    if (p.x > outer.x * 0.88) wingBaseY = Math.min(wingBaseY, p.y)
  }
  let outerBaseX = 0
  for (const p of points) {
    if (p.x > outer.x * 0.88 && p.y < wingBaseY + 0.45) outerBaseX = Math.max(outerBaseX, p.x)
  }
  wingtip.set(outerBaseX, wingBaseY, -Infinity)
  for (const p of points) {
    if (p.x > outerBaseX - 0.45 && p.y < wingBaseY + 0.45 && p.z > wingtip.z) wingtip.copy(p)
  }
  if (!Number.isFinite(wingtip.z)) wingtip.copy(outer)
  wingtip.z += 0.15
  let lowest = Infinity
  for (const p of points) lowest = Math.min(lowest, p.y)
  const midZ = (minZ + maxZ) / 2
  const length = maxZ - minZ
  let wingRoot: Vector3 | undefined
  // Find the actual wing leading edge just outboard of the fuselage. Class
  // dimensions alone can put a fixture on a model's fuselage or inside its
  // wing. Restrict to the main-wing height/longitudinal band to exclude the
  // nose, engine intakes, horizontal tail and upper winglets.
  for (const p of points) {
    if (p.x < outer.x * 0.13 || p.x > outer.x * 0.22 ||
      Math.abs(p.y - wingBaseY) > 1.5 ||
      p.z < minZ + length * 0.25 || p.z > minZ + length * 0.7) continue
    if (wingRoot == null || p.z > wingRoot.z) wingRoot = p.clone()
  }
  if (wingRoot != null) wingRoot.z += 0.08
  let finTip: Vector3 | undefined
  for (const p of points) {
    if (Math.abs(p.x) < 0.25 && p.z < midZ - length * 0.12 &&
      (finTip == null || p.y > finTip.y)) finTip = p
  }
  let finBase: Vector3 | undefined
  if (finTip != null) {
    const z = finTip.z + length * 0.08
    for (const p of points) {
      if (Math.abs(p.x) < 0.3 || Math.abs(p.x) > 1.2 || Math.abs(p.z - z) > 0.8) continue
      if (finBase == null || p.y > finBase.y) finBase = new Vector3(0, p.y, z)
    }
  }
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
  return { wingtip, wingRoot, finBase, tail, top, bottom, lowest: Number.isFinite(lowest) ? lowest : -1 }
}

/** Phones: base color at most this size, other maps half of it. */
const PHONE_TEXTURE_MAX = 1024

/**
 * Shrinks a model's textures before they reach the GPU (phones): a 2048²
 * base color with mipmaps is ~22 MB of GPU memory, 1024² a quarter of it;
 * at phone screen sizes the difference isn't visible.
 */
function downscaleTextures(root: Object3D): void {
  const done = new Set<Texture>()
  root.traverse(child => {
    if (!(child instanceof Mesh)) return
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (!(material instanceof MeshStandardMaterial)) continue
      for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.emissiveMap, material.aoMap]) {
        if (texture == null || done.has(texture)) continue
        done.add(texture)
        const max = texture === material.map ? PHONE_TEXTURE_MAX : PHONE_TEXTURE_MAX / 2
        const image = texture.image as { width?: number; height?: number; close?: () => void } | null
        const width = image?.width ?? 0
        const height = image?.height ?? 0
        if (width <= max && height <= max) continue
        const k = max / Math.max(width, height)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width * k))
        canvas.height = Math.max(1, Math.round(height * k))
        const context = canvas.getContext('2d')
        if (context == null) continue
        context.drawImage(image as CanvasImageSource, 0, 0, canvas.width, canvas.height)
        image?.close?.()
        texture.image = canvas
        texture.needsUpdate = true
      }
    }
  })
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
        if (isMobileDevice()) downscaleTextures(root)
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

/**
 * Frees a cached model's GPU data (geometry, textures) and forgets it, so
 * it is fetched again (from the HTTP cache) when next needed. Phones call
 * this once no aircraft shows the model.
 */
export function evictModel(url: string): void {
  // Instanced materials clone the material but share its Texture objects.
  // Disposing the source model would invalidate those textures for every
  // distant aircraft using the batch. Keep the shared source alive while an
  // instanced representation owns references to it.
  if (instancedCache.has(url)) return
  const promise = gltfCache.get(url)
  if (promise == null) return
  gltfCache.delete(url)
  void promise.then(model => {
    model?.object.traverse(child => {
      if (!(child instanceof Mesh)) return
      ;(child.geometry as BufferGeometry).dispose()
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          if (value instanceof Texture) value.dispose()
        }
        ;(material as Material).dispose()
      }
    })
  })
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
  allowGltf: boolean,
  onUpgrade: (model: Object3D, entry: ModelEntry, anchors: LightAnchors) => void
): Object3D {
  const placeholder = prepare(placeholderModel(cls), false)
  if (!allowGltf) return placeholder
  void loadManifest().then(manifest => {
    const entry = findModelEntry(manifest, typeCode, cls, callsign)
    if (entry == null) return
    void loadTypeModel(entry).then(model => {
      if (model != null) onUpgrade(prepare(model.object.clone(true), true), entry, model.anchors)
    })
  })
  return placeholder
}

/**
 * Loads every model in the manifest in the background, uploads its textures
 * and compiles its shaders, so the first time an aircraft is shown in
 * detail (typically mid fly-in to follow it) doesn't stall a frame.
 */
export async function preloadModels(renderer: WebGLRenderer, camera: Camera, scene: Scene): Promise<void> {
  const manifest = await loadManifest()
  const entries = new Map<string, ModelEntry>()
  for (const entry of [
    ...Object.values(manifest.models),
    ...Object.values(manifest.classes ?? {}),
    ...Object.values(manifest.liveries ?? {})
  ]) {
    if (entry != null) entries.set(entry.url, entry)
  }
  for (const entry of entries.values()) {
    const loaded = await loadTypeModel(entry)
    if (loaded == null) continue
    loaded.object.traverse(child => {
      if (!(child instanceof Mesh)) return
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          if (value instanceof Texture) renderer.initTexture(value)
        }
      }
    })
    // Compile the patched (per-instance) material variant the detailed
    // aircraft use, off to the side of the scene graph.
    const sample = prepare(loaded.object.clone(true), true)
    sample.visible = true
    try {
      await renderer.compileAsync(sample, camera, scene)
    } catch {
      // Compilation is an optimization only.
    }
    disposeDetailedModel(sample)
    // Let a few frames render between models.
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** A glTF model baked for instanced drawing (one geometry, one material). */
export interface InstancedModel {
  /** In the normalized body frame (+Z forward, +Y up, meters). */
  geometry: BufferGeometry
  material: MeshStandardMaterial
  /** Lowest point (wheels), meters below the model origin (negative). */
  lowest: number
  anchors: LightAnchors
}

/**
 * The model of a manifest entry for the instanced (non-detailed) aircraft:
 * its mesh baked into the body frame and its material patched for
 * per-instance shading. Distant airliners then show their livery model
 * rather than the class placeholder.
 */
export function loadInstancedModel(entry: ModelEntry): Promise<InstancedModel | null> {
  let promise = instancedCache.get(entry.url)
  if (promise == null) {
    promise = loadTypeModel(entry).then(model => {
      if (model == null) return null
      model.object.updateMatrixWorld(true)
      let found: Mesh | null = null
      model.object.traverse(child => {
        if (found == null && child instanceof Mesh) found = child
      })
      const mesh = found as Mesh | null
      if (mesh == null || !(mesh.material instanceof MeshStandardMaterial)) return null
      const geometry = (mesh.geometry as BufferGeometry).clone().applyMatrix4(mesh.matrixWorld)
      const material = mesh.material.clone()
      // As for detailed models (prepare): painted, not metallic; ~0.8 albedo.
      material.metalness = Math.min(material.metalness, 0.15)
      material.color.multiplyScalar(PAINT_ALBEDO_SCALE)
      patchAircraftMaterial(material, true)
      return { geometry, material, lowest: model.anchors.lowest, anchors: model.anchors }
    })
    instancedCache.set(entry.url, promise)
  }
  return promise
}
