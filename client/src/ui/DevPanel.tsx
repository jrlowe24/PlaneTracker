import { useEffect, useState, type FC } from 'react'

import { config } from '../config'
import { flightStatusStore } from '../data/flightConnection'
import { cloudCoverStore } from '../clouds/cloudCoverStore'
import { weatherStore } from '../data/weather'
import { tileStatusStore } from '../globe/tileStatus'
import { nightEmission } from '../nightLights/nightLightsStore'
import { nightState } from '../scene/nightLighting'
import type { BenchResult } from '../dev/DevBench'
import { setViewSolarHours } from '../state/skyTime'
import { resolutionStore } from '../state/resolution'
import { qualityStore, setQualityElement } from '../state/quality'
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
  const [bench, setBench] = useState<BenchResult | 'running' | null>(null)
  const resolution = useStore(resolutionStore, s => s)
  const hazeQuality = useStore(qualityStore, s => s.elements.cityAtmosphere)
  const visible = useStore(settingsStore, s => s.showDevPanel)
  const offset = useStore(settingsStore, s => s.timeOffsetMs)
  const exposure = useStore(settingsStore, s => s.exposure)
  const delayMs = useStore(settingsStore, s => s.interpolationDelayMs)
  const coverage = useStore(settingsStore, s => s.cloudCoverage)
  const cloudSource = useStore(settingsStore, s => s.cloudSource)
  const weatherPrototype = useStore(settingsStore, s => s.weatherPrototype)
  const precipitation = useStore(settingsStore, s => s.precipitation)
  const waterMaterial = useStore(settingsStore, s => s.waterMaterial)
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
      {import.meta.env.DEV && <div className='dev-row'>
        <label>Lighting test view
          <select aria-label='Lighting test view' defaultValue='' onChange={e => {
            const views: Record<string, number[]> = {
              reference: [47.606, -122.335, 35, -18, 5200],
              close: [47.606, -122.335, 35, -20, 2400],
              far: [47.606, -122.335, 35, -20, 14000],
              airport: [47.449, -122.309, 20, -25, 3500],
              rural: [47.75, -121.9, 20, -20, 8000],
              orbit: [47.606, -122.335, 0, -90, 2e7]
            }
            const v = views[e.target.value]
            const w = window as Window & { __windowSeatView?: (...args: number[]) => void }
            if (v != null) w.__windowSeatView?.(...v)
          }}>
            <option value=''>Choose view</option>
            <option value='reference'>Seattle reference</option>
            <option value='close'>Seattle close</option>
            <option value='far'>Seattle distant</option>
            <option value='airport'>SeaTac airport</option>
            <option value='rural'>Rural foothills</option>
            <option value='orbit'>Whole Earth</option>
          </select>
        </label>
        <div className='dev-inline'>
          {[12.5, 21, 3].map(hour => <button key={hour} onClick={() => setViewSolarHours(hour)}>{hour === 12.5 ? 'Test day' : hour === 21 ? 'Test evening' : 'Test late night'}</button>)}
        </div>
        <label>City haze test
          <select aria-label='City haze test' value={hazeQuality} onChange={e => setQualityElement('cityAtmosphere', e.target.value as 'off' | 'low' | 'high')}>
            <option value='off'>Off</option><option value='low'>Low</option><option value='high'>High</option>
          </select>
        </label>
        <label><input type='checkbox' checked={resolution.locked} onChange={e => resolutionStore.set({ locked: e.target.checked })} /> Hold render resolution</label>
        <span>{Math.round(resolution.scale * 100)}% render scale · {resolution.tileFactor.toFixed(2)} terrain factor</span>
        <button disabled={bench === 'running'} onClick={async () => {
          const w = window as Window & { __windowSeatBench?: (frames: number) => Promise<BenchResult> }
          if (w.__windowSeatBench == null) return
          setBench('running')
          try { setBench(await w.__windowSeatBench(60)) } catch { setBench(null) }
        }}>Benchmark 60 frames</button>
        <output>{bench === 'running' ? 'Benchmark running' : bench == null ? '' : `${bench.meanMs} ms mean · ${bench.p95Ms} ms p95 · ${bench.fps} fps`}</output>
      </div>}

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
      <label className='dev-row dev-inline'>
        <span>Semantic procedural water</span>
        <input
          type='checkbox'
          checked={waterMaterial}
          onChange={event => {
            settingsStore.set({ waterMaterial: event.target.checked })
          }}
        />
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
