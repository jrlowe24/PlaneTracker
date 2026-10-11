import {
  ecefToGeodetic,
  greatCircleDistance,
  type SearchResponse,
  type SearchResult
} from '@windowseat/shared'
import { useEffect, useRef, useState, type FC } from 'react'

import { CATEGORY_COLORS, CATEGORY_LABELS, type AircraftCategory } from '../aircraft/categories'
import { lightAnchor } from '../aircraft/lightAnchor'
import { jumpTo } from '../camera/jump'
import { config } from '../config'
import { exactAirport, loadAirports, searchAirports, type Airport } from '../data/airports'
import type { TrackedAircraft } from '../data/aircraftRegistry'
import { flightConnection } from '../data/flightConnection'
import { startUserLocation, userLocationStore } from '../data/userLocation'
import { routeFor } from '../data/routeDisplay'
import { cameraModeStore, exitToGlobe, followAircraft } from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { selectionStore } from '../state/selection'

import './aircraftList.css'

const MAX_ROWS = 40
const METERS_PER_NM = 1852

interface Row {
  hex: string
  label: string
  detail: string
  /** "LAX → SEA", or null when unknown. */
  route: string | null
  routeTitle: string | null
  routePlausible: boolean
  altitude: string
  distanceNm: number
  onGround: boolean
  category: AircraftCategory
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const SEARCH_DEBOUNCE_MS = 450
const FEET_TO_METERS = 0.3048

/** Busy airports to jump to when there's no traffic in view. */
const HUBS: Array<{ code: string; lat: number; lon: number }> = [
  { code: 'SEA', lat: 47.449, lon: -122.309 },
  { code: 'LAX', lat: 33.942, lon: -118.408 },
  { code: 'ORD', lat: 41.978, lon: -87.905 },
  { code: 'ATL', lat: 33.64, lon: -84.427 },
  { code: 'JFK', lat: 40.641, lon: -73.778 },
  { code: 'LHR', lat: 51.47, lon: -0.454 },
  { code: 'FRA', lat: 50.037, lon: 8.562 },
  { code: 'DXB', lat: 25.253, lon: 55.365 },
  { code: 'SIN', lat: 1.364, lon: 103.991 },
  { code: 'HND', lat: 35.549, lon: 139.78 },
  { code: 'SYD', lat: -33.946, lon: 151.177 }
]

function jumpToHub(hub: { lat: number; lon: number }): void {
  jumpTo({ lat: hub.lat, lon: hub.lon, distance: 60_000, pitch: -40 })
}

/** Flies the camera to an airport (leaving follow mode). */
function jumpToAirport(airport: Airport): void {
  selectionStore.set({ selectedHex: null })
  exitToGlobe()
  jumpTo({ lat: airport.lat, lon: airport.lon, distance: 25_000, pitch: -35 })
}

/** Airport matches for a query; the index loads on the first search. */
function useAirportSearch(query: string): Airport[] {
  const [airports, setAirports] = useState<Airport[] | null>(null)
  const wanted = query.trim().length >= 2
  useEffect(() => {
    if (!wanted || airports != null) return
    let live = true
    void loadAirports().then(list => {
      if (live) setAirports(list)
    })
    return () => {
      live = false
    }
  }, [wanted, airports])
  return airports == null ? [] : searchAirports(airports, query)
}

/** Jumps the camera over a search result and follows it once its data arrives. */
function jumpToResult(result: SearchResult): void {
  const height = (result.altitude ?? 0) * FEET_TO_METERS
  jumpTo({ lat: result.lat, lon: result.lon, height, distance: 15_000, pitch: -30 }, result.hex)
}

/**
 * Where "nearby" is measured from: the user's own location when shared,
 * else the view center (or the followed aircraft).
 */
function origin(): { lat: number; lon: number } {
  return (
    userLocationStore.get().position ?? ecefToGeodetic(lightAnchor.x, lightAnchor.y, lightAnchor.z)
  )
}

/** Distance (nm) from the origin to a point. */
function distanceFromOriginNm(lat: number, lon: number, from = origin()): number {
  return greatCircleDistance(from.lat, from.lon, lat, lon) / METERS_PER_NM
}

type WorldSearch =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'done'; query: string; response: SearchResponse }

/** Worldwide search on the server (debounced; only for 2+ characters). */
function useWorldSearch(query: string): WorldSearch {
  const [last, setLast] = useState<SearchResponse | null>(null)
  const q = query.trim()
  useEffect(() => {
    if (q.length < 2) return
    const controller = new AbortController()
    const id = setTimeout(() => {
      fetch(config.serverHttpUrl(`/api/search?q=${encodeURIComponent(q)}`), { signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error(String(response.status))
          const body = (await response.json()) as SearchResponse
          setLast({ ...body, query: q })
        })
        .catch(() => {
          if (!controller.signal.aborted) setLast({ query: q, results: [], localOnly: true })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(id)
      controller.abort()
    }
  }, [q])
  if (q.length < 2) return { status: 'idle' }
  if (last?.query !== q) return { status: 'loading', query: q }
  return { status: 'done', query: q, response: last }
}

function toRow(aircraft: TrackedAircraft, from: { lat: number; lon: number }): Row {
  const { state } = aircraft
  const pose = aircraft.pose
  const distanceNm = pose == null ? Infinity : distanceFromOriginNm(pose.lat, pose.lon, from)
  const route = routeFor(aircraft)
  return {
    route: route?.short ?? null,
    routeTitle: route == null ? null : `${route.long}${route.leg.plausible ? '' : ' (scheduled route; position doesn’t match)'}`,
    routePlausible: route?.leg.plausible ?? false,
    hex: aircraft.hex,
    label: state.callsign ?? state.registration ?? state.hex.toUpperCase(),
    detail: [state.typeCode, state.registration !== state.callsign ? state.registration : null]
      .filter(v => v != null)
      .join(' · '),
    altitude: state.onGround
      ? 'GND'
      : (state.altGeom ?? state.altBaro) == null
        ? '—'
        : `${fmt.format((state.altGeom ?? state.altBaro)!)} ft`,
    distanceNm,
    onGround: state.onGround,
    category: aircraft.category
  }
}

/**
 * Distances are compared in steps of this many nm: within a step, rows
 * keep their previous order, so the list doesn't reshuffle every second
 * as aircraft at similar distances trade places.
 */
const ORDER_STEP_NM = 1.5

function matches(aircraft: TrackedAircraft, query: string): boolean {
  const { state } = aircraft
  const route = state.callsign == null ? undefined : flightConnection.routes.get(state.callsign)
  const airports = route?.airports.flatMap(a => [a.iata, a.icao, a.location]) ?? []
  return [state.callsign, state.registration, state.typeCode, state.hex, ...airports].some(
    value => value?.toLowerCase().includes(query) === true
  )
}

/** Nearest aircraft to the user's location (else the view / followed aircraft). */
function useRows(query: string): { rows: Row[]; total: number } {
  const [result, setResult] = useState<{ rows: Row[]; total: number }>({ rows: [], total: 0 })
  const previous = useRef(new Map<string, number>())
  useEffect(() => {
    const update = (): void => {
      const order = previous.current
      const q = query.trim().toLowerCase()
      const list = flightConnection.registry.list
      const candidates = q === '' ? list : list.filter(a => matches(a, q))
      const from = origin()
      const rows = candidates
        .filter(a => a.pose != null)
        .map(a => toRow(a, from))
        // Airborne first, then nearest (in steps, keeping the last order).
        .sort(
          (a, b) =>
            Number(a.onGround) - Number(b.onGround) ||
            Math.floor(a.distanceNm / ORDER_STEP_NM) - Math.floor(b.distanceNm / ORDER_STEP_NM) ||
            (order.get(a.hex) ?? Infinity) - (order.get(b.hex) ?? Infinity) ||
            a.distanceNm - b.distanceNm
        )
        .slice(0, MAX_ROWS)
      previous.current = new Map(rows.map((row, i) => [row.hex, i]))
      setResult({ rows, total: candidates.length })
    }
    update()
    const id = setInterval(update, 1000)
    return () => {
      clearInterval(id)
    }
  }, [query])
  return result
}

/**
 * List of nearby aircraft with search. Clicking a row selects the aircraft
 * and flies the camera into follow mode behind it. Searches also run
 * worldwide on the server; picking a far-away result jumps the camera there
 * and follows it once its data arrives. With nothing in view, busy airports
 * are offered as jump targets.
 */
export const AircraftList: FC<{
  /** In the phone bottom sheet: always expanded (the sheet sizes it), search on top. */
  sheet?: boolean
  onSearchFocus?: () => void
}> = ({ sheet = false, onSearchFocus }) => {
  const [query, setQuery] = useState('')
  const [expanded, setOpen] = useState(true)
  const open = sheet || expanded
  const { rows, total } = useRows(query)
  const world = useWorldSearch(query)
  const airports = useAirportSearch(query)
  const localHexes = new Set(rows.map(r => r.hex))
  const worldRows =
    world.status === 'done' ? world.response.results.filter(r => !localHexes.has(r.hex)) : []
  const selectedHex = useStore(selectionStore, s => s.selectedHex)
  const followedHex = useStore(cameraModeStore, s => (s.mode === 'globe' ? null : s.targetHex))
  const nearUser = useStore(userLocationStore, s => s.position != null)
  useEffect(() => {
    startUserLocation()
  }, [])

  // Collapse while a plane is selected so its info panel has room; the
  // header stays to reopen it.
  const [lastSelected, setLastSelected] = useState(selectedHex)
  if (selectedHex !== lastSelected) {
    setLastSelected(selectedHex)
    if (selectedHex != null) setOpen(false)
  }

  return (
    <div className={`aircraft-list${open ? ' open' : ''}${sheet ? ' in-sheet' : ''}${followedHex != null ? ' attached' : ''}`}>
      {!sheet && (
        <button
          type='button'
          className='aircraft-list-header'
          aria-expanded={open}
          onClick={() => {
            setOpen(o => !o)
          }}
        >
          <span>
            {nearUser
              ? 'Near you'
              : followedHex != null
                ? 'Aircraft near the followed plane'
                : 'Nearby aircraft'}{' '}
            <span className='muted'>({total})</span>
          </span>
          <span className='chevron'>{open ? '▴' : '▾'}</span>
        </button>
      )}
      {open && (
        <>
          <input
            className='aircraft-search'
            type='search'
            placeholder={sheet ? 'Search flights, airports, types' : 'Search callsign (ASA1), registration, type, airport…'}
            onFocus={onSearchFocus}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
            }}
            onKeyDown={e => {
              // Keep F/W/S/Esc shortcuts from firing while typing.
              e.stopPropagation()
              if (e.key !== 'Enter') return
              void loadAirports().then(list => {
                const airport = exactAirport(list, query)
                if (airport != null) {
                  jumpToAirport(airport)
                  setQuery('')
                  return
                }
                if (rows[0] != null) {
                  selectionStore.set({ selectedHex: rows[0].hex })
                  followAircraft(rows[0].hex)
                } else if (worldRows[0] != null) {
                  jumpToResult(worldRows[0])
                } else if (airports[0] != null) {
                  jumpToAirport(airports[0])
                  setQuery('')
                }
              })
            }}
          />
          {sheet && (
            <div className='aircraft-section sheet-section'>
              {nearUser ? 'Near you' : 'Nearby'} <span className='muted'>· {total}</span>
            </div>
          )}
          <ul className='aircraft-rows'>
            {airports.length > 0 && <li className='aircraft-section muted'>Airports</li>}
            {airports.map(airport => (
              <li key={`airport-${airport.icao}-${airport.iata}`}>
                <button
                  type='button'
                  className='aircraft-row airport-row'
                  title={`Fly to ${airport.name}`}
                  onClick={() => {
                    jumpToAirport(airport)
                    setQuery('')
                  }}
                >
                  <span className='airport-code'>{airport.iata !== '' ? airport.iata : airport.icao}</span>
                  <span className='row-main'>
                    <span className='row-label'>{airport.name}</span>
                    <span className='row-detail muted'>
                      {[airport.city, airport.country, airport.iata !== '' ? airport.icao : null]
                        .filter(v => v != null && v !== '')
                        .join(' · ')}
                    </span>
                  </span>
                  <span className='row-numbers'>
                    <span className='muted'>{fmt.format(distanceFromOriginNm(airport.lat, airport.lon))} nm</span>
                  </span>
                </button>
              </li>
            ))}
            {airports.length > 0 && rows.length > 0 && <li className='aircraft-section muted'>Aircraft</li>}
            {rows.map(row => (
              <li key={row.hex}>
                <button
                  type='button'
                  className={`aircraft-row${row.hex === selectedHex ? ' selected' : ''}`}
                  title='Follow this aircraft'
                  onClick={() => {
                    selectionStore.set({ selectedHex: row.hex })
                    followAircraft(row.hex)
                  }}
                >
                  <span
                    className='row-dot'
                    style={{ background: CATEGORY_COLORS[row.category] }}
                    title={CATEGORY_LABELS[row.category]}
                  />
                  <span className='row-main'>
                    <span className='row-label'>
                      {row.label}
                      {row.route != null && (
                        <span
                          className={`row-route${row.routePlausible ? '' : ' doubtful'}`}
                          title={row.routeTitle ?? undefined}
                        >
                          {row.route}
                          {row.routePlausible ? '' : '?'}
                        </span>
                      )}
                    </span>
                    <span className='row-detail muted'>{row.detail}</span>
                  </span>
                  <span className='row-numbers'>
                    <span>{row.altitude}</span>
                    <span className='muted'>
                      {row.hex === followedHex
                        ? 'following'
                        : `${row.distanceNm < 10 ? row.distanceNm.toFixed(1) : fmt.format(row.distanceNm)} nm`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {rows.length === 0 && total > 0 && query.trim() === '' &&
              [0, 1, 2, 3].map(i => (
                <li key={`skeleton-${i}`} className='aircraft-row-skeleton' aria-hidden />
              ))}
            {rows.length === 0 && !(total > 0 && query.trim() === '') && airports.length === 0 && (
              <li className='aircraft-list-empty muted'>
                {query.trim() !== ''
                  ? 'No matching aircraft in view.'
                  : total === 0
                    ? 'No aircraft in view. Search worldwide above, or jump to a busy airport:'
                    : 'Waiting for positions…'}
              </li>
            )}
            {query.trim() === '' && rows.length === 0 && (
              <li className='hub-chips'>
                {HUBS.map(hub => (
                  <button
                    key={hub.code}
                    type='button'
                    className='hub-chip'
                    title={`Jump to ${hub.code}`}
                    onClick={() => {
                      jumpToHub(hub)
                    }}
                  >
                    {hub.code}
                  </button>
                ))}
              </li>
            )}
            {world.status !== 'idle' && !(airports.length > 0 && worldRows.length === 0) && (
              <li className='aircraft-section muted'>
                Worldwide
                {world.status === 'loading' && ' · searching…'}
                {world.status === 'done' && worldRows.length === 0 && ' · nothing else found'}
              </li>
            )}
            {worldRows.map(result => (
              <li key={`world-${result.hex}`}>
                <button
                  type='button'
                  className='aircraft-row'
                  title='Jump there and follow this aircraft'
                  onClick={() => {
                    jumpToResult(result)
                  }}
                >
                  <span className='row-main'>
                    <span className='row-label'>
                      {result.callsign ?? result.registration ?? result.hex.toUpperCase()}
                    </span>
                    <span className='row-detail muted'>
                      {[result.typeCode, result.registration !== result.callsign ? result.registration : null]
                        .filter(v => v != null)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className='row-numbers'>
                    <span>
                      {result.onGround ? 'GND' : result.altitude == null ? '—' : `${fmt.format(result.altitude)} ft`}
                    </span>
                    <span className='muted'>{fmt.format(distanceFromOriginNm(result.lat, result.lon))} nm</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {query.trim() === '' && rows.length > 0 && (
            <div className='category-legend' aria-label='Map colors'>
              {(Object.keys(CATEGORY_LABELS) as AircraftCategory[])
                .filter(c => c !== 'other')
                .map(c => (
                  <span key={c}>
                    <i style={{ background: CATEGORY_COLORS[c] }} />
                    {CATEGORY_LABELS[c]}
                  </span>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
