import { geodeticToEcef } from '@windowseat/shared'
import { Vector3, Vector4 } from 'three'

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
  lighting: number
  /** Approach light length at each end (m). */
  approach: [number, number]
}

export interface RunwayUniforms {
  count: number
  /** End A relative to the camera; w: length (m). */
  origin: Vector4[]
  /** Unit vector from A to B (horizontal); w: lighting class. */
  along: Vector4[]
  /** Unit vector across, to the left of `along`. */
  across: Vector4[]
  /** x, y: approach light length at A and B (m). */
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
      const runway: Runway = { a, b, lighting: LIGHTING_CODE[record.lighting], approach: [0, 0] }
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
      u.approach[i]!.set(r.approach[0], r.approach[1], 0, 0)
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
