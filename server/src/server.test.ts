import {
  greatCircleDistance,
  METERS_PER_NAUTICAL_MILE,
  type AircraftState
} from '@windowseat/shared'
import { describe, expect, it } from 'vitest'

import { AircraftCache } from './cache'
import {
  acceptClientMessage,
  isOriginAllowed,
  parseAllowedOrigins
} from './httpSecurity'
import { parseClientMessage } from './hub'
import {
  enclosingRegion,
  MAX_COVERAGE_RADIUS_NM,
  MAX_QUERY_RADIUS_NM,
  mergeViewports,
  snapRegion,
  viewportToRegions
} from './regions'
import { parseStandingDataRoute } from './routes'
import { parseOpenMeteo, weatherCell } from './weather'
import { normalizeReadsb } from './sources/adsbLol'
import {
  adaptRequestInterval,
  nextBackoff,
  pickNextRegion,
  serveExtraNext,
  UpstreamError,
  type RegionSchedule
} from './sources/regionPoller'
import type { Region } from './sources/types'

function nm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return greatCircleDistance(a.lat, a.lon, b.lat, b.lon) / METERS_PER_NAUTICAL_MILE
}

function covers(regions: Region[], point: { lat: number; lon: number }): boolean {
  return regions.some(r => nm(r, point) <= r.radiusNm + 1e-6)
}

describe('normalizeReadsb', () => {
  const now = 1_791_512_303_000
  const response = {
    now,
    ac: [
      {
        hex: 'A30D14',
        flight: 'RFS707  ',
        r: 'N296PL',
        t: 'C172',
        category: 'A1',
        squawk: '1200',
        alt_baro: 3450,
        alt_geom: 3500,
        gs: 124.6,
        track: 80.76,
        baro_rate: 192,
        lat: 46.996067,
        lon: -123.847821,
        seen_pos: 0.253
      },
      {
        hex: 'a1b2c3',
        alt_baro: 'ground' as const,
        gs: 3.1,
        lat: 47.44,
        lon: -122.3,
        seen_pos: 2,
        geom_rate: 64
      },
      // No position: dropped.
      { hex: 'abcdef', alt_baro: 35000, seen: 1 },
      // Position too old: dropped.
      { hex: 'abcde0', lat: 47, lon: -122, alt_baro: 1000, seen_pos: 90 }
    ]
  }

  it('normalizes fields, keeps wire units and derives the position time', () => {
    const [a, b, ...rest] = normalizeReadsb(response, 0)
    expect(rest).toHaveLength(0)
    expect(a).toEqual({
      hex: 'a30d14',
      callsign: 'RFS707',
      registration: 'N296PL',
      typeCode: 'C172',
      category: 'A1',
      squawk: '1200',
      lat: 46.996067,
      lon: -123.847821,
      altBaro: 3450,
      altGeom: 3500,
      onGround: false,
      groundSpeed: 124.6,
      track: 80.76,
      verticalRate: 192,
      positionTimestamp: now - 253
    } satisfies AircraftState)
    expect(b).toMatchObject({
      hex: 'a1b2c3',
      onGround: true,
      altBaro: null,
      callsign: null,
      verticalRate: 0,
      positionTimestamp: now - 2000
    })
  })
})

describe('regions', () => {
  it('snaps while still containing the original circle', () => {
    const original = { lat: 47.6123, lon: -122.3377, radiusNm: 40 }
    const snapped = snapRegion(original)
    expect(snapped.radiusNm % 25).toBe(0)
    expect(nm(snapped, original) + original.radiusNm).toBeLessThanOrEqual(
      snapped.radiusNm
    )
  })

  it('covers large viewports with ≤ 7 query-sized circles', () => {
    const viewport = { lat: 50, lon: 5, radiusNm: 2000 }
    const regions = viewportToRegions(viewport)
    expect(regions).toHaveLength(7)
    for (const r of regions) expect(r.radiusNm).toBeLessThanOrEqual(MAX_QUERY_RADIUS_NM)
    // Sample points across the covered disc.
    for (let bearing = 0; bearing < 360; bearing += 15) {
      for (const fraction of [0, 0.3, 0.6, 0.95]) {
        const d = fraction * MAX_COVERAGE_RADIUS_NM * METERS_PER_NAUTICAL_MILE
        const lat = viewport.lat + (d / 111_195) * Math.cos((bearing * Math.PI) / 180)
        const lon =
          viewport.lon +
          ((d / 111_195) * Math.sin((bearing * Math.PI) / 180)) /
            Math.cos((lat * Math.PI) / 180)
        // Only check points actually inside the coverage disc.
        if (nm(viewport, { lat, lon }) > MAX_COVERAGE_RADIUS_NM * 0.98) continue
        expect(covers(regions, { lat, lon })).toBe(true)
      }
    }
  })

  it('computes enclosing circles', () => {
    const a = { lat: 47, lon: -122, radiusNm: 20 }
    const b = { lat: 47.5, lon: -122, radiusNm: 20 }
    const u = enclosingRegion(a, b)
    expect(u.radiusNm).toBeCloseTo((nm(a, b) + 40) / 2, 6)
    expect(nm(u, a) + a.radiusNm).toBeLessThanOrEqual(u.radiusNm + 1e-6)
    expect(nm(u, b) + b.radiusNm).toBeLessThanOrEqual(u.radiusNm + 1e-6)
    expect(enclosingRegion(a, { ...a, radiusNm: 5 })).toBe(a)
  })

  it('merges overlapping viewports and keeps distant ones apart', () => {
    const seattle1 = { lat: 47.6, lon: -122.33, radiusNm: 30 }
    const seattle2 = { lat: 47.45, lon: -122.3, radiusNm: 25 }
    const london = { lat: 51.47, lon: -0.45, radiusNm: 40 }
    const regions = mergeViewports([seattle1, seattle2, london])
    expect(regions).toHaveLength(2)
    for (const v of [seattle1, seattle2, london]) {
      expect(
        regions.some(r => nm(r, v) + v.radiusNm <= r.radiusNm + 1e-6)
      ).toBe(true)
    }
  })

  it('deduplicates identical viewports', () => {
    const v = { lat: 47.6, lon: -122.33, radiusNm: 30 }
    expect(mergeViewports([v, v, v])).toHaveLength(1)
    expect(mergeViewports([])).toEqual([])
  })
})

describe('poller scheduling', () => {
  const region = { lat: 0, lon: 0, radiusNm: 50 }
  it('picks the oldest due region', () => {
    const schedules: RegionSchedule[] = [
      { key: 'a', region, lastPolledAt: 10_000 },
      { key: 'b', region, lastPolledAt: 4_000 },
      { key: 'c', region, lastPolledAt: 0 }
    ]
    expect(pickNextRegion(schedules, 12_000, 5000)?.key).toBe('c')
    schedules[2]!.lastPolledAt = 11_000
    expect(pickNextRegion(schedules, 12_000, 5000)?.key).toBe('b')
    schedules[1]!.lastPolledAt = 11_500
    expect(pickNextRegion(schedules, 12_000, 5000)).toBeNull()
  })

  it('widens the request interval on rate limiting and narrows it slowly', () => {
    const options = { minRequestIntervalMs: 1000, maxRequestIntervalMs: 30_000 }
    let interval = 1000
    interval = adaptRequestInterval(interval, true, options)
    expect(interval).toBe(2000)
    interval = adaptRequestInterval(interval, true, options)
    expect(interval).toBe(3500)
    interval = adaptRequestInterval(interval, false, options)
    expect(interval).toBeCloseTo(3395, 6)
    for (let i = 0; i < 200; ++i) interval = adaptRequestInterval(interval, false, options)
    expect(interval).toBe(1000)
    for (let i = 0; i < 20; ++i) interval = adaptRequestInterval(interval, true, options)
    expect(interval).toBe(30_000)
  })

  it('backs off exponentially, honoring Retry-After', () => {
    const options = { initialBackoffMs: 2000, maxBackoffMs: 60_000 }
    expect(nextBackoff(0, new Error('x'), options)).toBe(2000)
    expect(nextBackoff(2000, new Error('x'), options)).toBe(4000)
    expect(nextBackoff(4000, new UpstreamError('429', 429, 30_000), options)).toBe(
      30_000
    )
    expect(nextBackoff(50_000, new Error('x'), options)).toBe(60_000)
  })

  it('serves extras first without starving primary work', () => {
    expect(serveExtraNext(true, true, false)).toBe(true)
    expect(serveExtraNext(true, true, true)).toBe(false)
    expect(serveExtraNext(true, false, true)).toBe(true)
    expect(serveExtraNext(false, true, false)).toBe(false)
  })
})

describe('AircraftCache', () => {
  const base: AircraftState = {
    hex: 'abc123',
    callsign: null,
    registration: null,
    typeCode: null,
    category: null,
    squawk: null,
    lat: 47.5,
    lon: -122.3,
    altBaro: 5000,
    altGeom: 5100,
    onGround: false,
    groundSpeed: 200,
    track: 90,
    verticalRate: 0,
    positionTimestamp: 1000
  }

  it('never replaces a newer position with an older one', () => {
    const cache = new AircraftCache()
    expect(cache.upsert([base], 1000)).toBe(1)
    const rev = cache.get('abc123')!.revision
    expect(cache.upsert([{ ...base, positionTimestamp: 900, lat: 0 }], 2000)).toBe(0)
    expect(cache.get('abc123')!.state.lat).toBe(47.5)
    expect(cache.get('abc123')!.revision).toBe(rev)
    expect(cache.upsert([{ ...base, positionTimestamp: 1500, lat: 47.6 }], 2000)).toBe(1)
    expect(cache.get('abc123')!.revision).toBeGreaterThan(rev)
  })

  it('keeps rich metadata when a newer overview position is sparse', () => {
    const cache = new AircraftCache()
    const rich = {
      ...base,
      callsign: 'ASA1',
      registration: 'N491AS',
      typeCode: 'B739',
      category: 'A3'
    }
    cache.upsert([rich], 1000)
    cache.upsert(
      [
        {
          ...base,
          lat: 47.6,
          positionTimestamp: 2000,
          overview: true
        }
      ],
      2000
    )
    expect(cache.get('abc123')?.state).toMatchObject({
      lat: 47.6,
      callsign: 'ASA1',
      registration: 'N491AS',
      typeCode: 'B739',
      category: 'A3',
      overview: false
    })
  })

  it('lets an older regional report fill sparse overview metadata', () => {
    const cache = new AircraftCache()
    cache.upsert([{ ...base, positionTimestamp: 2000, overview: true }], 2000)
    expect(
      cache.upsert(
        [
          {
            ...base,
            callsign: 'ASA1',
            registration: 'N491AS',
            typeCode: 'B739',
            positionTimestamp: 1500
          }
        ],
        2100
      )
    ).toBe(1)
    expect(cache.get('abc123')?.state).toMatchObject({
      positionTimestamp: 2000,
      callsign: 'ASA1',
      registration: 'N491AS',
      typeCode: 'B739',
      overview: false
    })
  })

  it('drops aircraft unseen for the max age', () => {
    const cache = new AircraftCache()
    cache.upsert([base, { ...base, hex: 'def456' }], 0)
    cache.upsert([{ ...base, hex: 'def456', positionTimestamp: 2000 }], 50_000)
    expect(cache.prune(61_000, 60_000)).toEqual(['abc123'])
    expect(cache.size).toBe(1)
  })

  it('keeps followed aircraft through longer gaps', () => {
    const cache = new AircraftCache()
    cache.upsert([base, { ...base, hex: 'def456' }], 0)
    const followed = new Set(['abc123'])
    expect(cache.prune(61_000, 60_000, 60_000, followed, 300_000)).toEqual(['def456'])
    expect(cache.prune(301_000, 60_000, 60_000, followed, 300_000)).toEqual(['abc123'])
  })

  it('queries by distance', () => {
    const cache = new AircraftCache()
    cache.upsert(
      [base, { ...base, hex: 'far000', lat: 51.47, lon: -0.45 }],
      0
    )
    const near = [...cache.within(47.45, -122.31, 50_000)].map(e => e.state.hex)
    expect(near).toEqual(['abc123'])
  })
})

describe('parseClientMessage', () => {
  it('accepts valid viewports and clamps the radius', () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'viewport', viewport: { lat: 1, lon: 2, radiusNm: 1e9 } })
      )
    ).toEqual({ type: 'viewport', viewport: { lat: 1, lon: 2, radiusNm: 5400 } })
  })

  it('rejects garbage', () => {
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'viewport' }))).toBeNull()
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'viewport', viewport: { lat: 100, lon: 0, radiusNm: 1 } })
      )
    ).toBeNull()
  })
})

describe('public endpoint guards', () => {
  it('allows configured browser origins and non-browser clients', () => {
    const allowed = parseAllowedOrigins('https://window-seat.example, http://localhost:5173')
    expect(isOriginAllowed('https://window-seat.example', allowed)).toBe(true)
    expect(isOriginAllowed('https://other.example', allowed)).toBe(false)
    expect(isOriginAllowed(undefined, allowed)).toBe(true)
    expect(isOriginAllowed('https://other.example', parseAllowedOrigins('*'))).toBe(true)
  })

  it('limits message bursts and resets the window', () => {
    const rate = { startedAt: 1000, count: 0 }
    expect(acceptClientMessage(rate, 1000, 2)).toBe(true)
    expect(acceptClientMessage(rate, 1100, 2)).toBe(true)
    expect(acceptClientMessage(rate, 1200, 2)).toBe(false)
    expect(acceptClientMessage(rate, 2000, 2)).toBe(true)
  })
})

describe('parseStandingDataRoute', () => {
  it('keeps airports with coordinates and requires two or more', () => {
    const route = parseStandingDataRoute('ASA1305', {
      callsign: 'ASA1305',
      _airports: [
        { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles International Airport', location: 'Los Angeles', countryiso2: 'US', lat: 33.94, lon: -118.41 },
        { icao: 'KSEA', iata: 'SEA', name: 'Seattle Tacoma International Airport', location: 'Seattle', countryiso2: 'US', lat: 47.45, lon: -122.31 }
      ]
    })
    expect(route?.airports.map(a => a.iata)).toEqual(['LAX', 'SEA'])
    expect(parseStandingDataRoute('X', { _airports: [{ icao: 'KSEA', lat: 47, lon: -122 }] })).toBeNull()
    expect(
      parseStandingDataRoute('X', { _airports: [{ icao: 'KSEA', iata: '', lat: 47, lon: -122 }, { icao: 'EGLL', lat: 51, lon: 0 }] })
        ?.airports[0]?.iata
    ).toBeNull()
  })
})

describe('Open-Meteo weather', () => {
  it('parses current conditions and snaps cells', () => {
    const sample = parseOpenMeteo({
      latitude: 47.46,
      longitude: -122.31,
      elevation: 120,
      current: {
        time: '2026-10-09T06:15',
        cloud_cover_low: 1,
        cloud_cover_mid: 0,
        cloud_cover_high: 100,
        temperature_2m: 12.6,
        dew_point_2m: 10,
        freezing_level_height: 4150
      }
    })
    expect(sample).toMatchObject({ cloudCoverHigh: 100, elevation: 120, freezingLevel: 4150 })
    expect(sample?.time).toBe(Date.UTC(2026, 9, 9, 6, 15))
    expect(weatherCell(47.46, -122.31)).toBe('47.50,-122.25')
    expect(parseOpenMeteo({ latitude: 0, longitude: 0, elevation: 0 })).toBeNull()
  })
})
