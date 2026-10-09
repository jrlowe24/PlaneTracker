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
