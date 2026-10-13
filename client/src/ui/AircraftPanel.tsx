import type { AircraftState } from '@windowseat/shared'
import { useEffect, useState, type FC } from 'react'

import { flightConnection, serverNow } from '../data/flightConnection'
import { routeFor } from '../data/routeDisplay'
import {
  cameraModeStore,
  enterWindowView,
  exitToGlobe,
  followAircraft
} from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { selectionStore } from '../state/selection'

/** Re-renders periodically so values read from the registry stay fresh. */
function useTicker(intervalMs: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => t + 1)
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [intervalMs])
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/**
 * Reported altitude is above sea level (an airport at 433 ft reads 450 ft on
 * the runway), so near the ground the height above the terrain is shown too.
 */
function formatAltitude(state: AircraftState, aboveGroundM: number | null, onGround = state.onGround): string {
  if (onGround) return 'On ground'
  if (state.onGround) return aboveGroundM == null ? 'Touchdown reported' :
    `${fmt.format(Math.max(0, aboveGroundM / 0.3048))} ft above ground · touchdown reported`
  const parts: string[] = []
  if (state.altBaro != null) parts.push(`${fmt.format(state.altBaro)} ft`)
  else if (state.altGeom != null) parts.push(`GNSS ${fmt.format(state.altGeom)} ft`)
  if (aboveGroundM != null && aboveGroundM < 1500) {
    parts.push(`${fmt.format(Math.max(0, aboveGroundM / 0.3048))} ft above ground`)
  }
  return parts.length > 0 ? parts.join(' · ') : '—'
}

function formatVerticalRate(fpm: number | null): string {
  if (fpm == null) return '—'
  if (Math.abs(fpm) < 64) return 'Level'
  return `${fpm > 0 ? '▲' : '▼'} ${fmt.format(Math.abs(fpm))} ft/min`
}

export const AircraftPanel: FC = () => {
  const hex = useStore(selectionStore, s => s.selectedHex)
  useTicker(500)
  const tracked = hex == null ? undefined : flightConnection.registry.byHex.get(hex)

  const mode = useStore(cameraModeStore, s => s.mode)
  const targetHex = useStore(cameraModeStore, s => s.targetHex)
  const attached = mode !== 'globe' && targetHex === hex

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return
      const { selectedHex } = selectionStore.get()
      const camera = cameraModeStore.get()
      if (event.key === 'Escape') {
        if (camera.mode !== 'globe') exitToGlobe()
        else selectionStore.set({ selectedHex: null })
      } else if ((event.key === 'f' || event.key === 'F') && selectedHex != null) {
        followAircraft(selectedHex)
      } else if ((event.key === 'w' || event.key === 'W') && selectedHex != null) {
        enterWindowView(selectedHex)
      } else if ((event.key === 's' || event.key === 'S') && camera.mode === 'window') {
        cameraModeStore.set({ windowSide: camera.windowSide === 'left' ? 'right' : 'left' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (hex == null) return null
  if (tracked == null) {
    return (
      <div className='aircraft-panel'>
        <div className='aircraft-panel-header'>
          <div className='aircraft-title'>{hex.toUpperCase()}</div>
          <CloseButton />
        </div>
        <div className='muted'>No longer in view.</div>
      </div>
    )
  }

  const state = tracked.state
  const route = routeFor(tracked)
  const ageS = Math.max(0, (serverNow() - state.positionTimestamp) / 1000)
  return (
    <div className={`aircraft-panel${attached ? ' attached' : ''}`}>
      <div className='aircraft-panel-header'>
        <div>
          <div className='aircraft-title'>{state.callsign ?? state.hex.toUpperCase()}</div>
          <div className='aircraft-summary muted'>
            {[
              route?.short,
              (tracked.pose?.onGround ?? state.onGround) ? 'On ground' : state.onGround ? 'Touchdown update' : state.altBaro != null ? `${fmt.format(state.altBaro)} ft` : null,
              state.groundSpeed != null ? `${fmt.format(state.groundSpeed)} kt` : null
            ]
              .filter(v => v != null)
              .join(' · ')}
          </div>
          <div className='muted'>
            {[state.registration, state.typeCode].filter(v => v != null).join(' · ') ||
              'Unknown aircraft'}
          </div>
        </div>
        <CloseButton />
      </div>
      {route != null && (
        <div className='aircraft-route' title={route.leg.plausible ? undefined : 'Scheduled route for this callsign; the position doesn’t match it'}>
          <span className='route-codes'>{route.short}</span>
          <span className='muted'>
            {route.long.replace(/ \([A-Z0-9]+\)/g, '')}
            {route.leg.plausible ? '' : ' · unverified'}
          </span>
        </div>
      )}
      <dl className='aircraft-facts'>
        <dt>Altitude</dt>
        <dd>
          {formatAltitude(
            state,
            tracked.pose != null && tracked.groundHeight != null
              ? tracked.pose.height - tracked.groundHeight
              : null,
            tracked.pose?.onGround ?? state.onGround
          )}
        </dd>
        <dt>Ground speed</dt>
        <dd>{state.groundSpeed == null ? '—' : `${fmt.format(state.groundSpeed)} kt`}</dd>
        <dt>Vertical rate</dt>
        <dd>{formatVerticalRate(state.verticalRate)}</dd>
        <dt className='secondary'>Track</dt>
        <dd className='secondary'>{state.track == null ? '—' : `${fmt.format(state.track)}°`}</dd>
        <dt className='secondary'>Squawk</dt>
        <dd className='secondary'>{state.squawk ?? '—'}</dd>
        <dt className='secondary'>ICAO</dt>
        <dd className='secondary'>{state.hex.toUpperCase()}</dd>
        {tracked.groundPrediction != null && <>
          <dt className='secondary'>Ground position</dt>
          <dd>{tracked.groundPrediction === 'holding' ? 'Holding for update' : 'Pavement prediction'}</dd>
        </>}
        <dt className='secondary'>Position age</dt>
        <dd className='secondary'>{ageS.toFixed(0)} s</dd>
      </dl>
      {/* View controls live in the mode bar while following; here only
          the way into a view (or to switch to this aircraft). */}
      {!attached && (
        <div className='aircraft-actions'>
          <button type='button' className='primary' onClick={() => { followAircraft(state.hex) }}>
            {mode === 'globe' ? 'Follow' : 'Follow this one'} <kbd>F</kbd>
          </button>
          <button type='button' onClick={() => { enterWindowView(state.hex) }}>
            Window seat <kbd>W</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

/** Closes the details; if the camera is riding with this aircraft, stops that too. */
const CloseButton: FC = () => (
  <button
    type='button'
    className='icon-button'
    aria-label='Close'
    onClick={() => {
      const { mode, targetHex } = cameraModeStore.get()
      if (mode !== 'globe' && targetHex === selectionStore.get().selectedHex) exitToGlobe()
      selectionStore.set({ selectedHex: null })
    }}
  >
    ×
  </button>
)
