import { angleDifference, DEG, WGS84_A, WGS84_E2 } from '@windowseat/shared'
import { Vector3 } from 'three'

import type { TrackedAircraft } from '../data/aircraftRegistry'
import { AIRFRAMES } from './airframes'
import { glidePath } from './approach'
import {
  bankAngle,
  defaultMotionOptions,
  evaluateMotion,
  metersPerRadian,
  pitchAngle,
  smoothingFactor,
  trackOf,
  type KinematicState
} from './motion'

/** World pose of an aircraft (ECEF) plus the geodetic values it came from. */
export interface Pose {
  position: Vector3
  /** Body axes in ECEF (model +X left, +Y up, +Z forward), attitude applied. */
  left: Vector3
  up: Vector3
  forward: Vector3
  lat: number
  lon: number
  /** Meters above the WGS84 ellipsoid. */
  height: number
  /** Degrees clockwise from true north. */
  heading: number
  pitch: number
  bank: number
  /** Ground speed, m/s. */
  speed: number
  onGround: boolean
  /** 1 = fully visible; fades to 0 once data is stale. */
  opacity: number
}

export function createPose(): Pose {
  return {
    position: new Vector3(),
    left: new Vector3(),
    up: new Vector3(),
    forward: new Vector3(),
    lat: 0,
    lon: 0,
    height: 0,
    heading: 0,
    pitch: 0,
    bank: 0,
    speed: 0,
    onGround: false,
    opacity: 1
  }
}

/**
 * Stale aircraft hold position (extrapolation stops at its limit) and only
 * fade out this long after their newest sample; the server drops aircraft
 * unseen for 60 s anyway. Fading earlier made planes blink out during
 * ordinary gaps in polled data.
 */
const FADE_AFTER_SECONDS = 45
const FADE_SECONDS = 10
/**
 * Overview aircraft (worldwide snapshot every few minutes) dead-reckon
 * along their track until the next snapshot, and don't fade in between.
 */
const OVERVIEW_FADE_AFTER_SECONDS = 25 * 60
const OVERVIEW_MOTION = { ...defaultMotionOptions, maxExtrapolation: 20 * 60 }
/** Time constant over which a data correction is blended in. */
const ERROR_TIME_CONSTANT = 1.2
/** Corrections smaller than this (m) beyond the predicted motion are ignored. */
const ERROR_THRESHOLD = 0.5
/** Larger jumps (replay loop, bad data) snap instead of blending. */
const ERROR_SNAP = 3000
const HEADING_TIME_CONSTANT = 0.6
const BANK_TIME_CONSTANT = 1.6
const PITCH_TIME_CONSTANT = 1.2
/** On the ground, slower than this (m/s) the heading holds: position noise isn't a turn. */
const GROUND_HOLD_SPEED = 2.5
/** Below this speed, moving against the heading is a pushback, not a U-turn. */
const PUSHBACK_SPEED = 4
/** Tightest taxi turn radius, meters: caps the ground turn rate at speed / radius. */
const MIN_TURN_RADIUS = 18
const MAX_GROUND_TURN_RATE = 25
/** Turn rate is measured over this look-ahead along the trajectory. */
const TURN_RATE_WINDOW_MS = 2000

const kinematic: KinematicState = {
  lat: 0,
  lon: 0,
  height: 0,
  vn: 0,
  ve: 0,
  vu: 0,
  onGround: false,
  extrapolation: 0
}
const ahead: KinematicState = { ...kinematic }

/**
 * Pose at `renderTime` (epoch ms, already behind real time by the
 * interpolation delay). `dt` is the frame time in seconds for attitude
 * smoothing. When `detailed` is false (distant icons) bank and pitch are
 * skipped and only heading is smoothed.
 */
export function computePose(
  aircraft: TrackedAircraft,
  renderTime: number,
  dt: number,
  detailed: boolean,
  out: Pose
): Pose {
  const overview = aircraft.state.overview === true
  const k = evaluateMotion(aircraft.motion, renderTime, kinematic, overview ? OVERVIEW_MOTION : undefined)
  const attitude = aircraft.attitude
  if (k == null) {
    out.opacity = 0
    return out
  }
  const speed = Math.hypot(k.vn, k.ve)
  const track = trackOf(k.vn, k.ve)
  const first = !attitude.initialized
  attitude.initialized = true
  const clearance = AIRFRAMES[aircraft.cls].groundClearance * aircraft.scale.length

  // On final: follow the runway's glide path down to the surface instead of
  // coarse reported heights (see approach.ts).
  if (!k.onGround && detailed && track != null) {
    const path = glidePath(k.lat, k.lon, track, k.height - clearance, k.vu, speed, aircraft.groundHeight)
    const weight = path?.weight ?? 0
    if (path != null) {
      k.height += (path.height + clearance - k.height) * weight
      k.vu += (path.verticalSpeed - k.vu) * weight
    }
    attitude.glide = weight
  }

  let targetBank = 0
  let targetPitch = 0
  if (detailed && track != null && !k.onGround) {
    const next = evaluateMotion(aircraft.motion, renderTime + TURN_RATE_WINDOW_MS, ahead)
    const nextTrack = next == null ? null : trackOf(next.vn, next.ve)
    if (nextTrack != null) {
      const turnRate = angleDifference(track, nextTrack) / (TURN_RATE_WINDOW_MS / 1000)
      targetBank = bankAngle(speed, turnRate)
    }
    targetPitch = pitchAngle(speed, k.vu, false)
  }

  if (first) {
    attitude.heading = track ?? aircraft.state.track ?? 0
    attitude.bank = targetBank
    attitude.pitch = targetPitch
  } else {
    if (track != null) {
      let turn = angleDifference(attitude.heading, track) * smoothingFactor(dt, HEADING_TIME_CONSTANT)
      if (k.onGround) {
        // Slow or reversing (pushback) ground traffic keeps its heading:
        // its positions jitter in every direction. Taxiing, it turns no
        // tighter than an aircraft can.
        const reversing = speed < PUSHBACK_SPEED && Math.abs(angleDifference(attitude.heading, track)) > 120
        if (speed < GROUND_HOLD_SPEED || reversing) {
          turn = 0
        } else {
          const maxTurn = Math.min(MAX_GROUND_TURN_RATE, speed / MIN_TURN_RADIUS / DEG) * dt
          turn = Math.max(-maxTurn, Math.min(maxTurn, turn))
        }
      }
      attitude.heading = (attitude.heading + turn + 360) % 360
    }
    attitude.bank += (targetBank - attitude.bank) * smoothingFactor(dt, BANK_TIME_CONSTANT)
    attitude.pitch += (targetPitch - attitude.pitch) * smoothingFactor(dt, PITCH_TIME_CONSTANT)
  }

  // Parked/slow ground traffic reports positions rarely but is still there
  // (the server drops it when unseen); hold it. Airborne aircraft with stale
  // positions fade out instead of freezing in mid-air.
  const holding = k.onGround && speed < 3
  const overdue = k.extrapolation - (overview ? OVERVIEW_FADE_AFTER_SECONDS : FADE_AFTER_SECONDS)
  out.opacity = holding || overdue <= 0 ? 1 : Math.max(0, 1 - overdue / FADE_SECONDS)
  out.speed = speed
  out.onGround = k.onGround
  // Ground heights are the surface; lift the fuselage axis onto its gear,
  // blended over a second so touchdown and lift-off don't jump.
  const groundTarget = k.onGround ? 1 : 0
  attitude.ground = first
    ? groundTarget
    : attitude.ground + (groundTarget - attitude.ground) * smoothingFactor(dt, 0.8)
  // Touching down off a glide path: the wheels are already on the surface.
  if (k.onGround) {
    if (attitude.glide > 0.5) attitude.ground = 1
    attitude.glide = 0
  }
  let height = k.height + clearance * attitude.ground
  // Never below the terrain (late data on short final, baro errors).
  if (aircraft.groundHeight != null) {
    height = Math.max(height, aircraft.groundHeight + clearance)
  }

  // Netcode-style error smoothing: if this frame's position departs from
  // where the last rendered position was heading, absorb the jump into an
  // offset that decays, instead of snapping.
  let lat = k.lat
  let lon = k.lon
  if (!first) {
    const m = metersPerRadian(k.lat)
    const decay = 1 - smoothingFactor(dt, ERROR_TIME_CONSTANT)
    // Raw position relative to the last rendered one, in meters.
    const dn = (k.lat - attitude.lastLat) * DEG * m.north
    const de = (((k.lon - attitude.lastLon + 540) % 360) - 180) * DEG * m.east
    const du = height - attitude.lastHeight
    // Where the last rendered position would be now at this velocity.
    const pn = k.vn * dt
    const pe = k.ve * dt
    const pu = k.onGround ? 0 : k.vu * dt
    const jn = attitude.errorN * decay + dn - pn
    const je = attitude.errorE * decay + de - pe
    const ju = attitude.errorU * decay + du - pu
    const jump = Math.hypot(jn, je, ju)
    if (jump > ERROR_SNAP) {
      attitude.errorN = attitude.errorE = attitude.errorU = 0
    } else if (jump > ERROR_THRESHOLD) {
      // Rendered = raw + error = last + predicted motion.
      attitude.errorN = pn - dn
      attitude.errorE = pe - de
      attitude.errorU = pu - du
    } else {
      attitude.errorN *= decay
      attitude.errorE *= decay
      attitude.errorU *= decay
    }
    lat += attitude.errorN / m.north / DEG
    lon += attitude.errorE / m.east / DEG
    // On the ground the height comes from the terrain, not noisy reports:
    // no vertical smoothing (it let parked aircraft drift off the surface
    // when the ground height was re-measured).
    if (k.onGround) attitude.errorU = 0
    height += attitude.errorU
    if (aircraft.groundHeight != null) {
      height = Math.max(height, aircraft.groundHeight + clearance)
    }
  }
  attitude.lastLat = lat
  attitude.lastLon = lon
  attitude.lastHeight = height
  writePose(lat, lon, height, attitude.heading, attitude.pitch, attitude.bank, out)
  return out
}

/**
 * Fills position and body axes for a geodetic position and attitude
 * (heading from north, pitch nose-up, bank right-wing-down; degrees).
 */
export function writePose(
  latDeg: number,
  lonDeg: number,
  height: number,
  heading: number,
  pitch: number,
  bank: number,
  out: Pose
): Pose {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const sinLon = Math.sin(lon)
  const cosLon = Math.cos(lon)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  out.position.set(
    (n + height) * cosLat * cosLon,
    (n + height) * cosLat * sinLon,
    (n * (1 - WGS84_E2) + height) * sinLat
  )
  // ENU basis.
  const ex = -sinLon
  const ey = cosLon
  const nx = -sinLat * cosLon
  const ny = -sinLat * sinLon
  const nz = cosLat
  const ux = cosLat * cosLon
  const uy = cosLat * sinLon
  const uz = sinLat
  // Level heading frame: forward = cos(h)·north + sin(h)·east; left = up × forward.
  const h = heading * DEG
  const ch = Math.cos(h)
  const sh = Math.sin(h)
  let fx = ch * nx + sh * ex
  let fy = ch * ny + sh * ey
  let fz = ch * nz
  let lx = uy * fz - uz * fy
  let ly = uz * fx - ux * fz
  let lz = ux * fy - uy * fx
  let upx = ux
  let upy = uy
  let upz = uz
  if (pitch !== 0) {
    // Nose up: rotate forward toward up about the left axis.
    const cp = Math.cos(pitch * DEG)
    const sp = Math.sin(pitch * DEG)
    const nfx = fx * cp + upx * sp
    const nfy = fy * cp + upy * sp
    const nfz = fz * cp + upz * sp
    upx = upx * cp - fx * sp
    upy = upy * cp - fy * sp
    upz = upz * cp - fz * sp
    fx = nfx
    fy = nfy
    fz = nfz
  }
  if (bank !== 0) {
    // Right wing down: rotate left toward up about the forward axis.
    const cb = Math.cos(bank * DEG)
    const sb = Math.sin(bank * DEG)
    const nlx = lx * cb + upx * sb
    const nly = ly * cb + upy * sb
    const nlz = lz * cb + upz * sb
    upx = upx * cb - lx * sb
    upy = upy * cb - ly * sb
    upz = upz * cb - lz * sb
    lx = nlx
    ly = nly
    lz = nlz
  }
  out.forward.set(fx, fy, fz)
  out.left.set(lx, ly, lz)
  out.up.set(upx, upy, upz)
  out.lat = latDeg
  out.lon = lonDeg
  out.height = height
  out.heading = heading
  out.pitch = pitch
  out.bank = bank
  return out
}
