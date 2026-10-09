import { useEffect, useState, type FC } from 'react'

import { config } from '../config'
import { tileStatusStore } from '../globe/tileStatus'
import { useStore } from '../state/createStore'
import { getSimulatedDate, settingsStore } from '../state/settings'

const HOUR = 3_600_000

function formatUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** Re-render once a second so the clock readout stays live. */
function useTicker(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => t + 1)
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [])
}

export const DevPanel: FC = () => {
  const visible = useStore(settingsStore, s => s.showDevPanel)
  const offset = useStore(settingsStore, s => s.timeOffsetMs)
  const exposure = useStore(settingsStore, s => s.exposure)
  const rootLoads = useStore(tileStatusStore, s => s.rootLoads)
  useTicker()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === '`') {
        settingsStore.set(s => ({ showDevPanel: !s.showDevPanel }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!visible) return null

  const offsetHours = offset / HOUR
  return (
    <div className='dev-panel'>
      <div className='dev-panel-title'>
        Dev controls <span className='muted'>(` to toggle)</span>
      </div>

      <label className='dev-row'>
        <span>
          Time offset{' '}
          <b>
            {offsetHours >= 0 ? '+' : ''}
            {offsetHours.toFixed(2)} h
          </b>
        </span>
        <input
          type='range'
          min={-12}
          max={12}
          step={0.25}
          value={offsetHours}
          onChange={e => {
            settingsStore.set({ timeOffsetMs: Number(e.target.value) * HOUR })
          }}
        />
      </label>
      <div className='dev-row dev-inline'>
        <span className='muted'>{formatUtc(getSimulatedDate())}</span>
        <button
          type='button'
          disabled={offset === 0}
          onClick={() => {
            settingsStore.set({ timeOffsetMs: 0 })
          }}
        >
          Live
        </button>
      </div>

      <label className='dev-row'>
        <span>
          Exposure <b>{exposure.toFixed(1)}</b>
        </span>
        <input
          type='range'
          min={1}
          max={60}
          step={0.5}
          value={exposure}
          onChange={e => {
            settingsStore.set({ exposure: Number(e.target.value) })
          }}
        />
      </label>

      <div className='dev-row muted'>
        Tiles:{' '}
        {config.tilesDisabled
          ? 'disabled (ellipsoid)'
          : `Google, root sessions this page: ${rootLoads}`}
      </div>
    </div>
  )
}
