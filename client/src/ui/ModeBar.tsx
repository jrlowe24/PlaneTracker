import type { FC } from 'react'

import { flightConnection } from '../data/flightConnection'
import { cameraModeStore, enterWindowView, exitToGlobe, followAircraft } from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { selectionStore } from '../state/selection'

/**
 * While the camera rides with an aircraft: which one, and the views —
 * Chase, Window seat (with side), and Free look (back to moving the camera
 * yourself). Always visible in those modes, even with the details closed;
 * the callsign reopens the details.
 */
export const ModeBar: FC = () => {
  const mode = useStore(cameraModeStore, s => s.mode)
  const targetHex = useStore(cameraModeStore, s => s.targetHex)
  const windowSide = useStore(cameraModeStore, s => s.windowSide)
  if (mode === 'globe' || targetHex == null) return null
  const state = flightConnection.registry.byHex.get(targetHex)?.state
  const label = state?.callsign ?? state?.registration ?? targetHex.toUpperCase()
  return (
    <div className='mode-bar' role='toolbar' aria-label='Camera view'>
      <button
        type='button'
        className='mode-target'
        title='Show details'
        onClick={() => {
          selectionStore.set({ selectedHex: targetHex })
        }}
      >
        <span className='mode-dot' />
        {label}
      </button>
      <div className='mode-segments'>
        <button
          type='button'
          className={mode === 'follow' ? 'active' : ''}
          aria-pressed={mode === 'follow'}
          onClick={() => {
            followAircraft(targetHex)
          }}
        >
          Chase <kbd>F</kbd>
        </button>
        <button
          type='button'
          className={mode === 'window' ? 'active' : ''}
          aria-pressed={mode === 'window'}
          onClick={() => {
            if (mode === 'window') {
              cameraModeStore.set({ windowSide: windowSide === 'left' ? 'right' : 'left' })
            } else {
              enterWindowView(targetHex)
            }
          }}
          title={mode === 'window' ? 'Switch side (S)' : 'Window seat (W)'}
        >
          {mode === 'window' ? `Window · ${windowSide}` : 'Window'} <kbd>{mode === 'window' ? 'S' : 'W'}</kbd>
        </button>
        <button type='button' onClick={exitToGlobe} title='Back to moving the camera yourself (Esc)'>
          Free look <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  )
}
