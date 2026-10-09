import { encodeAircraft, geodeticToEcef, WGS84_A, type AircraftState } from '@windowseat/shared'
import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { sunVisibility, skyBrightness } from '../aircraft/shading'
import { AircraftRegistry } from './aircraftRegistry'
import { intersectEllipsoid } from './viewport'

const base: AircraftState = {
  hex: 'a00001',
  callsign: null,
  registration: null,
  typeCode: null,
  category: null,
  squawk: null,
  lat: 47,
  lon: -122,
  altBaro: 1000,
  altGeom: 1000,
  onGround: false,
  groundSpeed: 100,
  track: 0,
  verticalRate: 0,
  positionTimestamp: 1000
}

describe('AircraftRegistry', () => {
  it('keeps a dense list with consistent indices across removals', () => {
    const registry = new AircraftRegistry()
    registry.apply(
      {
        type: 'aircraft',
        serverTime: 0,
        reset: false,
        upserts: ['a', 'b', 'c', 'd'].map(hex => encodeAircraft({ ...base, hex })),
        removals: []
      },
      0
    )
    registry.apply(
      { type: 'aircraft', serverTime: 0, reset: false, upserts: [], removals: ['b'] },
      0
    )
    expect(registry.list.map(a => a.hex)).toEqual(['a', 'd', 'c'])
    registry.list.forEach((a, i) => {
      expect(a.index).toBe(i)
      expect(registry.byHex.get(a.hex)).toBe(a)
    })
    registry.remove('c')
    registry.remove('zzz')
    expect(registry.list.map(a => a.hex)).toEqual(['a', 'd'])
  })

  it('appends samples in time order and caps history', () => {
    const registry = new AircraftRegistry()
    for (let t = 0; t < 20; ++t) {
      registry.upsert({ ...base, positionTimestamp: 1000 + t * 1000 }, t)
    }
    // An out-of-order (older) sample updates nothing in the history.
    registry.upsert({ ...base, positionTimestamp: 500 }, 21)
    const tracked = registry.byHex.get(base.hex)!
    expect(tracked.motion).toHaveLength(16)
    expect(tracked.motion.at(-1)!.t).toBe(20_000)
  })

  it('keeps aircraft across a reconnect and drops unconfirmed ones later', () => {
    const registry = new AircraftRegistry()
    registry.upsert({ ...base, hex: 'keep' }, 0)
    registry.upsert({ ...base, hex: 'gone' }, 0)
    registry.markAllUnconfirmed(1000)
    const update = (now: number, hexes: string[]): void => {
      registry.apply(
        {
          type: 'aircraft',
          serverTime: now,
          reset: false,
          upserts: hexes.map(hex => encodeAircraft({ ...base, hex, positionTimestamp: now })),
          removals: []
        },
        now
      )
    }
    update(2000, ['keep'])
    expect(registry.list).toHaveLength(2)
    update(17_000, ['keep'])
    expect(registry.list.map(a => a.hex)).toEqual(['keep'])
  })

  it('clears on reset', () => {
    const registry = new AircraftRegistry()
    registry.upsert(base, 0)
    registry.apply(
      { type: 'aircraft', serverTime: 0, reset: true, upserts: [], removals: [] },
      0
    )
    expect(registry.list).toHaveLength(0)
  })
})

describe('intersectEllipsoid', () => {
  it('hits the ellipsoid surface straight down', () => {
    const p = geodeticToEcef(47, -122, 10_000)
    const origin = new Vector3(p.x, p.y, p.z)
    const down = origin.clone().normalize().negate()
    const t = intersectEllipsoid(origin, down)!
    // Geocentric "down" isn't exactly the ellipsoid normal; ~10 km anyway.
    expect(t).toBeGreaterThan(9_900)
    expect(t).toBeLessThan(10_100)
  })

  it('misses when looking away', () => {
    const origin = new Vector3(WGS84_A + 1000, 0, 0)
    expect(intersectEllipsoid(origin, new Vector3(1, 0, 0))).toBeNull()
  })
})

describe('aircraft shading', () => {
  it('keeps aircraft at altitude sunlit after local sunset', () => {
    // Sun 2° below the local horizontal.
    const sunDotUp = Math.sin((-2 * Math.PI) / 180)
    expect(sunVisibility(sunDotUp, 0)).toBe(0)
    // At FL350 the horizon dips ~3.4°, so the sun is still up.
    expect(sunVisibility(sunDotUp, 10_668)).toBe(1)
    expect(sunVisibility(0.5, 0)).toBe(1)
  })

  it('dims the sky through twilight', () => {
    expect(skyBrightness(1)).toBeGreaterThan(0.99)
    expect(skyBrightness(-0.5)).toBeLessThan(0.01)
    expect(skyBrightness(0)).toBeGreaterThan(skyBrightness(-0.1))
  })
})
