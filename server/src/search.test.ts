import type { AircraftState } from '@windowseat/shared'
import { describe, expect, it } from 'vitest'

import { AircraftCache } from './cache'
import { normalizeQuery, SearchService } from './search'
import type { AdsbLolSource } from './sources/adsbLol'
import type { FollowFeed } from './sources/followFeed'
import { RegionPoller } from './sources/regionPoller'

const base: AircraftState = {
  hex: 'abc123',
  callsign: 'ASA1',
  registration: 'N491AS',
  typeCode: 'B739',
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

/** Fake adsb.fi feed: answers lookups from a table of paths. */
function fakeFeed(table: Record<string, AircraftState[]>): { feed: FollowFeed; paths: string[] } {
  const paths: string[] = []
  const feed = {
    lookup: (path: string) => {
      paths.push(path)
      return Promise.resolve(table[path] ?? [])
    }
  } as unknown as FollowFeed
  return { feed, paths }
}

describe('SearchService', () => {
  it('normalizes queries', () => {
    expect(normalizeQuery('  asa 1 ')).toBe('ASA1')
  })

  it('looks up callsigns worldwide and falls back to registrations', async () => {
    const far = { ...base, hex: 'def456', callsign: 'UAE1', lat: 38, lon: 36 }
    const { feed, paths } = fakeFeed({ '/v2/callsign/UAE1': [far] })
    const service = new SearchService(new AircraftCache(), feed, null)
    const found = await service.search('uae1')
    expect(found.results.map(r => r.callsign)).toEqual(['UAE1'])
    expect(paths).toEqual(['/v2/callsign/UAE1'])

    const reg = fakeFeed({ '/v2/registration/N491AS': [base] })
    const byReg = await new SearchService(new AircraftCache(), reg.feed, null).search('N491AS')
    expect(reg.paths).toEqual(['/v2/callsign/N491AS', '/v2/registration/N491AS'])
    expect(byReg.results[0]!.hex).toBe('abc123')
  })

  it('matches tracked traffic and type lookups, deduplicated', async () => {
    const cache = new AircraftCache()
    cache.upsert([base], 1000)
    const other = { ...base, hex: 'fff000', callsign: 'ASA2' }
    const lol = { lookupType: () => Promise.resolve([base, other]) } as unknown as AdsbLolSource
    const service = new SearchService(cache, fakeFeed({}).feed, lol)
    const found = await service.search('B739')
    expect(found.results.map(r => r.hex).sort()).toEqual(['abc123', 'fff000'])
    // Type results are cached for the view.
    expect(cache.get('fff000')).toBeDefined()
  })

  it('searches only tracked traffic without live sources', async () => {
    const cache = new AircraftCache()
    cache.upsert([base], 1000)
    const found = await new SearchService(cache, null, null).search('asa')
    expect(found.localOnly).toBe(true)
    expect(found.results).toHaveLength(1)
  })
})

describe('RegionPoller one-off requests', () => {
  it('serves queued requests ahead of regions', async () => {
    const calls: string[] = []
    const poller = new RegionPoller(
      () => {
        calls.push('region')
        return Promise.resolve([])
      },
      { minRequestIntervalMs: 0 }
    )
    poller.setRegions([{ lat: 0, lon: 0, radiusNm: 50 }])
    const result = poller.request(() => {
      calls.push('extra')
      return Promise.resolve([base])
    })
    poller.start(() => undefined)
    expect((await result).map(s => s.hex)).toEqual(['abc123'])
    poller.stop()
    expect(calls[0]).toBe('extra')
  })

  it('alternates queued requests with due live regions', async () => {
    const calls: string[] = []
    const poller = new RegionPoller(
      () => {
        calls.push('region')
        return Promise.resolve([])
      },
      { minRequestIntervalMs: 0, minRegionIntervalMs: 0 }
    )
    poller.setRegions([{ lat: 0, lon: 0, radiusNm: 50 }])
    const first = poller.request(() => {
      calls.push('extra-1')
      return Promise.resolve([])
    })
    const second = poller.request(() => {
      calls.push('extra-2')
      return Promise.resolve([])
    })
    poller.start(() => undefined)
    await Promise.all([first, second])
    poller.stop()
    expect(calls.slice(0, 3)).toEqual(['extra-1', 'region', 'extra-2'])
  })
})

describe('weather grid cells', () => {
  it('centers a 7×7 grid of 1° cells and wraps longitude', async () => {
    const { gridCells } = await import('./weather')
    const cells = gridCells(47.4, -122.3)
    expect(cells).toHaveLength(49)
    expect(cells[24]).toEqual([47, -122])
    const wrapped = gridCells(10, 179.6)
    expect(wrapped.map(c => c[1])).toContain(-178)
    expect(wrapped.every(c => c[1] >= -180 && c[1] < 180)).toBe(true)
  })
})

describe('OpenSky snapshot', () => {
  it('normalizes state vectors and drops stale or position-less ones', async () => {
    const { normalizeOpenSky } = await import('./sources/openskySnapshot')
    const now = 1_000_000
    const states = normalizeOpenSky(
      [
        ['abc123', 'UAL1    ', 'United States', now - 5, now, -122.3, 47.5, 3048, false, 100, 90, -5, null, 3100, '1200', false, 0, 4],
        ['def456', null, 'X', now - 600, now, 1, 2, null, true, 0, 0, 0, null, null, null, false, 0],
        ['aaa111', null, 'X', null, now, null, null, null, false, null, null, null, null, null, null, false, 0]
      ],
      now
    )
    expect(states).toHaveLength(1)
    const s = states[0]!
    expect(s.hex).toBe('abc123')
    expect(s.callsign).toBe('UAL1')
    expect(s.altBaro).toBe(10000)
    expect(s.category).toBe('A3')
    expect(s.groundSpeed).toBeCloseTo(194.4, 1)
    expect(s.overview).toBe(true)
  })
})
