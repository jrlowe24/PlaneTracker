import { ecefToGeodetic } from '@windowseat/shared'
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector3,
  type Camera,
  type PerspectiveCamera,
  type WebGLRenderer
} from 'three'

import { cloudTransmittance } from '../clouds/cloudDepth'
import type { AircraftRegistry, TrackedAircraft } from '../data/aircraftRegistry'
import { AIRFRAMES, type AircraftClass } from './airframes'

/**
 * Contrails: condensation trails behind jets at cruise altitude. Each
 * engine leaves a strand that starts a short gap behind it, widens, sinks
 * a little and fades over CONTRAIL_LIFE seconds (~10 km at cruise speed).
 *
 * Drawn over the finished frame (like the map arrows), in display colors:
 * white in daylight, warm near sunset, faint at night, hidden by cloud
 * between the camera and the aircraft.
 */

/** Contrails form above this height (m, ~26,000 ft), fully by FULL_ABOVE. */
const FORM_ABOVE = 3000 // TEMP 7600
const FULL_ABOVE = 4000 // TEMP 8600
/** Seconds a contrail stays visible. */
const CONTRAIL_LIFE = 40
/** Seconds between recorded points. */
const SAMPLE_INTERVAL = 0.4
const MAX_SAMPLES = Math.ceil(CONTRAIL_LIFE / SAMPLE_INTERVAL) + 2
/** Clear gap behind the engines before the trail condenses (s). */
const GAP_S = 0.6
/** Strand width (m) at the start and at the end of its life. */
const WIDTH_START = 4
const WIDTH_END = 140
/** Sinking with the wake vortices (m/s). */
const SINK = 2
/** Most aircraft with contrails at once (nearest first), and how far. */
const MAX_AIRCRAFT = 48
const MAX_DISTANCE = 160_000
const JETS: ReadonlySet<AircraftClass> = new Set(['narrowbody', 'widebody', 'regional', 'bizjet'])

interface Sample {
  /** Centerline position (ECEF, m) and the left wing direction. */
  x: number
  y: number
  z: number
  lx: number
  ly: number
  lz: number
  /** Up (unit) at the sample, for sinking. */
  ux: number
  uy: number
  uz: number
  time: number
  /** 0 … 1: how much this point condenses (altitude). */
  strength: number
}

class Trail {
  samples: Sample[] = []
  lastTime = -Infinity
  /** Engine offsets from the centerline (m). */
  stations: number[] = []
}

const VERTEX = /* glsl */ `
attribute vec2 data;
varying vec2 vData;
void main() {
  vData = data;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT = /* glsl */ `
uniform vec3 color;
varying vec2 vData;
void main() {
  // Soft round profile across the strand.
  float across = vData.x;
  float alpha = vData.y * exp(-3.0 * across * across);
  gl_FragColor = vec4(color, alpha);
}
`

const camRel = new Vector3()
const p0 = new Vector3()
const p1 = new Vector3()
const along = new Vector3()
const view = new Vector3()
const side = new Vector3()
const point = new Vector3()

export class Contrails {
  readonly scene = new Scene()
  private readonly material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { color: { value: new Vector3(1, 1, 1) } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Strips face the camera either way round.
    side: DoubleSide
  })
  private readonly geometry = new BufferGeometry()
  private readonly mesh = new Mesh(this.geometry, this.material)
  private readonly trails = new Map<string, Trail>()
  private positions = new Float32Array(0)
  private data = new Float32Array(0)
  private capacity = 0
  private quads = 0
  private time = 0

  constructor() {
    this.mesh.frustumCulled = false
    this.mesh.name = 'contrails'
    this.scene.add(this.mesh)
    this.allocate(4096)
  }

  private allocate(capacity: number): void {
    const positions = new Float32Array(capacity * 4 * 3)
    const data = new Float32Array(capacity * 4 * 2)
    positions.set(this.positions.subarray(0, Math.min(this.positions.length, positions.length)))
    data.set(this.data.subarray(0, Math.min(this.data.length, data.length)))
    this.positions = positions
    this.data = data
    this.capacity = capacity
    const index = new Uint32Array(capacity * 6)
    for (let i = 0; i < capacity; ++i) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6)
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('data', new BufferAttribute(this.data, 2))
    this.geometry.setIndex(new BufferAttribute(index, 1))
  }

  /** Records contrail points for jets at altitude (after poses were computed). */
  record(registry: AircraftRegistry, dt: number): void {
    this.time += dt
    for (const aircraft of registry.list) {
      const pose = aircraft.pose
      const forms = pose != null && !pose.onGround && pose.opacity > 0 && JETS.has(aircraft.cls) && pose.height > FORM_ABOVE
      let trail = this.trails.get(aircraft.hex)
      if (!forms) {
        if (trail != null && this.time - trail.lastTime > CONTRAIL_LIFE) this.trails.delete(aircraft.hex)
        continue
      }
      if (trail == null) {
        trail = new Trail()
        this.trails.set(aircraft.hex, trail)
      }
      if (this.time - trail.lastTime < SAMPLE_INTERVAL) continue
      trail.lastTime = this.time
      trail.stations = engineStations(aircraft)
      const t = Math.min(1, (pose.height - FORM_ABOVE) / (FULL_ABOVE - FORM_ABOVE))
      trail.samples.push({
        x: pose.position.x,
        y: pose.position.y,
        z: pose.position.z,
        lx: pose.left.x,
        ly: pose.left.y,
        lz: pose.left.z,
        ux: pose.up.x,
        uy: pose.up.y,
        uz: pose.up.z,
        time: this.time,
        strength: t * t * (3 - 2 * t)
      })
      if (trail.samples.length > MAX_SAMPLES) trail.samples.shift()
    }
    for (const [hex, trail] of this.trails) {
      if (!registry.byHex.has(hex) || this.time - trail.lastTime > CONTRAIL_LIFE) this.trails.delete(hex)
    }
  }

  /** Builds the strands for this view; `sunDirection` sets their color. */
  update(registry: AircraftRegistry, camera: PerspectiveCamera, sunDirection: Vector3 | null): void {
    this.quads = 0
    camRel.copy(camera.position)
    const cameraHeight = ecefToGeodetic(camera.position.x, camera.position.y, camera.position.z).height
    const shown = [...this.trails.entries()]
      .map(([hex, trail]) => ({ trail, aircraft: registry.byHex.get(hex), last: trail.samples.at(-1) }))
      .filter(({ last }) => last != null)
      .map(entry => ({ ...entry, distance: point.set(entry.last!.x, entry.last!.y, entry.last!.z).distanceTo(camRel) }))
      .filter(entry => entry.distance < MAX_DISTANCE)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_AIRCRAFT)
    for (const { trail, aircraft, last, distance } of shown) {
      // Hidden by cloud between the camera and the aircraft; fades out far away.
      point.set(last!.x, last!.y, last!.z)
      const height = aircraft?.pose?.height ?? cameraHeight
      const visibility = cloudTransmittance(point, height, cameraHeight) * (1 - smoothstep(MAX_DISTANCE * 0.5, MAX_DISTANCE, distance))
      if (visibility < 0.01) continue
      for (const station of trail.stations) this.strand(trail, station, visibility)
    }
    this.mesh.position.copy(camRel)
    this.geometry.setDrawRange(0, this.quads * 6)
    this.geometry.getAttribute('position').needsUpdate = true
    this.geometry.getAttribute('data').needsUpdate = true
    this.mesh.visible = this.quads > 0
    this.setColor(camera.position, sunDirection)
  }

  private strand(trail: Trail, station: number, visibility: number): void {
    const samples = trail.samples
    for (let i = samples.length - 1; i > 0; --i) {
      const a = samples[i]!
      const b = samples[i - 1]!
      const ageA = this.time - a.time
      const ageB = this.time - b.time
      if (ageB < GAP_S) continue
      if (ageA > CONTRAIL_LIFE) break
      if (this.quads >= this.capacity) this.allocate(this.capacity * 2)
      for (let k = 0; k < 2; ++k) {
        const s = k === 0 ? a : b
        const age = Math.max(0, this.time - s.time)
        const sink = SINK * age
        const target = k === 0 ? p0 : p1
        target.set(
          s.x + s.lx * station - s.ux * sink - camRel.x,
          s.y + s.ly * station - s.uy * sink - camRel.y,
          s.z + s.lz * station - s.uz * sink - camRel.z
        )
      }
      along.subVectors(p1, p0)
      for (let k = 0; k < 2; ++k) {
        const s = k === 0 ? a : b
        const age = Math.max(0, this.time - s.time)
        const life = age / CONTRAIL_LIFE
        const width = WIDTH_START + (WIDTH_END - WIDTH_START) * Math.sqrt(life)
        // Condenses over the first second behind the gap; fades at the end.
        // Thinner as it spreads.
        const alpha =
          0.8 * s.strength * visibility * smoothstep(GAP_S, GAP_S + 1.5, age) * (1 - smoothstep(0.55, 1, life)) *
          (WIDTH_START / width) ** 0.25
        const pos = k === 0 ? p0 : p1
        view.copy(pos)
        side.crossVectors(along, view)
        const length = side.length()
        if (length < 1e-9) side.set(0, 0, 0)
        else side.multiplyScalar((width * 0.5) / length)
        const v = this.quads * 4 + k * 2
        this.positions[v * 3] = pos.x - side.x
        this.positions[v * 3 + 1] = pos.y - side.y
        this.positions[v * 3 + 2] = pos.z - side.z
        this.positions[v * 3 + 3] = pos.x + side.x
        this.positions[v * 3 + 4] = pos.y + side.y
        this.positions[v * 3 + 5] = pos.z + side.z
        this.data[v * 2] = -1
        this.data[v * 2 + 1] = alpha
        this.data[v * 2 + 2] = 1
        this.data[v * 2 + 3] = alpha
      }
      ++this.quads
    }
  }

  /** Display color: white by day, warm at sunrise and sunset, faint at night. */
  private setColor(cameraPosition: Vector3, sunDirection: Vector3 | null): void {
    const color = this.material.uniforms.color!.value as Vector3
    if (sunDirection == null) {
      color.set(0.9, 0.9, 0.92)
      return
    }
    const elevation = sunDirection.dot(point.copy(cameraPosition).normalize())
    const day = smoothstep(-0.12, 0.02, elevation)
    const warm = day * (1 - smoothstep(0.02, 0.25, elevation))
    color.set(
      0.16 + (0.93 - 0.16) * day,
      0.17 + (0.93 - 0.17) * day - 0.25 * warm,
      0.2 + (0.95 - 0.2) * day - 0.45 * warm
    )
  }

  render(renderer: WebGLRenderer, camera: Camera): void {
    if (this.quads === 0) return
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, camera)
    renderer.autoClear = autoClear
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/** Engine offsets from the centerline (m), left and right. */
function engineStations(aircraft: TrackedAircraft): number[] {
  const airframe = AIRFRAMES[aircraft.cls]
  const station = (airframe.engines.stations[0] ?? 2) * aircraft.scale.span
  return [station, -station]
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
