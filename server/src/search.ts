import type { AircraftState, SearchResponse, SearchResult } from '@windowseat/shared'

import type { AircraftCache } from './cache'
import type { AdsbLolSource } from './sources/adsbLol'
import type { FollowFeed } from './sources/followFeed'

/**
 * Worldwide aircraft search. The live view only tracks traffic around each
 * client's camera, so finding a plane elsewhere needs upstream lookups:
 *
 * - callsign, registration and hex: adsb.fi (`/v2/callsign`, `/v2/registration`,
 *   `/v2/hex`), queued in the follow feed's shared request slot;
 * - ICAO type ("A388", "B738"): adsb.lol `/v2/type` (adsb.fi has none), in
 *   the region poller's rate-limited slot, interleaved with region polls;
 * - plus a substring match over everything the server already tracks.
 *
 * Found aircraft are also fed into the cache, so they appear in the view as
 * soon as a client's camera gets there. Results are cached briefly per query.
 */

const CACHE_MS = 20_000
const MAX_RESULTS = 60

function toResult(state: AircraftState): SearchResult {
  return {
    hex: state.hex,
    callsign: state.callsign,
    registration: state.registration,
    typeCode: state.typeCode,
    lat: state.lat,
    lon: state.lon,
    altitude: state.onGround ? null : (state.altGeom ?? state.altBaro),
    onGround: state.onGround
  }
}

export function normalizeQuery(query: string): string {
  return query.trim().toUpperCase().replace(/\s+/g, '')
}

const isHex = (q: string): boolean => /^~?[0-9A-F]{6}$/.test(q)
/** ICAO type designators: a letter, then 1–3 letters/digits with a digit. */
const isTypeLike = (q: string): boolean => /^[A-Z][A-Z0-9]{1,3}$/.test(q) && /\d/.test(q)
const isCallsignLike = (q: string): boolean => /^[A-Z0-9]{3,8}$/.test(q)
const isRegistrationLike = (q: string): boolean => /^[A-Z0-9-]{3,10}$/.test(q)

export class SearchService {
  private readonly results = new Map<string, { at: number; response: Promise<SearchResponse> }>()

  constructor(
    private readonly cache: AircraftCache,
    private readonly fi: FollowFeed | null,
    private readonly lol: AdsbLolSource | null
  ) {}

  search(raw: string): Promise<SearchResponse> {
    const query = normalizeQuery(raw)
    const now = Date.now()
    for (const [key, entry] of this.results) {
      if (now - entry.at > CACHE_MS) this.results.delete(key)
    }
    const cached = this.results.get(query)
    if (cached != null) return cached.response
    const response = this.run(query)
    this.results.set(query, { at: now, response })
    return response
  }

  private async run(query: string): Promise<SearchResponse> {
    const found = new Map<string, AircraftState>()
    const add = (states: Iterable<AircraftState>): void => {
      for (const state of states) found.set(state.hex, state)
    }
    if (query.length < 2) return { query, results: [], localOnly: true }

    // Already-tracked traffic (any region a client has looked at).
    const lower = query.toLowerCase()
    for (const { state } of this.cache.values()) {
      const fields = [state.callsign, state.registration, state.typeCode, state.hex]
      if (fields.some(v => v?.replace(/\s+/g, '').toLowerCase().includes(lower) === true)) {
        add([state])
      }
    }

    const lookups: Array<Promise<AircraftState[]>> = []
    if (this.fi != null) {
      if (isHex(query)) lookups.push(this.fi.lookup(`/v2/hex/${query.toLowerCase()}`))
      if (isCallsignLike(query)) {
        lookups.push(
          this.fi.lookup(`/v2/callsign/${query}`).then(async states =>
            // Nothing under that callsign: maybe it's a registration.
            states.length > 0 || !isRegistrationLike(query)
              ? states
              : this.fi!.lookup(`/v2/registration/${query}`)
          )
        )
      } else if (isRegistrationLike(query)) {
        lookups.push(this.fi.lookup(`/v2/registration/${query}`))
      }
    }
    if (this.lol != null && isTypeLike(query)) lookups.push(this.typeLookup(query))
    for (const states of await Promise.all(lookups)) add(states)

    const results = [...found.values()]
      .sort((a, b) => Number(a.onGround) - Number(b.onGround) || (a.callsign ?? '').localeCompare(b.callsign ?? ''))
      .slice(0, MAX_RESULTS)
      .map(toResult)
    return { query, results, localOnly: lookups.length === 0 }
  }

  private async typeLookup(type: string): Promise<AircraftState[]> {
    const states = await this.lol!.lookupType(type)
    this.cache.upsert(states, Date.now())
    return states
  }
}
