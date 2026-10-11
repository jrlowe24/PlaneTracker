import { decodeAircraft, type AircraftMessage, type AircraftState } from '@windowseat/shared'

import { stateEllipsoidHeight, toSample, type MotionSample } from '../aircraft/motion'
import type { AircraftClass } from '../aircraft/airframes'
import { aircraftCategory, type AircraftCategory } from '../aircraft/categories'
import type { Pose } from '../aircraft/pose'
import { aircraftClass } from '../aircraft/typeClasses'
import { airframeScale, type AirframeScale } from '../aircraft/typeDimensions'

/** Smoothed attitude state, owned by the render loop. */
export interface Attitude {
  /** Degrees from true north. */
  heading: number
  /** Degrees, positive = right wing down. */
  bank: number
  /** Degrees, positive = nose up. */
  pitch: number
  /** 0 airborne … 1 on the ground (smoothed). */
  ground: number
  /** How much the last airborne pose followed a runway's glide path (0 … 1). */
  glide: number
  /**
   * Visual error offset (meters north/east/up) that absorbs jumps when new
   * data contradicts the extrapolated path, decaying back to zero.
   */
  errorN: number
  errorE: number
  errorU: number
  /** Last rendered position (before attitude), for jump detection. */
  lastLat: number
  lastLon: number
  lastHeight: number
  /** Current (eased) interpolation delay for this aircraft, ms. */
  delayMs: number
  initialized: boolean
}

export interface TrackedAircraft {
  hex: string
  /** Latest state from the server. */
  state: AircraftState
  /** Airframe class from type code / emitter category. */
  cls: AircraftClass
  /** Kind of flight (map marker color). */
  category: AircraftCategory
  /** performance.now() when first seen (markers fade in). */
  firstSeen: number
  /** Scale from the class placeholder to the real type's dimensions. */
  scale: AirframeScale
  /** Kinematic samples (SI, ellipsoid heights), oldest first. */
  motion: MotionSample[]
  /** Smoothed geometric − barometric altitude difference, feet. */
  baroOffsetFt: number | null
  /** Ellipsoid height of the ground under this aircraft (tile raycast). */
  groundHeight: number | null
  attitude: Attitude
  /** Pose for the current frame (computed once per frame by the render loop). */
  pose: Pose | null
  /** Distance from the camera last frame, meters. */
  cameraDistance: number
  /** Client wall time of the last update. */
  receivedAt: number
  /** Dense slot in `AircraftRegistry.list`; also the instance index. */
  index: number
  /** Kept across a reconnect but not yet confirmed by the new session. */
  unconfirmed: boolean
}

/** After a reconnect, aircraft the new session hasn't sent within this time are dropped. */
const RECONNECT_GRACE_MS = 15_000

const MAX_SAMPLES = 16

/**
 * All aircraft the client knows about. Mutable and outside React: the render
 * loop reads it every frame. `list` is dense (swap-remove) so the instance
 * index of an aircraft is its position in the list.
 */
export class AircraftRegistry {
  readonly byHex = new Map<string, TrackedAircraft>()
  readonly list: TrackedAircraft[] = []
  /** Increments on every change. */
  version = 0

  apply(message: AircraftMessage, now: number): void {
    if (message.reset) this.clear()
    this.pruneUnconfirmed(now)
    for (const hex of message.removals) {
      this.remove(hex)
    }
    for (const tuple of message.upserts) {
      this.upsert(decodeAircraft(tuple), now)
    }
    ++this.version
  }

  upsert(state: AircraftState, now: number): TrackedAircraft {
    let tracked = this.byHex.get(state.hex)
    if (tracked == null) {
      tracked = {
        hex: state.hex,
        state,
        cls: aircraftClass(state.typeCode, state.category),
        category: aircraftCategory(state, aircraftClass(state.typeCode, state.category)),
        firstSeen: performance.now(),
        scale: airframeScale(state.typeCode, aircraftClass(state.typeCode, state.category)),
        motion: [],
        baroOffsetFt: null,
        groundHeight: null,
        attitude: {
          heading: state.track ?? 0,
          bank: 0,
          pitch: 0,
          ground: 0,
          glide: 0,
          errorN: 0,
          errorE: 0,
          errorU: 0,
          lastLat: 0,
          lastLon: 0,
          lastHeight: 0,
          delayMs: -1,
          initialized: false
        },
        pose: null,
        cameraDistance: Infinity,
        receivedAt: now,
        index: this.list.length,
        unconfirmed: false
      }
      this.byHex.set(state.hex, tracked)
      this.list.push(tracked)
    }
    if (state.altGeom != null && state.altBaro != null) {
      const offset = state.altGeom - state.altBaro
      tracked.baroOffsetFt =
        tracked.baroOffsetFt == null ? offset : tracked.baroOffsetFt * 0.8 + offset * 0.2
    }
    const last = tracked.motion.at(-1)
    if (last == null || state.positionTimestamp > last.t) {
      const height = stateEllipsoidHeight(state, {
        baroOffsetFt: tracked.baroOffsetFt,
        groundHeight: () => tracked.groundHeight
      })
      tracked.motion.push(toSample(state, height))
      if (tracked.motion.length > MAX_SAMPLES) tracked.motion.shift()
    }
    if (state.typeCode !== tracked.state.typeCode || state.category !== tracked.state.category) {
      tracked.cls = aircraftClass(state.typeCode, state.category)
      tracked.scale = airframeScale(state.typeCode, tracked.cls)
    }
    if (
      state.typeCode !== tracked.state.typeCode ||
      state.category !== tracked.state.category ||
      state.callsign !== tracked.state.callsign
    ) {
      tracked.category = aircraftCategory(state, tracked.cls)
    }
    tracked.state = state
    tracked.receivedAt = now
    tracked.unconfirmed = false
    return tracked
  }

  /**
   * A new server session started (reconnect, server restart). Keep drawing
   * what we have instead of blanking the sky; whatever the new session
   * doesn't send again within a grace period is dropped.
   */
  markAllUnconfirmed(now: number): void {
    for (const aircraft of this.list) aircraft.unconfirmed = true
    this.unconfirmedSince = now
  }

  /** Drops aircraft not confirmed after a reconnect's grace period. */
  pruneUnconfirmed(now: number): void {
    if (this.unconfirmedSince == null || now - this.unconfirmedSince < RECONNECT_GRACE_MS) return
    this.unconfirmedSince = null
    for (const aircraft of [...this.list]) {
      if (aircraft.unconfirmed) this.remove(aircraft.hex)
    }
    ++this.version
  }

  private unconfirmedSince: number | null = null

  /** Records a tile-raycast ground height and applies it to on-ground samples. */
  setGroundHeight(hex: string, height: number): void {
    const tracked = this.byHex.get(hex)
    if (tracked == null) return
    tracked.groundHeight = height
    for (const sample of tracked.motion) {
      if (sample.onGround) sample.height = height
    }
  }

  remove(hex: string): void {
    const tracked = this.byHex.get(hex)
    if (tracked == null) return
    this.byHex.delete(hex)
    const last = this.list.pop()!
    if (last !== tracked) {
      last.index = tracked.index
      this.list[tracked.index] = last
    }
  }

  clear(): void {
    this.byHex.clear()
    this.list.length = 0
    ++this.version
  }
}
