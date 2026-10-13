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
import { qualityStore } from '../state/quality'
import { flightConnection } from '../data/flightConnection'
import { nightState } from '../scene/nightLighting'
import { AIRFRAMES } from './airframes'
import { detailedHexes, modelLightAnchors } from './detailState'
import { AIRCRAFT_LAYER } from './layers'
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { nightLightingTestStore } from '../nightLights/nightLightsStore'
import {
  glowLights,
  glowState,
  lightBeams,
  MAX_LIGHT_BEAMS,
  MAX_SURFACE_LIGHTS,
  surfaceLights
} from './navLightsStore'

/**
 * Aircraft navigation lights: red left wingtip, green right wingtip, white
 * tail, red anti-collision beacons (top and bottom, ~1 Hz) and white
 * wingtip strobes (double flash, airborne only). Small, very bright
 * emissive cores kept at least ~1 px across (the bloom pass adds the glow),
 * so aircraft read as moving lights at night; masked out of post lighting
 * like the aircraft (aerial perspective still dims distant lights).
 */

const DEG_RAD = Math.PI / 180

const LIGHTS_PER_AIRCRAFT = 12
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
const SURFACE_CD = {
  nav: 70,
  tail: 35,
  logo: 320,
  beacon: 180,
  strobe: 900
}
/** Renderer irradiance per lux at full night (FULL_MOON / 0.25 lux, toned down). */
const NIGHT_LUX = 0.03
/**
 * Landing lights (wing roots) and the taxi light (nose gear): very bright
 * and narrow, so they blaze when they point at you and are faint points
 * from the side (FACING_POWER shapes the beam as seen from outside).
 * Landing lights are on below LANDING_LIGHTS_AGL and on the takeoff and
 * landing roll; the taxi light whenever the aircraft moves on the ground.
 */
const LANDING: [number, number, number] = [6.5, 6.2, 5.6]
const TAXI: [number, number, number] = [4.2, 4.0, 3.6]
const FACING_POWER = 10
const SIDE_GLOW = 0.06
const LANDING_LIGHTS_AGL = 3000
const TAKEOFF_ROLL_SPEED = 40
const TAXI_SPEED = 2.5
/**
 * Beams on the ground (night lights pass): renderer irradiance at 1 m on
 * the axis, aim below the horizon (degrees) and cone half-angle cosine.
 * Only aircraft near the ground and the camera throw a visible beam.
 */
const BEAM = {
  landing: { intensity: 120, aim: 17, cos: Math.cos(15 * DEG_RAD) },
  taxi: { intensity: 45, aim: 22, cos: Math.cos(20 * DEG_RAD) }
}
const BEAM_MAX_AGL = 250
const BEAM_MAX_DISTANCE = 6000

interface BeamCandidate {
  owner: string
  x: number
  y: number
  z: number
  dx: number
  dy: number
  dz: number
  intensity: number
  cos: number
  distance: number
}
const beamPool: BeamCandidate[] = []
let beamCount = 0
let priorityBeamHex: string | null = null
const byBeamDistance = (a: BeamCandidate, b: BeamCandidate): number =>
  Number(b.owner === priorityBeamHex) - Number(a.owner === priorityBeamHex) || a.distance - b.distance

/** Reach of a light on the model (m): steady lights only their own surroundings. */
const SURFACE_RANGE = {
  nav: 6,
  tail: 6.5,
  logo: 18,
  beacon: 13,
  strobe: 24
}
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
  dx: number
  dy: number
  dz: number
  cone: number
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
    lightBeams.origin.copy(origin)
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
    beamCount = 0
    const landingLights = qualityStore.get().settings.landingLights
    // Emitters remain visible during the day, especially when the aircraft
    // sits in a building shadow. Their surface spill must follow that same
    // visibility instead of dropping to exactly zero until full night.
    const surfaceScale = NIGHT_LUX * (0.12 + 0.88 * nightState.night)
    /** A light on a detailed model, lighting the model around it. */
    const lightSurface = (
      x: number,
      y: number,
      z: number,
      distance: number,
      color: readonly [number, number, number],
      candela: number,
      range: number,
      direction?: readonly [number, number, number],
      cone = -2
    ): void => {
      if (candela <= 0 || surfaceScale <= 0) return
      const s = (surfacePool[surfaceCount++] ??= {
        x: 0,
        y: 0,
        z: 0,
        distance: 0,
        range: 0,
        r: 0,
        g: 0,
        b: 0,
        dx: 0,
        dy: 0,
        dz: 0,
        cone: -2
      })
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
      s.dx = direction?.[0] ?? 0
      s.dy = direction?.[1] ?? 0
      s.dz = direction?.[2] ?? 0
      s.cone = cone
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
      const tipZ = p.wingRootZ * ls - sweep + p.wingTipChord * ls * 0.5
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
      const modelTransform = isDetailed ? undefined : aircraft.renderLights
      const anchors = isDetailed ? modelLightAnchors.get(aircraft.hex) : modelTransform?.anchors
      const anchorAt = (v: { x: number; y: number; z: number }): [number, number, number] =>
        modelTransform == null ? at(v.x, v.y, v.z) :
          at(v.x * modelTransform.span, v.y * modelTransform.length + modelTransform.lift + sink, v.z * modelTransform.length)
      const tip = anchors?.wingtip
      const [lx, ly, lz] = tip != null ? anchorAt(tip) : at(halfSpan, wingY, tipZ)
      put(lx, ly, lz, distance, RED, 0.65, 0.7)
      // Navigation lenses are shielded at the leading edge. Their sprite
      // and glare stay visible, but they do not flood the wing behind them.
      const [rx, ry, rz] = tip != null ? anchorAt({ x: -tip.x, y: tip.y, z: tip.z }) : at(-halfSpan, wingY, tipZ)
      put(rx, ry, rz, distance, GREEN, 0.65, 0.7)
      const tailAt = anchors?.tail
      const [tx, ty, tz] = tailAt != null ? anchorAt({ x: 0, y: tailAt.y, z: tailAt.z }) : at(0, r * 0.3, (-p.length / 2) * ls)
      put(tx, ty, tz, distance, WHITE, 0.22, 0.4)
      // Airliner logo lights sit on the aft fuselage / horizontal tail and
      // wash upward and aft over the vertical stabilizer. They illuminate
      // paint only; there is no extra visible bulb sprite.
      if (lit && p.wingSpan >= 20 && p.finHeight >= 3) {
        for (const side of [-1, 1]) {
          const base = anchors?.finBase
          const tailZ = base == null ? -p.length * ls * 0.34 : base.z * (modelTransform?.length ?? 1)
          const baseY = base == null ? r * 0.15 : base.y * (modelTransform?.length ?? 1) + (modelTransform == null ? 0 : modelTransform.lift + sink)
          // The housing sits on the fuselage at the fin root, rather than
          // partway up the fin or out on a class-estimated stabilizer.
          const [logoX, logoY, logoZ] = at(side * r * 0.92, baseY - 0.25, tailZ)
          put(logoX, logoY, logoZ, distance, WHITE, 0.035, 0.25)
          const aimX = -side * left.x * 0.75 + up.x * 0.65 - forward.x * 0.22
          const aimY = -side * left.y * 0.75 + up.y * 0.65 - forward.y * 0.22
          const aimZ = -side * left.z * 0.75 + up.z * 0.65 - forward.z * 0.22
          const aimLength = Math.hypot(aimX, aimY, aimZ)
          lightSurface(logoX, logoY, logoZ, distance, WHITE, 24, SURFACE_RANGE.logo,
            [aimX / aimLength, aimY / aimLength, aimZ / aimLength], Math.cos(58 * DEG_RAD))
        }
      }
      const topAt = anchors?.top
      const [bx, by, bz] = topAt != null ? anchorAt({ x: 0, y: topAt.y + 0.15, z: topAt.z }) : at(0, r * 1.02, 0)
      put(bx, by, bz, distance, RED, beacon * 1.6, 1.5)
      if (lit) lightSurface(bx, by, bz, distance, RED, beacon * SURFACE_CD.beacon, SURFACE_RANGE.beacon)
      // Belly beacon and strobes only when close enough to matter.
      if (isDetailed || distance < 20_000) {
        const bottomAt = anchors?.bottom
        const [ux, uy, uz] =
          bottomAt != null ? anchorAt({ x: 0, y: bottomAt.y - 0.15, z: bottomAt.z }) : at(0, -r * 1.02, -r)
        const belly = (t + 0.5) % 1 < 0.12 ? 1 : 0
        put(ux, uy, uz, distance, RED, belly * 1.6, 1.5)
        if (lit) lightSurface(ux, uy, uz, distance, RED, belly * SURFACE_CD.beacon, SURFACE_RANGE.beacon)
      }
      put(lx, ly, lz, distance, STROBE, strobe, 1.8)
      put(rx, ry, rz, distance, STROBE, strobe, 1.8)

      if (landingLights) {
        const agl = aircraft.groundHeight == null ? Infinity : pose.height - aircraft.groundHeight
        const landing = pose.onGround ? pose.speed > TAKEOFF_ROLL_SPEED : agl < LANDING_LIGHTS_AGL
        const testTaxi = import.meta.env.DEV && nightLightingTestStore.get().forceAircraftWorkLights &&
          aircraft.hex === (cameraModeStore.get().targetHex ?? selectionStore.get().selectedHex)
        const taxi = pose.onGround && (pose.speed > TAXI_SPEED || testTaxi)
        if (landing || taxi) {
          // How directly the lights point at the camera (forward · toward camera).
          const facing = Math.max(0, -(forward.x * dx + forward.y * dy + forward.z * dz) / Math.max(distance, 1e-3))
          const lobe = SIDE_GLOW + (1 - SIDE_GLOW) * facing ** FACING_POWER
          const root = anchors?.wingRoot
          const rootZ = root == null ? (p.wingRootZ + p.wingRootChord * 0.45) * ls : root.z * (modelTransform?.length ?? 1)
          const rootY = root == null ? p.wingMount * r * 0.85 : root.y * (modelTransform?.length ?? 1) + (modelTransform == null ? 0 : modelTransform.lift + sink)
          const rootX = root == null ? r * 1.12 : root.x * (modelTransform?.span ?? 1)
          if (landing || taxi) {
            const [ax, ay, az] = at(rootX, rootY, rootZ)
            const [bx2, by2, bz2] = at(-rootX, rootY, rootZ)
            put(ax, ay, az, distance, LANDING, lobe * (landing ? 0.75 : 0.35), 1.2)
            put(bx2, by2, bz2, distance, LANDING, lobe * (landing ? 0.75 : 0.35), 1.2)
          }
          // Fuselage-mounted wing/engine inspection lights illuminate the
          // aircraft rather than projecting a landing beam from the engines.
          // Positions are class-based fallbacks; the feed has no switch data.
          const inspectionHex = cameraModeStore.get().mode === 'globe' ? selectionStore.get().selectedHex : cameraModeStore.get().targetHex
          if (lit && aircraft.hex !== inspectionHex && p.engines.stations.some(s => s > 0) && !p.engines.rearMounted) {
            for (const side of [-1, 1]) {
              const [sx, sy, sz] = at(side * rootX, rootY, rootZ + 0.15)
              const station = p.engines.stations.find(s => s > 0)!
              // Aim across the inboard intake rim, slightly ahead of the
              // nacelle: the fixture shines forward/outward, not rearward
              // across the entire top of the wing.
              const [ex, ey, ez] = at(side * (station * aircraft.scale.span - p.engines.radius * ls * 0.65),
                rootY - p.engines.radius * ls * 0.65, rootZ + p.engines.length * ls * 0.8)
              const vx = ex - sx
              const vy = ey - sy
              const vz = ez - sz
              const length = Math.hypot(vx, vy, vz) || 1
              lightSurface(sx, sy, sz, distance, WHITE, 30, 14 * ls,
                [vx / length, vy / length, vz / length], Math.cos(38 * DEG_RAD))
            }
          }
          // Instanced glTF aircraft use the same transformed nose-gear
          // anchor as their geometry. The belly-resting placeholder needs
          // a positive lens clearance; its old -1.35*r offset went BELOW
          // the ground after its body was lowered onto the pavement.
          const [nx, ny, nz] = anchors?.noseLight != null ? anchorAt(anchors.noseLight) :
            at(0, isDetailed ? -r * 1.35 : -r + 0.5, (p.length / 2) * ls * 0.8)
          put(nx, ny, nz, distance, TAXI, lobe * (landing ? 1 : 0.8), 1.8)
          if (distance < BEAM_MAX_DISTANCE && (pose.onGround || agl < BEAM_MAX_AGL)) {
            const beam = landing ? BEAM.landing : BEAM.taxi
            // Aimed below the horizon in the direction of travel, whatever the pitch.
            const plen = pose.position.length()
            const ux = pose.position.x / plen
            const uy = pose.position.y / plen
            const uz = pose.position.z / plen
            const fu = forward.x * ux + forward.y * uy + forward.z * uz
            let hx = forward.x - ux * fu
            let hy = forward.y - uy * fu
            let hz = forward.z - uz * fu
            const hl = Math.hypot(hx, hy, hz) || 1
            hx /= hl
            hy /= hl
            hz /= hl
            const aim = beam.aim
            const ca = Math.cos(aim * DEG_RAD)
            const sa = Math.sin(aim * DEG_RAD)
            // Separate origins for paired wing-root landing lights; taxi
            // and turnoff beams come from the nose-gear area.
            const count = landing ? 2 : 5
            for (let i = 0; i < count; ++i) {
              const rootBeam = landing || i < 2
              const yaw = (landing ? (i === 0 ? 6 : -6) : i < 2 ? (i === 0 ? 36 : -36) : i === 2 ? 0 : i === 3 ? -28 : 28) * DEG_RAD
              const cy = Math.cos(yaw)
              const sy = Math.sin(yaw)
              const tx = hx * cy + (uy * hz - uz * hy) * sy
              const ty = hy * cy + (uz * hx - ux * hz) * sy
              const tz = hz * cy + (ux * hy - uy * hx) * sy
              const c = (beamPool[beamCount++] ??= { owner: '', x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, intensity: 0, cos: 0, distance: 0 })
              c.owner = aircraft.hex
              const source = rootBeam ? at((i === 0 ? 1 : -1) * rootX, rootY, rootZ) : [nx, ny, nz]
              c.x = source[0]!
              c.y = source[1]!
              c.z = source[2]!
              c.dx = tx * ca - ux * sa
              c.dy = ty * ca - uy * sa
              c.dz = tz * ca - uz * sa
              c.intensity = beam.intensity * pose.opacity * (landing ? 0.5 : i === 2 ? 1 : 0.35)
              c.cos = beam.cos
              c.distance = distance
            }
          }
        }
      }
      if (lit) {
        lightSurface(lx, ly, lz, distance, STROBE, strobe * SURFACE_CD.strobe, SURFACE_RANGE.strobe)
        lightSurface(rx, ry, rz, distance, STROBE, strobe * SURFACE_CD.strobe, SURFACE_RANGE.strobe)
      }
    }
    this.mesh.count = n

    // The nearest beams light the ground (night lights pass).
    const cameraMode = cameraModeStore.get()
    priorityBeamHex = cameraMode.mode === 'globe' ? selectionStore.get().selectedHex : cameraMode.targetHex
    const beams = beamPool.slice(0, beamCount).sort(byBeamDistance)
    lightBeams.count = Math.min(MAX_LIGHT_BEAMS, beams.length)
    for (let i = 0; i < lightBeams.count; ++i) {
      const b = beams[i]!
      lightBeams.position[i]!.set(b.x, b.y, b.z, b.intensity)
      lightBeams.direction[i]!.set(b.dx, b.dy, b.dz, b.cos)
    }

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
      surfaceLights.direction[i]!.set(s.dx, s.dy, s.dz, s.cone)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor!.needsUpdate = true
  }
}
