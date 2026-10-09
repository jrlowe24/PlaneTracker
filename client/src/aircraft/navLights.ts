import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  type PerspectiveCamera
} from 'three'

import { flightConnection } from '../data/flightConnection'
import { nightState } from '../scene/nightLighting'
import { AIRFRAMES } from './airframes'
import { detailedHexes } from './detailState'
import { AIRCRAFT_LAYER } from './layers'

/**
 * Aircraft navigation lights: red left wingtip, green right wingtip, white
 * tail, red anti-collision beacons (top and bottom, ~1 Hz) and white
 * wingtip strobes (double flash, airborne only). Small emissive octahedra
 * kept at least ~1.5 px across, so aircraft read as moving lights at night
 * instead of glowing silhouettes; masked out of post lighting like the
 * aircraft (aerial perspective still dims distant lights).
 */

const LIGHTS_PER_AIRCRAFT = 7
/** Physical light radius, meters. */
const LIGHT_RADIUS = 0.3
/** Minimum on-screen radius, pixels. */
const MIN_PIXELS = 1.6
/** Lights further than this aren't drawn (icons/markers take over). */
const MAX_DISTANCE = 120_000

// Radiance (renderer units, before exposure).
const RED: [number, number, number] = [0.09, 0.004, 0.003]
const GREEN: [number, number, number] = [0.004, 0.08, 0.03]
const WHITE: [number, number, number] = [0.06, 0.06, 0.06]
const STROBE: [number, number, number] = [0.35, 0.35, 0.38]

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

  update(camera: PerspectiveCamera, viewportHeight: number, time: number): void {
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
    // Lights matter at dusk and night; by day they're nearly invisible.
    const visibility = 0.15 + 0.85 * nightState.night

    let n = 0
    const put = (
      x: number,
      y: number,
      z: number,
      distance: number,
      color: readonly [number, number, number],
      intensity: number
    ): void => {
      if (intensity <= 0) return
      const s = Math.max(LIGHT_RADIUS, MIN_PIXELS * distance * pixelToWorld)
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
    }

    for (const aircraft of list) {
      const pose = aircraft.pose
      if (pose == null || pose.opacity <= 0) continue
      const dx = pose.position.x - origin.x
      const dy = pose.position.y - origin.y
      const dz = pose.position.z - origin.z
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (distance > MAX_DISTANCE) continue
      // The camera sits inside the followed aircraft in window view; its own
      // wingtip light is still visible, which is right.
      const p = AIRFRAMES[aircraft.cls]
      const ls = aircraft.scale.length
      const halfSpan = (p.wingSpan > 0 ? p.wingSpan / 2 : p.fuselageRadius * 1.2) * aircraft.scale.span
      const sweep = Math.tan((p.wingSweep * Math.PI) / 180) * Math.max(0, halfSpan - p.fuselageRadius * ls)
      const wingY = p.wingMount * p.fuselageRadius * 0.85 * ls + Math.tan((p.wingDihedral * Math.PI) / 180) * halfSpan
      const tipZ = p.wingRootZ * ls - sweep - p.wingTipChord * ls * 0.5
      const r = p.fuselageRadius * ls
      const { left, up, forward } = pose
      const at = (bx: number, by: number, bz: number): [number, number, number] => [
        dx + left.x * bx + up.x * by + forward.x * bz,
        dy + left.y * bx + up.y * by + forward.y * bz,
        dz + left.z * bx + up.z * by + forward.z * bz
      ]
      const phase = phaseOf(aircraft.hex)
      const t = time + phase * 3
      // Beacon: ~1 Hz short flash; strobes: double flash every 1.3 s.
      const beacon = t % 1 < 0.12 ? 1 : 0
      const strobeT = t % 1.3
      const strobe = !pose.onGround && (strobeT < 0.05 || (strobeT > 0.15 && strobeT < 0.2)) ? 1 : 0
      const isDetailed = detailedHexes.has(aircraft.hex)

      const [lx, ly, lz] = at(halfSpan, wingY, tipZ)
      put(lx, ly, lz, distance, RED, 1)
      const [rx, ry, rz] = at(-halfSpan, wingY, tipZ)
      put(rx, ry, rz, distance, GREEN, 1)
      const [tx, ty, tz] = at(0, r * 0.3, (-p.length / 2) * ls)
      put(tx, ty, tz, distance, WHITE, 1)
      const [bx, by, bz] = at(0, r * 1.02, 0)
      put(bx, by, bz, distance, RED, beacon * 1.6)
      // Belly beacon and strobes only when close enough to matter.
      if (isDetailed || distance < 20_000) {
        const [ux, uy, uz] = at(0, -r * 1.02, -r)
        put(ux, uy, uz, distance, RED, ((t + 0.5) % 1 < 0.12 ? 1 : 0) * 1.6)
      }
      put(lx, ly, lz, distance, STROBE, strobe)
      put(rx, ry, rz, distance, STROBE, strobe)
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor!.needsUpdate = true
  }
}
