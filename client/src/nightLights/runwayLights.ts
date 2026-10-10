import { ecefToGeodetic, geodeticToEcef, geoidHeight } from '@windowseat/shared'
import { Raycaster, Vector3, Vector4 } from 'three'

import { peekGoogleTiles } from '../globe/googleTiles'

import type { RunwayRecord } from './roadRaster.worker'

/**
 * Runways for exact runway lighting. The road workers find whole runways
 * (both ends, how they're lit) in their runway index and send them along
 * with each tile; here they're kept, de-duplicated, and the ones nearest
 * the camera handed to the shader (NightLightsPass), which draws every
 * runway light analytically along each runway's axis: exact spacing, rows
 * that line up, approach lights in line with the runway, at any distance.
 */

export const MAX_RUNWAYS = 16

/** Lighting class as the shader encodes it. */
const LIGHTING_CODE = { basic: 0, instrument: 1, precision: 2 } as const

/** Approach lights run out 2,400 ft (~730 m), stopping short of other runways. */
const APPROACH_LENGTH = 720
/** Runways farther than this from the camera are forgotten. */
const KEEP_DISTANCE = 400_000

interface Runway {
  a: Vector3
  b: Vector3
  /** Ends in degrees (lat, lon) for ground sampling. */
  ends: [[number, number], [number, number]]
  lighting: number
  /** Approach light length at each end (m). */
  approach: [number, number]
  /** Ground height (ellipsoid, m) at each end, NaN until sampled. */
  heights: [number, number]
  /** When the heights were last sampled (performance.now()). */
  sampledAt: number
}

/** Unknown threshold height in the shader (approach lights then follow the ground). */
const NO_HEIGHT = -1e6
/** Ground heights are sampled (one raycast per end) for runways this close. */
const SAMPLE_DISTANCE = 40_000
/** Resampled as tiles refine. */
const RESAMPLE_MS = 20_000
const RAY_START = 2000

const raycaster = new Raycaster()
;(raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
const rayOrigin = new Vector3()
const rayDown = new Vector3()

export interface RunwayUniforms {
  count: number
  /** End A relative to the camera; w: length (m). */
  origin: Vector4[]
  /** Unit vector from A to B (horizontal); w: lighting class. */
  along: Vector4[]
  /** Unit vector across, to the left of `along`. */
  across: Vector4[]
  /**
   * x, y: approach light length at A and B (m); z, w: ground height at A
   * and B (ellipsoid, m; NO_HEIGHT when not known).
   */
  approach: Vector4[]
}

const direction = new Vector3()
const up = new Vector3()
const toPoint = new Vector3()
const point = new Vector3()

function distanceToSegment(p: Vector3, a: Vector3, b: Vector3): number {
  direction.subVectors(b, a)
  const lengthSq = direction.lengthSq()
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, toPoint.subVectors(p, a).dot(direction) / lengthSq)) : 0
  return point.copy(a).addScaledVector(direction, t).distanceTo(p)
}

export class RunwayLights {
  private readonly runways: Runway[] = []
  private dirty = false
  readonly uniforms: RunwayUniforms = {
    count: 0,
    origin: Array.from({ length: MAX_RUNWAYS }, () => new Vector4()),
    along: Array.from({ length: MAX_RUNWAYS }, () => new Vector4()),
    across: Array.from({ length: MAX_RUNWAYS }, () => new Vector4()),
    approach: Array.from({ length: MAX_RUNWAYS }, () => new Vector4())
  }

  add(records: readonly RunwayRecord[]): void {
    for (const record of records) {
      if (record.lighting === 'unlit') continue
      const ga = geodeticToEcef(record.a[1], record.a[0], 0)
      const gb = geodeticToEcef(record.b[1], record.b[0], 0)
      const a = new Vector3(ga.x, ga.y, ga.z)
      const b = new Vector3(gb.x, gb.y, gb.z)
      const length = a.distanceTo(b)
      if (length < 100) continue
      // The same runway arrives with every tile around it, sometimes cut
      // shorter at an index tile edge: keep the longest of overlapping,
      // in-line copies.
      const same = this.runways.findIndex(
        r =>
          distanceToSegment(a, r.a, r.b) < 15 &&
          distanceToSegment(b, r.a, r.b) < 15
      )
      if (same >= 0) continue
      const covered = this.runways.findIndex(
        r => distanceToSegment(r.a, a, b) < 15 && distanceToSegment(r.b, a, b) < 15
      )
      const runway: Runway = {
        a,
        b,
        ends: [
          [record.a[1], record.a[0]],
          [record.b[1], record.b[0]]
        ],
        lighting: LIGHTING_CODE[record.lighting],
        approach: [0, 0],
        heights: [Number.NaN, Number.NaN],
        sampledAt: -Infinity
      }
      if (covered >= 0) this.runways[covered] = runway
      else this.runways.push(runway)
      this.dirty = true
    }
  }

  /** Picks the runways nearest the camera and fills the uniforms. */
  update(camera: Vector3): void {
    if (this.dirty) {
      this.dirty = false
      for (let i = this.runways.length - 1; i >= 0; --i) {
        if (distanceToSegment(camera, this.runways[i]!.a, this.runways[i]!.b) > KEEP_DISTANCE) this.runways.splice(i, 1)
      }
      for (const runway of this.runways) runway.approach = this.approaches(runway)
    }
    const nearest = this.runways
      .map(r => ({ r, d: distanceToSegment(camera, r.a, r.b) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, MAX_RUNWAYS)
    // Threshold heights: approach lights stand level with the runway end
    // on poles, not on the ground beyond it. One runway sampled per frame.
    const now = performance.now()
    const sample = nearest.find(({ r, d }) => d < SAMPLE_DISTANCE && now - r.sampledAt > RESAMPLE_MS)
    if (sample != null) this.sampleHeights(sample.r, now)
    const u = this.uniforms
    u.count = nearest.length
    nearest.forEach(({ r }, i) => {
      direction.subVectors(r.b, r.a)
      up.addVectors(r.a, r.b).normalize()
      // Horizontal at the runway's middle.
      direction.addScaledVector(up, -direction.dot(up))
      const length = direction.length()
      direction.divideScalar(length)
      u.origin[i]!.set(r.a.x - camera.x, r.a.y - camera.y, r.a.z - camera.z, length)
      u.along[i]!.set(direction.x, direction.y, direction.z, r.lighting)
      const across = point.crossVectors(up, direction)
      u.across[i]!.set(across.x, across.y, across.z, 0)
      u.approach[i]!.set(
        r.approach[0],
        r.approach[1],
        Number.isFinite(r.heights[0]) ? r.heights[0] : NO_HEIGHT,
        Number.isFinite(r.heights[1]) ? r.heights[1] : NO_HEIGHT
      )
    })
  }

  /** Ground height at both ends of a runway, from the photorealistic tiles. */
  private sampleHeights(runway: Runway, now: number): void {
    runway.sampledAt = now
    const ground = peekGoogleTiles()?.group
    if (ground == null) return
    runway.ends.forEach(([lat, lon], i) => {
      const known = runway.heights[i]!
      const guess = Number.isFinite(known) ? known : geoidHeight(lat, lon)
      const start = geodeticToEcef(lat, lon, guess + RAY_START)
      rayOrigin.set(start.x, start.y, start.z)
      rayDown.copy(rayOrigin).normalize().negate()
      raycaster.set(rayOrigin, rayDown)
      raycaster.far = RAY_START * 3
      const hit = raycaster.intersectObject(ground, true)[0]
      if (hit == null) {
        runway.sampledAt = now - RESAMPLE_MS + 2000 // tiles not there yet: retry soon
        return
      }
      const height = ecefToGeodetic(hit.point.x, hit.point.y, hit.point.z).height
      if (height > geoidHeight(lat, lon) - 450) runway.heights[i] = height
    })
  }

  /** Approach light lengths at both ends: never across another runway. */
  private approaches(runway: Runway): [number, number] {
    if (runway.lighting === LIGHTING_CODE.basic) return [0, 0]
    const out: [number, number] = [APPROACH_LENGTH, APPROACH_LENGTH]
    const ends = [
      [runway.a, runway.b],
      [runway.b, runway.a]
    ] as const
    ends.forEach(([end, other], i) => {
      const outward = new Vector3().subVectors(end, other).normalize()
      for (let d = 30; d <= APPROACH_LENGTH; d += 30) {
        const p = new Vector3().copy(end).addScaledVector(outward, d)
        if (this.runways.some(r => r !== runway && distanceToSegment(p, r.a, r.b) < 35)) {
          out[i] = d - 30
          break
        }
      }
    })
    return out
  }
}
