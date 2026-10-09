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

function formatAltitude(state: AircraftState): string {
  if (state.onGround) return 'On ground'
  const parts: string[] = []
  if (state.altBaro != null) parts.push(`${fmt.format(state.altBaro)} ft`)
  if (state.altGeom != null) parts.push(`GNSS ${fmt.format(state.altGeom)} ft`)
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
  const windowSide = useStore(cameraModeStore, s => s.windowSide)
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
    <div className='aircraft-panel'>
      <div className='aircraft-panel-header'>
        <div>
          <div className='aircraft-title'>{state.callsign ?? state.hex.toUpperCase()}</div>
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
        <dd>{formatAltitude(state)}</dd>
        <dt>Ground speed</dt>
        <dd>{state.groundSpeed == null ? '—' : `${fmt.format(state.groundSpeed)} kt`}</dd>
        <dt>Vertical rate</dt>
        <dd>{formatVerticalRate(state.verticalRate)}</dd>
        <dt>Track</dt>
        <dd>{state.track == null ? '—' : `${fmt.format(state.track)}°`}</dd>
        <dt>Squawk</dt>
        <dd>{state.squawk ?? '—'}</dd>
        <dt>ICAO</dt>
        <dd>{state.hex.toUpperCase()}</dd>
        <dt>Position age</dt>
        <dd>{ageS.toFixed(0)} s</dd>
      </dl>
      <div className='aircraft-actions'>
        {attached && mode === 'follow' ? (
          <button type='button' className='primary' onClick={() => { enterWindowView(state.hex) }}>
            Window seat <kbd>W</kbd>
          </button>
        ) : attached && mode === 'window' ? (
          <>
            <button type='button' onClick={() => { followAircraft(state.hex) }}>
              Chase view <kbd>F</kbd>
            </button>
            <button
              type='button'
              onClick={() => {
                cameraModeStore.set({ windowSide: windowSide === 'left' ? 'right' : 'left' })
              }}
            >
              {windowSide === 'left' ? 'Left' : 'Right'} side <kbd>S</kbd>
            </button>
          </>
        ) : (
          <>
            <button type='button' className='primary' onClick={() => { followAircraft(state.hex) }}>
              Follow <kbd>F</kbd>
            </button>
            <button type='button' onClick={() => { enterWindowView(state.hex) }}>
              Window seat <kbd>W</kbd>
            </button>
          </>
        )}
        {attached && (
          <button type='button' onClick={exitToGlobe}>
            Exit <kbd>Esc</kbd>
          </button>
        )}
      </div>
    </div>
  )
}

const CloseButton: FC = () => (
  <button
    type='button'
    className='icon-button'
    aria-label='Close'
    onClick={() => {
      selectionStore.set({ selectedHex: null })
    }}
  >
    ×
  </button>
)
