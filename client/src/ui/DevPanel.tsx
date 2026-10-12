import { useEffect, useState, type FC } from 'react'

import { config } from '../config'
import { flightStatusStore } from '../data/flightConnection'
import { cloudCoverStore } from '../clouds/cloudCoverStore'
import { weatherStore } from '../data/weather'
import { tileStatusStore } from '../globe/tileStatus'
import { nightEmission } from '../nightLights/nightLightsStore'
import { nightState } from '../scene/nightLighting'
import { useStore } from '../state/createStore'
import {
  getSimulatedDate,
  settingsStore,
  setWeatherPrototype,
  type WeatherPrototype
} from '../state/settings'

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
  const delayMs = useStore(settingsStore, s => s.interpolationDelayMs)
  const coverage = useStore(settingsStore, s => s.cloudCoverage)
  const cloudSource = useStore(settingsStore, s => s.cloudSource)
  const weatherPrototype = useStore(settingsStore, s => s.weatherPrototype)
  const precipitation = useStore(settingsStore, s => s.precipitation)
  const weather = useStore(weatherStore, s => s.sample)
  const cover = useStore(cloudCoverStore, s => s)
  const aircraftCount = useStore(flightStatusStore, s => s.aircraftCount)
  const source = useStore(flightStatusStore, s => s.source)
  const connection = useStore(flightStatusStore, s => s.status)
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

      <label className='dev-row'>
        <span>
          Interpolation delay <b>{(delayMs / 1000).toFixed(1)} s</b>
        </span>
        <input
          type='range'
          min={0}
          max={20}
          step={0.5}
          value={delayMs / 1000}
          onChange={e => {
            settingsStore.set({ interpolationDelayMs: Number(e.target.value) * 1000 })
          }}
        />
      </label>

      {weatherPrototype === 'live' && (
        <label className='dev-row dev-inline'>
          <span>Clouds from live weather</span>
          <input
            type='checkbox'
            checked={cloudSource === 'weather'}
            onChange={e => {
              settingsStore.set({ cloudSource: e.target.checked ? 'weather' : 'manual' })
            }}
          />
        </label>
      )}
      <label className='dev-row'>
        <span>Weather laboratory</span>
        <select
          value={weatherPrototype}
          onChange={e => {
            setWeatherPrototype(e.target.value as WeatherPrototype)
          }}
        >
          <option value='live'>Regular weather settings</option>
          <option value='clear'>Clear</option>
          <option value='fair'>Fair</option>
          <option value='overcast'>Overcast</option>
        </select>
      </label>
      {weatherPrototype !== 'live' && (
        <div className='dev-row muted'>
          Generated lab scene is controlling every cloud layer. The regular Weather setting is
          temporarily ignored.
        </div>
      )}
      <label className='dev-row'>
        <span>Rain laboratory</span>
        <select
          value={precipitation}
          onChange={e => {
            settingsStore.set({
              precipitation: e.target.value as 'auto' | 'force' | 'off'
            })
          }}
        >
          <option value='auto'>Live forecast</option>
          <option value='force'>Force rain here</option>
          <option value='off'>Off</option>
        </select>
      </label>
      {weatherPrototype !== 'live' ? (
        <div className='dev-row muted'>
          Generated cover: low {Math.round(cover.low * 100)}% · mid{' '}
          {Math.round(cover.mid * 100)}% · high {Math.round(cover.high * 100)}%
        </div>
      ) : cloudSource === 'weather' ? (
        <div className='dev-row muted'>
          {weather == null
            ? 'Waiting for weather…'
            : `Cloud cover here low ${Math.round(cover.low * 100)}% · mid ${Math.round(cover.mid * 100)}% · high ${Math.round(cover.high * 100)}%${cover.conv > 0.005 ? ` · towers ${Math.round(cover.conv * 100)}%` : ''}${cover.regional ? ' (blended grid)' : ''} · ${weather.temperature.toFixed(0)}/${weather.dewPoint.toFixed(0)} °C`}
        </div>
      ) : (
        <label className='dev-row'>
          <span>
            Cloud coverage <b>{coverage.toFixed(2)}</b>
          </span>
          <input
            type='range'
            min={0}
            max={1}
            step={0.05}
            value={coverage}
            onChange={e => {
              settingsStore.set({ cloudCoverage: Number(e.target.value) })
            }}
          />
        </label>
      )}

      <div className='dev-row muted'>
        Flights: {source ?? '—'} ({connection}), {aircraftCount} aircraft
      </div>
      <div className='dev-row muted'>
        Tiles:{' '}
        {config.tilesDisabled
          ? 'disabled (ellipsoid)'
          : `Google, root sessions this page: ${rootLoads}`}
      </div>
      <div className='dev-row muted'>
        Night lights:{' '}
        {nightEmission.baseMap == null
          ? 'loading / unavailable'
          : nightEmission.enabled
            ? `active (night ${Math.round(nightState.night * 100)}%)`
            : `loaded, inactive (night ${Math.round(nightState.night * 100)}%)`}
      </div>
    </div>
  )
}
