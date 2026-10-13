import { describe, expect, it } from 'vitest'
import { GroundNavigation, type GroundPath } from './groundNavigation'
import { metersPerRadian, type MotionSample, type KinematicState } from './motion'

const m = metersPerRadian(0)
const north = m.north * Math.PI / 180, east = m.east * Math.PI / 180
const point = (x: number, y: number): [number, number] => [x / east, y / north]
const path = (points: [number, number][], kind: GroundPath['kind'] = 'taxiway'): GroundPath =>
  ({ kind, points: points.map(([x, y]) => point(x, y)) })
const sample = (speed = 10): MotionSample =>
  ({ t: 0, lat: 0, lon: 0, height: 0, vn: 0, ve: speed, vu: 0, onGround: true })
function predicted(s: MotionSample, seconds: number): KinematicState {
  return { ...s, lon: s.lon + s.ve * seconds / east, extrapolation: seconds }
}

describe('pavement-aware stale ground prediction', () => {
  it('follows a connected gradual bend instead of continuing onto grass', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [20, 0], [40, 20], [40, 60]])])
    const s = sample(), out = predicted(s, 6)
    expect(nav.constrain(s, out)).toBe(true)
    expect(out.lon * east).toBeCloseTo(40, 3)
    expect(out.lat * north).toBeCloseTo(31.7157, 3)
    expect(out.ve).toBeCloseTo(0)
    expect(out.vn).toBeCloseTo(10)
  })
  it('holds before an ambiguous intersection instead of guessing the exit', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [30, 0], [60, 0]]), path([[30, 0], [50, 20]])])
    const s = sample(), out = predicted(s, 7)
    nav.constrain(s, out)
    expect(out.lon * east).toBeCloseTo(27, 3)
    expect(out.ve).toBe(0)
    expect(out.vn).toBe(0)
  })
  it('stops at a runway end and never invents a high-speed taxi turn', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [100, 0], [100, 200]], 'runway')])
    const s = sample(50), out = predicted(s, 6)
    nav.constrain(s, out)
    expect(out.lon * east).toBeCloseTo(97, 3)
    expect(out.lat).toBe(0)
    expect(out.ve).toBe(0)
  })
  it('continues straight across runway geometry vertices at rollout speed', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [100, 0], [500, 0]], 'runway')])
    const s = sample(50), out = predicted(s, 4)
    nav.constrain(s, out)
    expect(out.lon * east).toBeCloseTo(200, 3)
    expect(out.ve).toBeCloseTo(50)
  })
  it('does not overshoot an endpoint during the initial correction blend', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [10, 0]], 'runway')])
    const s = sample(50), out = predicted(s, 0.5)
    nav.constrain(s, out)
    expect(out.lon * east).toBeCloseTo(7, 3)
    expect(out.ve).toBe(0)
  })
  it('leaves fresh samples, airborne traffic and unmatched positions alone', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [100, 0]])])
    for (const s of [sample(), { ...sample(), onGround: false }, { ...sample(), lat: 0.01 }]) {
      const out = predicted(s, s.onGround ? 0 : 5), before = { ...out }
      expect(nav.constrain(s, out)).toBe(false)
      expect(out).toEqual(before)
    }
    const s = { ...sample(), lat: 0.01 }, out = predicted(s, 5), before = { ...out }
    expect(nav.constrain(s, out)).toBe(false)
    expect(out).toEqual(before)
  })
  it('caps dead reckoning at eight seconds without hiding the aircraft', () => {
    const nav = new GroundNavigation()
    nav.setTile('a', [path([[0, 0], [1000, 0]])])
    const s = sample(), out = predicted(s, 60)
    nav.constrain(s, out)
    expect(out.lon * east).toBeCloseTo(80, 3)
    expect(out.ve).toBe(0)
    expect(out.onGround).toBe(true)
  })
  it('deduplicates adjoining tiles and releases evicted tile routes', () => {
    const nav = new GroundNavigation(), p = path([[0, 0], [20, 0], [100, 0]])
    nav.setTile('a', [p]); nav.setTile('b', [p])
    const s = sample(), out = predicted(s, 5)
    nav.constrain(s, out)
    expect(out.lon * east).toBeCloseTo(50, 3)
    nav.removeTile('a'); nav.removeTile('b')
    expect(nav.constrain(s, predicted(s, 5))).toBe(false)
  })
})
