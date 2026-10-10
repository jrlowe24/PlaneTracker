import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  type PerspectiveCamera
} from 'three'

import { ecefToGeodetic } from '@windowseat/shared'

import { cloudTransmittance } from '../clouds/cloudDepth'
import { flightConnection } from '../data/flightConnection'
import { nightState } from '../scene/nightLighting'
import { AIRFRAMES } from './airframes'
import { detailedHexes, modelLightAnchors } from './detailState'
import { AIRCRAFT_LAYER } from './layers'
import { glowLights, glowState, MAX_SURFACE_LIGHTS, surfaceLights } from './navLightsStore'

/**
 * Aircraft navigation lights: red left wingtip, green right wingtip, white
 * tail, red anti-collision beacons (top and bottom, ~1 Hz) and white
 * wingtip strobes (double flash, airborne only). Small, very bright
 * emissive cores kept at least ~1 px across (the bloom pass adds the glow),
 * so aircraft read as moving lights at night; masked out of post lighting
 * like the aircraft (aerial perspective still dims distant lights).
 */

const LIGHTS_PER_AIRCRAFT = 7
/** Physical light radius, meters (the lens, not the glow). */
const LIGHT_RADIUS = 0.09
/** Minimum on-screen radius, pixels. */
const MIN_PIXELS = 1.1
/** Lights further than this aren't drawn (icons/markers take over). */
const MAX_DISTANCE = 120_000
/** Lights get a glow halo (NavGlowEffect) within this distance. */
const GLOW_MAX_DISTANCE = 40_000

// Displayed brightness (radiance × exposure): bright enough to read as
// emitters (selective bloom adds the glow) but not so far past white that
// tone mapping washes out red and green. Divided by the current exposure,
// so lights don't blind when exposure adapts up at night.
const RED: [number, number, number] = [3.2, 0.12, 0.06]
const GREEN: [number, number, number] = [0.12, 2.8, 0.9]
const WHITE: [number, number, number] = [2.2, 2.2, 2.2]
const STROBE: [number, number, number] = [7, 7, 7.4]

/**
 * Light the lights throw on the detailed model around them (wingtip,
 * winglet, tail cone; the beacons and strobes reach the fuselage and
 * wings), in candela. Converted to renderer irradiance with the same
 * perceptual night scale as moonlight (nightLighting.ts): by day they're
 * lost in sunlight, as they are in reality.
 */
const SURFACE_CD = { nav: 40, tail: 20, beacon: 35, strobe: 200 }
/** Renderer irradiance per lux at full night (FULL_MOON / 0.25 lux, toned down). */
const NIGHT_LUX = 0.03
/** Reach of a light on the model (m): steady lights only their own surroundings. */
const SURFACE_RANGE = { nav: 4.5, tail: 5, beacon: 9, strobe: 18 }
/** Only aircraft this close have their surfaces lit (detailed models anyway). */
const SURFACE_MAX_DISTANCE = 3000

interface SurfaceLight {
  x: number
  y: number
  z: number
  distance: number
  range: number
  r: number
  g: number
  b: number
}
const surfacePool: SurfaceLight[] = []
let surfaceCount = 0
const byDistance = (a: SurfaceLight, b: SurfaceLight): number => a.distance - b.distance

/** Stable per-aircraft phase so lights don't flash in sync. */
function phaseOf(hex: string): number {
  let h = 0
  for (let i = 0; i < hex.length; ++i) h = (h * 31 + hex.charCodeAt(i)) | 0
  return ((h >>> 0) % 1000) / 1000
}

export class NavLights {
  readonly mesh: InstancedMesh
  private capacity = 0
  private readonly geometry = new OctahedronGeometry(1, 0)
  private readonly material = new MeshBasicMaterial({ color: 0xffffff })

  constructor() {
    this.mesh = new InstancedMesh(this.geometry, this.material, 1)
    this.mesh.frustumCulled = false
    this.mesh.layers.enable(AIRCRAFT_LAYER)
    this.mesh.name = 'nav-lights'
    this.allocate(4096)
  }

  private allocate(capacity: number): void {
    this.capacity = capacity
    this.mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.mesh.instanceColor.setUsage(DynamicDrawUsage)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
  }

  update(camera: PerspectiveCamera, viewportHeight: number, time: number, exposure: number): void {
    const list = flightConnection.registry.list
    const needed = list.length * LIGHTS_PER_AIRCRAFT
    if (needed > this.capacity) {
      let capacity = this.capacity
      while (capacity < needed) capacity *= 2
      this.allocate(capacity)
    }
    const origin = camera.position
    this.mesh.position.copy(origin)
    const matrices = this.mesh.instanceMatrix.array as Float32Array
    const colors = this.mesh.instanceColor!.array as Float32Array
    const pixelToWorld =
      (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight)
    // Lights stand out most at dusk and night.
    const visibility = (0.12 + 0.88 * nightState.night) / Math.max(exposure, 1e-3)

    // Halos are drawn over the finished image (NavGlowEffect, which has no
    // texture unit left for the clouds): dim them by the cloud between
    // camera and aircraft here instead.
    const earthRadius = origin.length() - ecefToGeodetic(origin.x, origin.y, origin.z).height
    let glowScale = 1

    let n = 0
    const put = (
      x: number,
      y: number,
      z: number,
      distance: number,
      color: readonly [number, number, number],
      intensity: number,
      size = 1
    ): void => {
      if (intensity <= 0) return
      const minSize = MIN_PIXELS * distance * pixelToWorld
      const s = Math.max(LIGHT_RADIUS, minSize)
      // Once held at the minimum on-screen size, dim with distance (a far
      // light is a faint point, not a big glow).
      if (minSize > LIGHT_RADIUS) intensity *= Math.max(0.12, LIGHT_RADIUS / minSize)
      const o = n * 16
      matrices[o] = s
      matrices[o + 1] = 0
      matrices[o + 2] = 0
      matrices[o + 3] = 0
      matrices[o + 4] = 0
      matrices[o + 5] = s
      matrices[o + 6] = 0
      matrices[o + 7] = 0
      matrices[o + 8] = 0
      matrices[o + 9] = 0
      matrices[o + 10] = s
      matrices[o + 11] = 0
      matrices[o + 12] = x
      matrices[o + 13] = y
      matrices[o + 14] = z
      matrices[o + 15] = 1
      const k = intensity * visibility
      colors[n * 3] = color[0] * k
      colors[n * 3 + 1] = color[1] * k
      colors[n * 3 + 2] = color[2] * k
      ++n
      if (distance < GLOW_MAX_DISTANCE) {
        const g = (glowLights[glowState.count] ??= { x: 0, y: 0, z: 0, distance: 0, r: 0, g: 0, b: 0, size: 1 })
        g.x = x
        g.y = y
        g.z = z
        g.distance = distance
        g.r = color[0] * k * glowScale
        g.g = color[1] * k * glowScale
        g.b = color[2] * k * glowScale
        g.size = size
        ++glowState.count
      }
    }
    glowState.count = 0
    surfaceCount = 0
    const surfaceScale = NIGHT_LUX * nightState.night
    /** A light on a detailed model, lighting the model around it. */
    const lightSurface = (
      x: number,
      y: number,
      z: number,
      distance: number,
      color: readonly [number, number, number],
      candela: number,
      range: number
    ): void => {
      if (candela <= 0 || surfaceScale <= 0) return
      const s = (surfacePool[surfaceCount++] ??= { x: 0, y: 0, z: 0, distance: 0, range: 0, r: 0, g: 0, b: 0 })
      // Hue of the light, normalized so candela sets the brightness.
      const k = (candela * surfaceScale) / Math.max(color[0], color[1], color[2])
      s.x = x
      s.y = y
      s.z = z
      s.distance = distance
      s.range = range
      s.r = color[0] * k
      s.g = color[1] * k
      s.b = color[2] * k
    }

    for (const aircraft of list) {
      const pose = aircraft.pose
      if (pose == null || pose.opacity <= 0) continue
      const dx = pose.position.x - origin.x
      const dy = pose.position.y - origin.y
      const dz = pose.position.z - origin.z
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (distance > MAX_DISTANCE) continue
      glowScale =
        distance < GLOW_MAX_DISTANCE
          ? cloudTransmittance(pose.position, pose.position.length() - earthRadius, origin.length() - earthRadius)
          : 1
      // The camera sits inside the followed aircraft in window view; its own
      // wingtip light is still visible, which is right.
      const p = AIRFRAMES[aircraft.cls]
      const isDetailedEarly = detailedHexes.has(aircraft.hex)
      const ls = aircraft.scale.length
      const halfSpan = (p.wingSpan > 0 ? p.wingSpan / 2 : p.fuselageRadius * 1.2) * aircraft.scale.span
      const sweep = Math.tan((p.wingSweep * Math.PI) / 180) * Math.max(0, halfSpan - p.fuselageRadius * ls)
      const wingY = p.wingMount * p.fuselageRadius * 0.85 * ls + Math.tan((p.wingDihedral * Math.PI) / 180) * halfSpan
      const tipZ = p.wingRootZ * ls - sweep - p.wingTipChord * ls * 0.5
      const r = p.fuselageRadius * ls
      const { left, up, forward } = pose
      // Simplified (non-detailed) models rest on their bellies on the ground
      // (see aircraftInstances); their lights follow.
      const sink = isDetailedEarly
        ? 0
        : aircraft.attitude.ground * Math.max(0, p.groundClearance * ls - p.fuselageRadius * ls)
      const at = (bx: number, by: number, bz: number): [number, number, number] => [
        dx + left.x * bx + up.x * (by - sink) + forward.x * bz,
        dy + left.y * bx + up.y * (by - sink) + forward.y * bz,
        dz + left.z * bx + up.z * (by - sink) + forward.z * bz
      ]
      const phase = phaseOf(aircraft.hex)
      const t = time + phase * 3
      // Beacon: ~1 Hz short flash; strobes: double flash every 1.3 s.
      const beacon = t % 1 < 0.12 ? 1 : 0
      const strobeT = t % 1.3
      const strobe = !pose.onGround && (strobeT < 0.05 || (strobeT > 0.15 && strobeT < 0.2)) ? 1 : 0
      const isDetailed = detailedHexes.has(aircraft.hex)
      const lit = isDetailed && distance < SURFACE_MAX_DISTANCE

      // A glTF model's own light positions when it's drawn; else the class
      // placeholder's proportions.
      const anchors = isDetailed ? modelLightAnchors.get(aircraft.hex) : undefined
      const tip = anchors?.wingtip
      const [lx, ly, lz] = tip != null ? at(tip.x, tip.y, tip.z) : at(halfSpan, wingY, tipZ)
      put(lx, ly, lz, distance, RED, 1)
      if (lit) lightSurface(lx, ly, lz, distance, RED, SURFACE_CD.nav, SURFACE_RANGE.nav)
      const [rx, ry, rz] = tip != null ? at(-tip.x, tip.y, tip.z) : at(-halfSpan, wingY, tipZ)
      put(rx, ry, rz, distance, GREEN, 1)
      if (lit) lightSurface(rx, ry, rz, distance, GREEN, SURFACE_CD.nav, SURFACE_RANGE.nav)
      const tailAt = anchors?.tail
      const [tx, ty, tz] = tailAt != null ? at(0, tailAt.y, tailAt.z) : at(0, r * 0.3, (-p.length / 2) * ls)
      put(tx, ty, tz, distance, WHITE, 1)
      if (lit) lightSurface(tx, ty, tz, distance, WHITE, SURFACE_CD.tail, SURFACE_RANGE.tail)
      const topAt = anchors?.top
      const [bx, by, bz] = topAt != null ? at(0, topAt.y + 0.15, topAt.z) : at(0, r * 1.02, 0)
      put(bx, by, bz, distance, RED, beacon * 1.6, 1.5)
      if (lit) lightSurface(bx, by, bz, distance, RED, beacon * SURFACE_CD.beacon, SURFACE_RANGE.beacon)
      // Belly beacon and strobes only when close enough to matter.
      if (isDetailed || distance < 20_000) {
        const bottomAt = anchors?.bottom
        const [ux, uy, uz] =
          bottomAt != null ? at(0, bottomAt.y - 0.15, bottomAt.z) : at(0, -r * 1.02, -r)
        const belly = (t + 0.5) % 1 < 0.12 ? 1 : 0
        put(ux, uy, uz, distance, RED, belly * 1.6, 1.5)
        if (lit) lightSurface(ux, uy, uz, distance, RED, belly * SURFACE_CD.beacon, SURFACE_RANGE.beacon)
      }
      put(lx, ly, lz, distance, STROBE, strobe, 1.8)
      put(rx, ry, rz, distance, STROBE, strobe, 1.8)
      if (lit) {
        lightSurface(lx, ly, lz, distance, STROBE, strobe * SURFACE_CD.strobe, SURFACE_RANGE.strobe)
        lightSurface(rx, ry, rz, distance, STROBE, strobe * SURFACE_CD.strobe, SURFACE_RANGE.strobe)
      }
    }
    this.mesh.count = n

    // The nearest lights light the models (unused slots: range 0).
    const nearest = surfacePool.slice(0, surfaceCount).sort(byDistance)
    for (let i = 0; i < MAX_SURFACE_LIGHTS; ++i) {
      const s = nearest[i]
      if (s == null) {
        surfaceLights.position[i]!.w = 0
        continue
      }
      surfaceLights.position[i]!.set(s.x, s.y, s.z, s.range)
      surfaceLights.color[i]!.set(s.r, s.g, s.b)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor!.needsUpdate = true
  }
}
