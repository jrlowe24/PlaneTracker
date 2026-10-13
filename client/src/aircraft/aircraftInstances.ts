import { ecefToGeodetic } from '@windowseat/shared'
import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Vector3,
  type BufferGeometry,
  type Material,
  type PerspectiveCamera
} from 'three'

import { flightConnection, serverNow } from '../data/flightConnection'
import { nightEmission } from '../nightLights/nightLightsStore'
import { nightState } from '../scene/nightLighting'
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { settingsStore } from '../state/settings'
import { AircraftArrows } from './aircraftArrows'
import { createAircraftMaterial } from './aircraftMaterial'
import { aircraftRenderState } from './aircraftRenderState'
import { AIRFRAMES, buildAirframe, type AircraftClass } from './airframes'
import { findModelEntry, loadInstancedModel, loadManifest, type ModelEntry, type ModelManifest } from './models'
import { typeDimensions } from './typeDimensions'
import { detailedHexes } from './detailState'
import { AIRCRAFT_LAYER } from './layers'
import { lightAnchor } from './lightAnchor'
import { adaptiveDelayMs, smoothingFactor } from './motion'
import { computePose, createPose } from './pose'
import { aircraftShading, skyBrightness } from './shading'

/** Instances allocated per class up front; grows by doubling. */
const INITIAL_CAPACITY = 1024
/**
 * Minimum on-screen length of a marker, CSS pixels: larger near the ground,
 * smaller from orbit where thousands of markers would otherwise cover the
 * globe.
 */
const MARKER_PIXELS_NEAR = 18
const MARKER_PIXELS_ORBIT = 5
/**
 * While the camera rides with an aircraft, other traffic is drawn at true
 * size (a distant airliner is a speck, as from a real cockpit or window),
 * with only a tiny minimum so it doesn't vanish; nav lights show it at night.
 */
const MARKER_PIXELS_ATTACHED = 2.5
const SELECTED_MARKER_PIXELS = 26
/** Within this distance aircraft get bank/pitch (beyond, they are icons). */
const DETAIL_DISTANCE = 80_000

/**
 * Map arrows replace the 3D models only in the high overview, where a model
 * is a few pixels of blob: the camera this high above the ground (meters)
 * starts and completes the crossfade. Below it, every aircraft is a model
 * with its lights.
 */
const ARROW_HEIGHT_FROM = 15_000
const ARROW_HEIGHT_TO = 30_000
/** Arrow size relative to the marker's minimum length (the icon has margins). */
const ARROW_SIZE = 1.15
/** Markers ease to true size over this long once riding along, ms. */
const ATTACH_BLEND_MS = 900
/** Parked and taxiing aircraft: smaller, dimmer arrows (busy aprons). */
const GROUND_ARROW_SIZE = 0.7
const GROUND_ARROW_ALPHA = 0.8
/** New aircraft fade/grow in over this long instead of popping, ms. */
const APPEAR_MS = 600

const COLOR_DEFAULT = new Color(0.86, 0.87, 0.89)
const COLOR_SELECTED = new Color(0.95, 0.42, 0.05)
const COLOR_MODEL = new Color(1, 1, 1)
/** Street/apron emission map to aircraft-material irradiance. */
const GROUND_LIGHT_GAIN = 0.6
/** Only local, ground-hugging traffic needs the map read each frame. */
const GROUND_LIGHT_DISTANCE = 5_000

const CLASSES = Object.keys(AIRFRAMES) as AircraftClass[]

function allocate(mesh: InstancedMesh, capacity: number): void {
  mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  mesh.instanceColor.setUsage(DynamicDrawUsage)
  const shading = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  shading.setUsage(DynamicDrawUsage)
  mesh.geometry.setAttribute('instanceShading', shading)
  const groundLight = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  groundLight.setUsage(DynamicDrawUsage)
  mesh.geometry.setAttribute('instanceGroundLight', groundLight)
}

function createMesh(geometry: BufferGeometry, material: Material, name: string): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, 1)
  allocate(mesh, INITIAL_CAPACITY)
  mesh.count = 0
  // Instance matrices are relative to the camera; bounds are meaningless.
  mesh.frustumCulled = false
  // Lit by SunLight/SkyLight, masked out of post-process lighting.
  mesh.layers.enable(AIRCRAFT_LAYER)
  mesh.name = name
  return mesh
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Time constant for easing an aircraft's interpolation delay, seconds. */
const DELAY_TIME_CONSTANT = 3

/** Simulated time aircraft are drawn at: behind the newest data by the buffer delay. */
export function aircraftRenderTime(): number {
  return serverNow() - settingsStore.get().interpolationDelayMs
}

interface ClassBatch {
  /** A livery/type model: its real [length, span] and wheels' depth. */
  model?: { fit: [number, number] | null; lowest: number }
  mesh: InstancedMesh
  geometry: BufferGeometry
  /** Instances written this frame. */
  count: number
  matrices: Float32Array
  colors: Float32Array
  shading: Float32Array
  groundLight: Float32Array
}

const sun = new Vector3()
const groundLightScratch = new Vector3()
const shadingScratch = { x: 0, y: 0, z: 0 }

/**
 * All aircraft as instanced class placeholders (one InstancedMesh per
 * airframe class), updated in two phases per frame:
 *
 * 1. `updatePoses` (before cameras move): interpolated position and smoothed
 *    attitude for every aircraft, stored on the aircraft, so a following
 *    camera and the instances use the same pose in the same frame.
 * 2. `updateInstances` (after cameras moved): instance matrices relative to
 *    the camera, computed in float64, so float32 matrices keep ~mm precision
 *    near the camera even though ECEF coordinates are ~6.4e6 m.
 */
export class AircraftInstances {
  readonly group = new Group()
  readonly material = createAircraftMaterial()
  readonly arrows = new AircraftArrows()
  /** 0 globe … 1 riding along (markers at true size), eased. */
  private attachBlend = 0
  private lastUpdate = performance.now()
  private readonly batches = new Map<AircraftClass, ClassBatch>()
  /** glTF models by URL, once loaded (null while loading or failed). */
  private readonly modelBatches = new Map<string, ClassBatch | null>()
  private manifest: ModelManifest | null = null
  /** Model URL per aircraft, by the type/class/callsign it was chosen for. */
  private readonly modelChoice = new Map<string, { key: string; entry: ModelEntry | null }>()

  constructor() {
    this.group.name = 'aircraft'
    for (const cls of CLASSES) {
      const geometry = buildAirframe(AIRFRAMES[cls], { segments: 6 })
      const mesh = createMesh(geometry, this.material, `aircraft-${cls}`)
      this.group.add(mesh)
      this.batches.set(cls, {
        mesh,
        geometry,
        count: 0,
        matrices: mesh.instanceMatrix.array as Float32Array,
        colors: mesh.instanceColor!.array as Float32Array,
        shading: mesh.geometry.getAttribute('instanceShading').array as Float32Array,
        groundLight: mesh.geometry.getAttribute('instanceGroundLight').array as Float32Array
      })
    }
    void loadManifest().then(manifest => {
      this.manifest = manifest
    })
  }

  /**
   * The model batch for an aircraft (its airline's livery, else its type's,
   * else its class's model), or null to use the class placeholder: no
   * model for it, or not loaded yet. Placeholders are only for classes
   * without a model.
   */
  private modelBatch(aircraft: { hex: string; cls: AircraftClass; state: { typeCode: string | null; callsign: string | null } }): ClassBatch | null {
    const manifest = this.manifest
    if (manifest == null) return null
    const key = `${aircraft.cls}|${aircraft.state.typeCode}|${aircraft.state.callsign}`
    let choice = this.modelChoice.get(aircraft.hex)
    if (choice?.key !== key) {
      choice = { key, entry: findModelEntry(manifest, aircraft.state.typeCode, aircraft.cls, aircraft.state.callsign) }
      this.modelChoice.set(aircraft.hex, choice)
    }
    const entry = choice.entry
    if (entry == null) return null
    const batch = this.modelBatches.get(entry.url)
    if (batch === undefined) {
      this.modelBatches.set(entry.url, null)
      void loadInstancedModel(entry).then(model => {
        if (model == null) return
        const geometry = model.geometry.clone()
        const mesh = createMesh(geometry, model.material, `aircraft-model-${entry.url}`)
        this.group.add(mesh)
        this.modelBatches.set(entry.url, {
          model: { fit: entry.fit ?? null, lowest: model.lowest },
          mesh,
          geometry,
          count: 0,
          matrices: mesh.instanceMatrix.array as Float32Array,
          colors: mesh.instanceColor!.array as Float32Array,
          shading: mesh.geometry.getAttribute('instanceShading').array as Float32Array,
          groundLight: mesh.geometry.getAttribute('instanceGroundLight').array as Float32Array
        })
      })
      return null
    }
    return batch
  }

  private allBatches(): ClassBatch[] {
    const all = [...this.batches.values()]
    for (const batch of this.modelBatches.values()) if (batch != null) all.push(batch)
    return all
  }

  dispose(): void {
    for (const batch of this.allBatches()) {
      batch.geometry.dispose()
      batch.mesh.dispose()
    }
    this.material.dispose()
    this.arrows.dispose()
  }

  updatePoses(dt: number): void {
    const now = serverNow()
    const maxDelay = settingsStore.get().interpolationDelayMs
    const ease = smoothingFactor(dt, DELAY_TIME_CONSTANT)
    const selectedHex = selectionStore.get().selectedHex
    const camera = cameraModeStore.get()
    const followedHex = camera.mode === 'globe' ? null : camera.targetHex
    for (const aircraft of flightConnection.registry.list) {
      aircraft.pose ??= createPose()
      const detailed =
        aircraft.cameraDistance < DETAIL_DISTANCE || aircraft.hex === selectedHex
      // Per-aircraft delay: short for frequently updated (followed) aircraft,
      // eased so the switch speeds playback up briefly instead of jumping.
      const target = adaptiveDelayMs(aircraft.motion, maxDelay)
      const attitude = aircraft.attitude
      attitude.delayMs = attitude.delayMs < 0 ? target : attitude.delayMs + (target - attitude.delayMs) * ease
      computePose(aircraft, now - attitude.delayMs, dt, detailed, aircraft.pose, aircraft.hex === followedHex)
    }
  }

  private slot(batch: ClassBatch): { batch: ClassBatch; index: number } {
    const index = batch.count++
    if (index >= batch.mesh.instanceMatrix.count) {
      // Grow, keeping what was written this frame.
      const old = batch
      const capacity = old.mesh.instanceMatrix.count * 2
      const matrices = old.matrices
      const colors = old.colors
      const shading = old.shading
      const groundLight = old.groundLight
      allocate(old.mesh, capacity)
      batch.matrices = old.mesh.instanceMatrix.array as Float32Array
      batch.colors = old.mesh.instanceColor!.array as Float32Array
      batch.shading = old.mesh.geometry.getAttribute('instanceShading').array as Float32Array
      batch.groundLight = old.mesh.geometry.getAttribute('instanceGroundLight').array as Float32Array
      batch.matrices.set(matrices)
      batch.colors.set(colors)
      batch.shading.set(shading)
      batch.groundLight.set(groundLight)
    }
    return { batch, index }
  }

  updateInstances(
    camera: PerspectiveCamera,
    viewportHeight: number,
    sunDirection: Vector3 | null
  ): void {
    const list = flightConnection.registry.list
    for (const batch of this.allBatches()) batch.count = 0

    const origin = camera.position
    this.group.position.copy(origin)
    aircraftRenderState.origin.copy(origin)
    if (aircraftRenderState.positions.length < list.length * 3) {
      aircraftRenderState.positions = new Float64Array(list.length * 6)
    }
    const positions = aircraftRenderState.positions
    const hexes = aircraftRenderState.hexes
    hexes.length = list.length

    if (sunDirection != null) sun.copy(sunDirection)
    const anchorLength = lightAnchor.length()
    const anchorSky = skyBrightness(
      anchorLength > 0 ? sun.dot(lightAnchor) / anchorLength : 1
    )

    const selectedHex = selectionStore.get().selectedHex
    const pixelToWorld =
      (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight)
    const cameraAltitude = origin.length() - 6_371_000
    // Markers shrink to true size once the camera rides with an aircraft,
    // not the moment a fly-in starts (they visibly vanished mid-flight).
    const cameraMode = cameraModeStore.get()
    const attached = cameraMode.mode !== 'globe' && !cameraMode.transitioning
    // Eased over ATTACH_BLEND_MS rather than switched: every marker on
    // screen shrinking in one frame read as a jolt as a fly-in ended.
    const now0 = performance.now()
    const step = Math.min(1, (now0 - this.lastUpdate) / ATTACH_BLEND_MS)
    this.lastUpdate = now0
    this.attachBlend += Math.max(-step, Math.min(step, (attached ? 1 : 0) - this.attachBlend))
    const blend = smoothstep(0, 1, this.attachBlend)
    const globePixels =
      MARKER_PIXELS_NEAR + (MARKER_PIXELS_ORBIT - MARKER_PIXELS_NEAR) * smoothstep(300_000, 8_000_000, cameraAltitude)
    const markerPixels = globePixels + (MARKER_PIXELS_ATTACHED - globePixels) * blend

    const arrows = this.arrows
    arrows.begin(origin)
    const overview = smoothstep(ARROW_HEIGHT_FROM, ARROW_HEIGHT_TO, ecefToGeodetic(origin.x, origin.y, origin.z).height)
    const now = performance.now()
    let count = 0
    for (let i = 0; i < list.length; ++i) {
      const aircraft = list[i]!
      const pose = aircraft.pose
      if (pose == null) continue
      const x = pose.position.x - origin.x
      const y = pose.position.y - origin.y
      const z = pose.position.z - origin.z
      const distance = Math.sqrt(x * x + y * y + z * z)
      aircraft.cameraDistance = distance
      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
      hexes[i] = aircraft.hex
      count = i + 1
      // Aircraft drawn as detailed models are skipped here.
      if (detailedHexes.has(aircraft.hex) || pose.opacity <= 0) continue

      const selected = aircraft.hex === selectedHex
      const minPixels = selected ? SELECTED_MARKER_PIXELS : markerPixels
      // Real size up close; at least `minPixels` long far away, whatever the
      // class (a distant C172 is as findable as an airliner).
      const iconScale = Math.max(
        1,
        (minPixels * distance * pixelToWorld) /
          (AIRFRAMES[aircraft.cls].length * aircraft.scale.length)
      )
      const appear = smoothstep(0, APPEAR_MS, now - aircraft.firstSeen)
      // In the high overview, a map arrow instead of the 3D model (never
      // riding along, nor for aircraft drawn at true size).
      const arrow = attached || iconScale <= 1.5 ? 0 : overview
      if (arrow > 0) {
        const ground = aircraft.state.onGround
        arrows.add(
          x,
          y,
          z,
          pose.forward,
          aircraft.category,
          minPixels * ARROW_SIZE * (0.6 + 0.4 * appear) * (ground && !selected ? GROUND_ARROW_SIZE : 1),
          arrow * appear * pose.opacity * (ground && !selected ? GROUND_ARROW_ALPHA : 1),
          selected
        )
        if (arrow >= 1) continue
      }
      // Stale aircraft shrink away instead of popping; new ones grow in.
      const scale = iconScale * pose.opacity * appear
      // Placeholder → real type dimensions (span on X, length on Y/Z).
      // Livery/type model where there is one (real gear, sized to the
      // type); else the class placeholder (no gear: on the ground it
      // rests on its belly, else it hovers a gear-length above the apron).
      const model = this.modelBatch(aircraft)
      let spanScale: number
      let lengthScale: number
      let drop: number
      const params = AIRFRAMES[aircraft.cls]
      if (model?.model != null) {
        const [typeLength, typeSpan] = typeDimensions(aircraft.state.typeCode, aircraft.cls)
        const fit = model.model.fit ?? [typeLength, typeSpan]
        lengthScale = (scale * typeLength) / fit[0]
        spanScale = (scale * typeSpan) / fit[1]
        // As detailed models: the wheels at the placeholder's gear height
        // below the pose (on the ground: on the surface).
        drop = params.groundClearance * aircraft.scale.length + model.model.lowest * lengthScale
      } else {
        spanScale = scale * aircraft.scale.span
        lengthScale = scale * aircraft.scale.length
        drop =
          aircraft.attitude.ground *
          Math.max(0, params.groundClearance * aircraft.scale.length - params.fuselageRadius * lengthScale)
      }

      const { batch, index } = this.slot(model ?? this.batches.get(aircraft.cls)!)
      const m = batch.matrices
      const { left, up, forward } = pose
      const px = x - up.x * drop
      const py = y - up.y * drop
      const pz = z - up.z * drop
      const o = index * 16
      m[o + 0] = left.x * spanScale
      m[o + 1] = left.y * spanScale
      m[o + 2] = left.z * spanScale
      m[o + 3] = 0
      m[o + 4] = up.x * lengthScale
      m[o + 5] = up.y * lengthScale
      m[o + 6] = up.z * lengthScale
      m[o + 7] = 0
      m[o + 8] = forward.x * lengthScale
      m[o + 9] = forward.y * lengthScale
      m[o + 10] = forward.z * lengthScale
      m[o + 11] = 0
      m[o + 12] = px
      m[o + 13] = py
      m[o + 14] = pz
      m[o + 15] = 1

      // Models show their livery as painted; placeholders take the marker
      // tint (orange when selected).
      const color = model != null ? COLOR_MODEL : selected ? COLOR_SELECTED : COLOR_DEFAULT
      batch.colors[index * 3] = color.r
      batch.colors[index * 3 + 1] = color.g
      batch.colors[index * 3 + 2] = color.b

      // Icons (scaled-up markers) glow so they stay findable at night; at
      // true size aircraft are only lit by the sun and sky.
      aircraftShading(
        sun.x,
        sun.y,
        sun.z,
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.height,
        // No icon glow while riding along: nav lights do that job.
        (1 - blend) * Math.min(1, (iconScale - 1) / 4),
        anchorSky,
        selected,
        shadingScratch
      )
      batch.shading[index * 3] = shadingScratch.x
      batch.shading[index * 3 + 1] = shadingScratch.y
      batch.shading[index * 3 + 2] = shadingScratch.z

      // Detailed aircraft already receive local apron/street spill. Feed the
      // same irradiance to nearby instanced models so selection or batching
      // never decides whether a parked aircraft is lit.
      const groundOffset = index * 3
      const groundLight = groundLightScratch.set(0, 0, 0)
      const roads = nightEmission.roads
      if (
        roads != null &&
        nightEmission.enabled &&
        nightState.night > 0 &&
        distance < GROUND_LIGHT_DISTANCE &&
        aircraft.groundHeight != null
      ) {
        const agl = pose.height - aircraft.groundHeight
        const nearGround = 1 - Math.min(1, Math.max(0, (agl - 30) / 170))
        if (nearGround > 0 && roads.groundLight(pose.position, groundLight)) {
          groundLight.multiplyScalar(GROUND_LIGHT_GAIN * nearGround * nightState.night)
        }
      }
      batch.groundLight[groundOffset] = groundLight.x
      batch.groundLight[groundOffset + 1] = groundLight.y
      batch.groundLight[groundOffset + 2] = groundLight.z
    }
    aircraftRenderState.count = count
    arrows.end()
    for (const batch of this.allBatches()) {
      batch.mesh.count = batch.count
      if (batch.count === 0) continue
      batch.mesh.instanceMatrix.needsUpdate = true
      batch.mesh.instanceColor!.needsUpdate = true
      batch.mesh.geometry.getAttribute('instanceShading').needsUpdate = true
      batch.mesh.geometry.getAttribute('instanceGroundLight').needsUpdate = true
    }
  }
}
