import { geoidHeight, greatCircleDistance, type AircraftState } from '@windowseat/shared'
import { describe, expect, it } from 'vitest'

import {
  adaptiveDelayMs,
  bankAngle,
  evaluateMotion,
  hermite,
  metersPerRadian,
  pitchAngle,
  smoothingFactor,
  stateEllipsoidHeight,
  toSample,
  trackOf,
  type KinematicState,
  type MotionSample
} from './motion'
import { computePose, createPose, WHEEL_CONTACT_LIFT, writePose } from './pose'
import { AircraftRegistry } from '../data/aircraftRegistry'
import { AIRFRAMES } from './airframes'
import { GroundNavigation } from './groundNavigation'
import { nightEmission } from '../nightLights/nightLightsStore'
import type { RoadLightTiles } from '../nightLights/roadTiles'

function out(): KinematicState {
  return { lat: 0, lon: 0, height: 0, vn: 0, ve: 0, vu: 0, onGround: false, extrapolation: 0 }
}

/** A sample moving east at `speed` m/s along the equator. */
function eastbound(t: number, lon: number, speed = 200): MotionSample {
  return { t, lat: 0, lon, height: 1000, vn: 0, ve: speed, vu: 0, onGround: false }
}

const metersPerDegreeEquator = metersPerRadian(0).east * (Math.PI / 180)

describe('Hermite interpolation', () => {
  it('does not mark a descent grounded before the surface sample is due', () => {
    const a = { ...eastbound(0, 0, 70), height: 60, vu: -4 }
    const b = { ...eastbound(10_000, 700 / metersPerDegreeEquator, 70), height: 0, onGround: true }
    const k = out()
    hermite(a, b, 6000, k)
    expect(k.height).toBeGreaterThan(0)
    expect(k.onGround).toBe(false)
    hermite(a, b, 10_000, k)
    expect(k.height).toBe(0)
    expect(k.onGround).toBe(true)
  })
  it('passes through samples and reproduces constant velocity exactly', () => {
    const a = eastbound(0, 0)
    const b = eastbound(10_000, (200 * 10) / metersPerDegreeEquator)
    const k = out()
    hermite(a, b, 0, k)
    expect(k.lon).toBeCloseTo(0, 12)
    hermite(a, b, 10_000, k)
    expect(k.lon).toBeCloseTo(b.lon, 10)
    hermite(a, b, 2500, k)
    expect(k.lon * metersPerDegreeEquator).toBeCloseTo(500, 3)
    expect(k.ve).toBeCloseTo(200, 6)
    expect(k.vn).toBeCloseTo(0, 6)
  })

  it('matches endpoint velocities (smooth joins)', () => {
    const a: MotionSample = { t: 0, lat: 47, lon: -122, height: 500, vn: 100, ve: 0, vu: 5, onGround: false }
    const b: MotionSample = { t: 8000, lat: 47.006, lon: -121.99, height: 540, vn: 50, ve: 90, vu: 0, onGround: false }
    const k = out()
    hermite(a, b, 0, k)
    expect(k.vn).toBeCloseTo(100, 6)
    expect(k.vu).toBeCloseTo(5, 6)
    hermite(a, b, 8000, k)
    expect(k.vn).toBeCloseTo(50, 6)
    expect(k.ve).toBeCloseTo(90, 6)
    expect(k.height).toBeCloseTo(540, 6)
  })

  it('handles the antimeridian', () => {
    const d = 0.02
    const a = eastbound(0, 180 - d / 2)
    const b = eastbound(10_000, -180 + d / 2, (d * metersPerDegreeEquator) / 10)
    const k = out()
    hermite(a, b, 5000, k)
    const lon = ((k.lon + 540) % 360) - 180
    expect(Math.abs(lon)).toBeGreaterThan(179.99)
  })
})

describe('evaluateMotion', () => {
  const samples = [
    eastbound(0, 0),
    eastbound(5000, 1000 / metersPerDegreeEquator),
    eastbound(10_000, 2000 / metersPerDegreeEquator)
  ]

  it('interpolates inside the buffer', () => {
    const k = evaluateMotion(samples, 7500, out())!
    expect(k.lon * metersPerDegreeEquator).toBeCloseTo(1500, 3)
    expect(k.extrapolation).toBe(0)
  })

  it('extrapolates briefly past the newest sample, then holds', () => {
    const k = evaluateMotion(samples, 13_000, out())!
    expect(k.lon * metersPerDegreeEquator).toBeCloseTo(2600, 3)
    expect(k.extrapolation).toBeCloseTo(3, 9)
    const held = evaluateMotion(samples, 60_000, out())!
    expect(held.lon * metersPerDegreeEquator).toBeCloseTo(2000 + 200 * 20, 3)
    expect(held.extrapolation).toBeCloseTo(50, 9)
  })

  it('back-fills before the first sample so motion is continuous on arrival', () => {
    const k = evaluateMotion(samples, -2000, out())!
    expect(k.lon * metersPerDegreeEquator).toBeCloseTo(-400, 3)
  })

  it('does not interpolate across implausible jumps', () => {
    const jump = [eastbound(0, 0), eastbound(5000, 1)] // 111 km in 5 s
    const k = evaluateMotion(jump, 2500, out())!
    expect(k.lon).toBe(0)
  })

  it('returns null without samples', () => {
    expect(evaluateMotion([], 0, out())).toBeNull()
  })
})

describe('attitude from kinematics', () => {
  it('computes coordinated-turn bank, clamped to ±30°', () => {
    // Standard-rate turn (3°/s) at 120 kt ≈ 18°.
    expect(bankAngle(61.7, 3)).toBeCloseTo(18.3, 0)
    expect(bankAngle(61.7, -3)).toBeCloseTo(-18.3, 0)
    expect(bankAngle(250, 3)).toBe(30)
    expect(bankAngle(250, 0)).toBe(0)
  })

  it('pitches with the flight path plus angle of attack', () => {
    // 3° glideslope at 70 m/s: −3.7 m/s.
    expect(pitchAngle(70, -3.67, false)).toBeCloseTo(-3 + 2.5, 1)
    expect(pitchAngle(230, 0, false)).toBeCloseTo(2.5, 6)
    expect(pitchAngle(70, 10, true)).toBe(0)
  })

  it('derives track from velocity', () => {
    expect(trackOf(1, 0)).toBeCloseTo(0, 9)
    expect(trackOf(0, 10)).toBeCloseTo(90, 9)
    expect(trackOf(-10, 0)).toBeCloseTo(180, 9)
    expect(trackOf(0, -10)).toBeCloseTo(270, 9)
    expect(trackOf(0.1, 0.1)).toBeNull()
  })

  it('smooths frame-rate independently', () => {
    const one = smoothingFactor(1 / 30, 1)
    const twoHalf = 1 - (1 - smoothingFactor(1 / 60, 1)) ** 2
    expect(twoHalf).toBeCloseTo(one, 12)
  })

  it('builds an orthonormal body frame with the right bank direction', () => {
    const pose = writePose(47, -122, 1000, 90, 5, 20, createPose())
    const { forward, left, up } = pose
    expect(forward.length()).toBeCloseTo(1, 12)
    expect(forward.dot(left)).toBeCloseTo(0, 12)
    expect(forward.dot(up)).toBeCloseTo(0, 12)
    expect(left.dot(up)).toBeCloseTo(0, 12)
    // Right-handed: left × up = forward (glTF: +X left, +Y up, +Z forward).
    expect(left.clone().cross(up).dot(forward)).toBeCloseTo(1, 12)
    // Right bank raises the left wing: left has a positive local-up component.
    const localUp = pose.position.clone().normalize()
    expect(left.dot(localUp)).toBeGreaterThan(0.3)
    // Nose up.
    expect(forward.dot(localUp)).toBeGreaterThan(0.05)
  })
})

describe('altitude datum', () => {
  const state: AircraftState = {
    hex: 'a1',
    callsign: null,
    registration: null,
    typeCode: null,
    category: null,
    squawk: null,
    lat: 47.45,
    lon: -122.31,
    altBaro: 1000,
    altGeom: 1100,
    onGround: false,
    groundSpeed: 140,
    track: 160,
    verticalRate: -700,
    positionTimestamp: 0
  }

  it('prefers geometric (ellipsoid) altitude', () => {
    expect(stateEllipsoidHeight(state)).toBeCloseTo(1100 * 0.3048, 9)
  })

  it('corrects baro-only altitude with the learned offset, else the geoid', () => {
    const baroOnly = { ...state, altGeom: null }
    expect(stateEllipsoidHeight(baroOnly, { baroOffsetFt: 100 })).toBeCloseTo(1100 * 0.3048, 9)
    expect(stateEllipsoidHeight(baroOnly)).toBeCloseTo(
      1000 * 0.3048 + geoidHeight(47.45, -122.31),
      9
    )
  })

  it('puts on-ground aircraft on the raycast ground, else on the geoid', () => {
    const ground = { ...state, onGround: true, altBaro: null, altGeom: null }
    expect(stateEllipsoidHeight(ground, { groundHeight: () => 110 })).toBe(110)
    expect(stateEllipsoidHeight(ground)).toBeCloseTo(geoidHeight(47.45, -122.31), 9)
  })

  it('keeps a grounded pose on the measured pavement despite an older height sample', () => {
    const registry = new AircraftRegistry()
    const aircraft = registry.upsert({ ...state, onGround: true }, 0)
    aircraft.groundHeight = 110
    // Reproduce a stale surface sample while new terrain has refined.
    aircraft.motion[0]!.height = 165
    const pose = computePose(aircraft, 0, 1 / 60, true, createPose(), true)
    expect(pose.onGround).toBe(true)
    expect(pose.height).toBeCloseTo(110 + aircraft.scale.length * AIRFRAMES[aircraft.cls].groundClearance + WHEEL_CONTACT_LIFT, 8)
  })

  it('does not let pose error smoothing push a predicted aircraft past a runway end', () => {
    const previous = nightEmission.roads
    const nav = new GroundNavigation()
    const m = metersPerRadian(state.lat)
    const d = m.east * Math.PI / 180
    nav.setTile('test', [{ kind: 'runway', points: [[state.lon, state.lat], [state.lon + 50 / d, state.lat]] }])
    nightEmission.roads = { groundNavigation: nav } as RoadLightTiles
    try {
      const registry = new AircraftRegistry()
      const aircraft = registry.upsert({ ...state, onGround: true, track: 90, groundSpeed: 20 }, 0)
      aircraft.cameraDistance = 100
      aircraft.groundHeight = 110
      const out = createPose()
      computePose(aircraft, 1000, 1 / 60, true, out, true)
      // Reproduce the old generic smoothing wanting to continue the roll.
      aircraft.attitude.errorE = 80
      computePose(aircraft, 7000, 1 / 60, true, out, true)
      expect((out.lon - state.lon) * d).toBeCloseTo(47, 2)
      expect(out.speed).toBe(0)
      expect(aircraft.groundPrediction).toBe('holding')
      expect(out.opacity).toBe(1)
      registry.upsert({ ...state, onGround: true, track: 90, groundSpeed: 20,
        positionTimestamp: 8000, lon: state.lon + 40 / d }, 8000)
      computePose(aircraft, 8000, 1 / 60, true, out, true)
      expect(aircraft.groundPrediction).toBeUndefined()
    } finally {
      nightEmission.roads = previous
    }
  })

  it('converts a state into an SI sample with track-based velocity', () => {
    const sample = toSample(state, 300)
    const speed = 140 * 0.514444
    expect(Math.hypot(sample.vn, sample.ve)).toBeCloseTo(speed, 3)
    expect(trackOf(sample.vn, sample.ve)).toBeCloseTo(160, 6)
    expect(sample.vu).toBeCloseTo(-700 * 0.00508, 6)
  })

  it('metersPerRadian is consistent with great-circle distance', () => {
    const m = metersPerRadian(47)
    const d = greatCircleDistance(47, -122, 47.01, -122)
    // Mean-sphere vs ellipsoid: within 0.5 %.
    expect((0.01 * Math.PI) / 180 * m.north).toBeCloseTo(d, -1)
  })
})

describe('adaptiveDelayMs', () => {
  const samples = (gapMs: number, n = 8): MotionSample[] =>
    Array.from({ length: n }, (_, i) => eastbound(i * gapMs, 0))

  it('shortens the delay for frequently updated aircraft', () => {
    expect(adaptiveDelayMs(samples(1000), 12_000)).toBe(4000)
    expect(adaptiveDelayMs(samples(6000), 12_000)).toBe(12_000)
    expect(adaptiveDelayMs(samples(200), 12_000)).toBe(2500)
  })

  it('uses the maximum until there is enough history', () => {
    expect(adaptiveDelayMs(samples(1000, 2), 12_000)).toBe(12_000)
  })
})
