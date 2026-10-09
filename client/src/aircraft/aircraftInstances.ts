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
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { settingsStore } from '../state/settings'
import { createAircraftMaterial } from './aircraftMaterial'
import { aircraftRenderState } from './aircraftRenderState'
import { AIRFRAMES, buildAirframe, type AircraftClass } from './airframes'
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

const COLOR_DEFAULT = new Color(0.86, 0.87, 0.89)
const COLOR_SELECTED = new Color(0.95, 0.42, 0.05)

const CLASSES = Object.keys(AIRFRAMES) as AircraftClass[]

function allocate(mesh: InstancedMesh, capacity: number): void {
  mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  mesh.instanceColor.setUsage(DynamicDrawUsage)
  const shading = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  shading.setUsage(DynamicDrawUsage)
  mesh.geometry.setAttribute('instanceShading', shading)
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
  mesh: InstancedMesh
  geometry: BufferGeometry
  /** Instances written this frame. */
  count: number
  matrices: Float32Array
  colors: Float32Array
  shading: Float32Array
}

const sun = new Vector3()
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
  private readonly batches = new Map<AircraftClass, ClassBatch>()

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
        shading: mesh.geometry.getAttribute('instanceShading').array as Float32Array
      })
    }
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      batch.geometry.dispose()
      batch.mesh.dispose()
    }
    this.material.dispose()
  }

  updatePoses(dt: number): void {
    const now = serverNow()
    const maxDelay = settingsStore.get().interpolationDelayMs
    const ease = smoothingFactor(dt, DELAY_TIME_CONSTANT)
    const selectedHex = selectionStore.get().selectedHex
    for (const aircraft of flightConnection.registry.list) {
      aircraft.pose ??= createPose()
      const detailed =
        aircraft.cameraDistance < DETAIL_DISTANCE || aircraft.hex === selectedHex
      // Per-aircraft delay: short for frequently updated (followed) aircraft,
      // eased so the switch speeds playback up briefly instead of jumping.
      const target = adaptiveDelayMs(aircraft.motion, maxDelay)
      const attitude = aircraft.attitude
      attitude.delayMs = attitude.delayMs < 0 ? target : attitude.delayMs + (target - attitude.delayMs) * ease
      computePose(aircraft, now - attitude.delayMs, dt, detailed, aircraft.pose)
    }
  }

  private slot(cls: AircraftClass): { batch: ClassBatch; index: number } {
    const batch = this.batches.get(cls)!
    const index = batch.count++
    if (index >= batch.mesh.instanceMatrix.count) {
      // Grow, keeping what was written this frame.
      const old = batch
      const capacity = old.mesh.instanceMatrix.count * 2
      const matrices = old.matrices
      const colors = old.colors
      const shading = old.shading
      allocate(old.mesh, capacity)
      batch.matrices = old.mesh.instanceMatrix.array as Float32Array
      batch.colors = old.mesh.instanceColor!.array as Float32Array
      batch.shading = old.mesh.geometry.getAttribute('instanceShading').array as Float32Array
      batch.matrices.set(matrices)
      batch.colors.set(colors)
      batch.shading.set(shading)
    }
    return { batch, index }
  }

  updateInstances(
    camera: PerspectiveCamera,
    viewportHeight: number,
    sunDirection: Vector3 | null
  ): void {
    const list = flightConnection.registry.list
    for (const batch of this.batches.values()) batch.count = 0

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
    const attached = cameraModeStore.get().mode !== 'globe'
    const markerPixels = attached
      ? MARKER_PIXELS_ATTACHED
      : MARKER_PIXELS_NEAR +
        (MARKER_PIXELS_ORBIT - MARKER_PIXELS_NEAR) *
          smoothstep(300_000, 8_000_000, cameraAltitude)

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
      // Stale aircraft shrink away instead of popping.
      const scale = iconScale * pose.opacity
      // Placeholder → real type dimensions (span on X, length on Y/Z).
      const spanScale = scale * aircraft.scale.span
      const lengthScale = scale * aircraft.scale.length

      const { batch, index } = this.slot(aircraft.cls)
      const m = batch.matrices
      const { left, up, forward } = pose
      // These simplified models have no landing gear: on the ground, lower
      // the fuselage axis from gear height to resting on its belly (else the
      // aircraft hovers a gear-length above the apron).
      const params = AIRFRAMES[aircraft.cls]
      const sink =
        aircraft.attitude.ground *
        Math.max(0, params.groundClearance * aircraft.scale.length - params.fuselageRadius * lengthScale)
      const px = x - up.x * sink
      const py = y - up.y * sink
      const pz = z - up.z * sink
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

      const color = selected ? COLOR_SELECTED : COLOR_DEFAULT
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
        attached ? 0 : Math.min(1, (iconScale - 1) / 4),
        anchorSky,
        selected,
        shadingScratch
      )
      batch.shading[index * 3] = shadingScratch.x
      batch.shading[index * 3 + 1] = shadingScratch.y
      batch.shading[index * 3 + 2] = shadingScratch.z
    }
    aircraftRenderState.count = count
    for (const batch of this.batches.values()) {
      batch.mesh.count = batch.count
      if (batch.count === 0) continue
      batch.mesh.instanceMatrix.needsUpdate = true
      batch.mesh.instanceColor!.needsUpdate = true
      batch.mesh.geometry.getAttribute('instanceShading').needsUpdate = true
    }
  }
}
