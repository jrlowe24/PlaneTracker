import { useEffect, useState, type FC } from 'react'

import { lightAnchor } from '../aircraft/lightAnchor'
import type { TrackedAircraft } from '../data/aircraftRegistry'
import { flightConnection } from '../data/flightConnection'
import { cameraModeStore, followAircraft } from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { selectionStore } from '../state/selection'

const MAX_ROWS = 40
const METERS_PER_NM = 1852

interface Row {
  hex: string
  label: string
  detail: string
  altitude: string
  distanceNm: number
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function toRow(aircraft: TrackedAircraft): Row {
  const { state } = aircraft
  const distance = aircraft.pose?.position.distanceTo(lightAnchor) ?? Infinity
  return {
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
    distanceNm: distance / METERS_PER_NM
  }
}

function matches(aircraft: TrackedAircraft, query: string): boolean {
  const { state } = aircraft
  return [state.callsign, state.registration, state.typeCode, state.hex].some(
    value => value?.toLowerCase().includes(query) === true
  )
}

/** Nearest aircraft (to the view center, or to the followed aircraft). */
function useRows(query: string): { rows: Row[]; total: number } {
  const [result, setResult] = useState<{ rows: Row[]; total: number }>({ rows: [], total: 0 })
  useEffect(() => {
    const update = (): void => {
      const q = query.trim().toLowerCase()
      const list = flightConnection.registry.list
      const candidates = q === '' ? list : list.filter(a => matches(a, q))
      const rows = candidates
        .filter(a => a.pose != null)
        .map(toRow)
        .sort((a, b) => a.distanceNm - b.distanceNm)
        .slice(0, MAX_ROWS)
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
 * and flies the camera into follow mode behind it.
 */
export const AircraftList: FC = () => {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(true)
  const { rows, total } = useRows(query)
  const selectedHex = useStore(selectionStore, s => s.selectedHex)
  const followedHex = useStore(cameraModeStore, s => (s.mode === 'globe' ? null : s.targetHex))

  // Collapse while a plane is selected so its info panel has room; the
  // header stays to reopen it.
  const [lastSelected, setLastSelected] = useState(selectedHex)
  if (selectedHex !== lastSelected) {
    setLastSelected(selectedHex)
    if (selectedHex != null) setOpen(false)
  }

  return (
    <div className={`aircraft-list${open ? ' open' : ''}`}>
      <button
        type='button'
        className='aircraft-list-header'
        aria-expanded={open}
        onClick={() => {
          setOpen(o => !o)
        }}
      >
        <span>
          {followedHex != null ? 'Aircraft near the followed plane' : 'Nearby aircraft'}{' '}
          <span className='muted'>({total})</span>
        </span>
        <span className='chevron'>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <input
            className='aircraft-search'
            type='search'
            placeholder='Search callsign, registration, type…'
            value={query}
            onChange={e => {
              setQuery(e.target.value)
            }}
            onKeyDown={e => {
              // Keep F/W/S/Esc shortcuts from firing while typing.
              e.stopPropagation()
              if (e.key === 'Enter' && rows[0] != null) {
                selectionStore.set({ selectedHex: rows[0].hex })
                followAircraft(rows[0].hex)
              }
            }}
          />
          {rows.length === 0 ? (
            <div className='aircraft-list-empty muted'>
              {total === 0 && query === '' ? 'Waiting for flight data…' : 'No matching aircraft in view.'}
            </div>
          ) : (
            <ul className='aircraft-rows'>
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
                    <span className='row-main'>
                      <span className='row-label'>{row.label}</span>
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
            </ul>
          )}
        </>
      )}
    </div>
  )
}
