import { useEffect, useState, type FC, type ReactNode } from 'react'

import { cloudCoverStore } from '../clouds/cloudCoverStore'
import { useStore } from '../state/createStore'
import { qualityStore, setQualityChoice, type QualityLevel } from '../state/quality'
import { resolutionStore } from '../state/resolution'
import { settingsStore } from '../state/settings'
import { formatHours, setViewSolarHours, timePresets, viewSolarHours } from '../state/skyTime'
import { uiStore } from '../state/ui'
import { useIsPhone } from './useMedia'
import { useSheetDrag } from './useSheetDrag'

/** Weather choices: live forecast, or a fixed cloud cover everywhere. */
const WEATHER: Array<{ id: string; label: string; coverage: number | null }> = [
  { id: 'live', label: 'Live', coverage: null },
  { id: 'clear', label: 'Clear', coverage: 0 },
  { id: 'fair', label: 'Fair', coverage: 0.3 },
  { id: 'cloudy', label: 'Cloudy', coverage: 0.6 },
  { id: 'overcast', label: 'Overcast', coverage: 0.95 }
]

const QUALITY: Array<{ id: QualityLevel | 'auto'; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

const LEVEL_LABELS: Record<QualityLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Re-render periodically (the clock and the view's longitude move). */
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

const Segmented: FC<{
  label: string
  options: Array<{ id: string; label: ReactNode }>
  value: string | null
  onChange: (id: string) => void
}> = ({ label, options, value, onChange }) => (
  <div className='segmented' role='radiogroup' aria-label={label}>
    {options.map(option => (
      <button
        key={option.id}
        type='button'
        role='radio'
        aria-checked={value === option.id}
        className={value === option.id ? 'active' : ''}
        onClick={() => {
          onChange(option.id)
        }}
      >
        {option.label}
      </button>
    ))}
  </div>
)

const TimeSection: FC = () => {
  const offset = useStore(settingsStore, s => s.timeOffsetMs)
  useTicker(1000)
  const hours = viewSolarHours()
  const presets = timePresets()
  const live = offset === 0
  // Which preset (if any) the current time matches.
  const active = live ? 'live' : (presets.find(p => Math.abs(((p.hours - hours + 36) % 24) - 12) < 0.05)?.id ?? null)
  return (
    <section className='settings-group'>
      <div className='settings-label'>
        <span>Time of day</span>
        <span className='settings-value'>
          {formatHours(hours)} local{live ? ' · live' : ''}
        </span>
      </div>
      <input
        className='time-slider'
        type='range'
        min={0}
        max={24}
        step={0.25}
        value={hours}
        aria-label='Local time where you are looking'
        onChange={e => {
          setViewSolarHours(Number(e.target.value))
        }}
      />
      <Segmented
        label='Time presets'
        options={[{ id: 'live', label: 'Now' }, ...presets]}
        value={active}
        onChange={id => {
          if (id === 'live') settingsStore.set({ timeOffsetMs: 0 })
          else setViewSolarHours(presets.find(p => p.id === id)!.hours)
        }}
      />
    </section>
  )
}

const WeatherSection: FC = () => {
  const source = useStore(settingsStore, s => s.cloudSource)
  const coverage = useStore(settingsStore, s => s.cloudCoverage)
  const cover = useStore(cloudCoverStore, s => s)
  const active =
    source === 'weather'
      ? 'live'
      : (WEATHER.find(w => w.coverage != null && Math.abs(w.coverage - coverage) < 0.01)?.id ?? null)
  const here = Math.round(Math.max(cover.low, cover.mid) * 100)
  return (
    <section className='settings-group'>
      <div className='settings-label'>
        <span>Weather</span>
        <span className='settings-value'>
          {source === 'weather' ? `Live forecast · ${here}% cloud here` : 'Same everywhere'}
        </span>
      </div>
      <Segmented
        label='Weather'
        options={WEATHER}
        value={active}
        onChange={id => {
          const choice = WEATHER.find(w => w.id === id)!
          if (choice.coverage == null) settingsStore.set({ cloudSource: 'weather' })
          else settingsStore.set({ cloudSource: 'manual', cloudCoverage: choice.coverage })
        }}
      />
    </section>
  )
}

const QualitySection: FC = () => {
  const choice = useStore(qualityStore, s => s.choice)
  const level = useStore(qualityStore, s => s.level)
  const scale = useStore(resolutionStore, s => s.scale)
  const tileFactor = useStore(resolutionStore, s => s.tileFactor)
  const adapted = scale < 0.999 || tileFactor > 1.001
  return (
    <section className='settings-group'>
      <div className='settings-label'>
        <span>Graphics</span>
        <span className='settings-value'>
          {choice === 'auto' ? `Auto · ${LEVEL_LABELS[level]}` : LEVEL_LABELS[level]}
          {adapted && ` · ${Math.round(scale * 100)}% res`}
        </span>
      </div>
      <Segmented
        label='Graphics quality'
        options={QUALITY}
        value={choice}
        onChange={id => {
          setQualityChoice(id as QualityLevel | 'auto')
        }}
      />
      <p className='settings-note'>
        Resolution adapts automatically to keep it smooth. Low suits phones and saves battery.
      </p>
    </section>
  )
}

/**
 * Time of day, weather and graphics. A popover under the top bar on
 * desktop; a bottom sheet on phones (swipe down or tap outside to close).
 */
export const SettingsPanel: FC = () => {
  const open = useStore(uiStore, s => s.settingsOpen)
  const phone = useIsPhone()
  const close = (): void => {
    uiStore.set({ settingsOpen: false })
  }
  const { offset, handlers } = useSheetDrag(({ dy, velocity }) => {
    if (dy > 80 || velocity > 0.5) close()
  })
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  if (!open) return null
  return (
    <>
      <div className={`settings-backdrop${phone ? ' dim' : ''}`} onClick={close} />
      <div
        className='settings-sheet'
        role='dialog'
        aria-label='View settings'
        style={offset != null && offset > 0 ? { transform: `translateY(${offset}px)`, transition: 'none' } : undefined}
      >
        <div className='settings-header' {...(phone ? handlers : {})}>
          {phone && <div className='sheet-grip' aria-hidden />}
          <h2>View</h2>
          <button type='button' className='settings-done' onClick={close}>
            Done
          </button>
        </div>
        <TimeSection />
        <WeatherSection />
        <QualitySection />
      </div>
    </>
  )
}

/** Opens the settings: shows the local time at the view and a sun/moon. */
export const SettingsButton: FC = () => {
  const offset = useStore(settingsStore, s => s.timeOffsetMs)
  useTicker(5000)
  const hours = viewSolarHours()
  const day = hours > 6.5 && hours < 18.5
  return (
    <button
      type='button'
      className={`settings-button${offset !== 0 ? ' changed' : ''}`}
      aria-label='Time of day, weather and graphics'
      onClick={() => {
        uiStore.set(s => ({ settingsOpen: !s.settingsOpen }))
      }}
    >
      <svg viewBox='0 0 24 24' width='18' height='18' aria-hidden>
        {day ? (
          <g fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
            <circle cx='12' cy='12' r='4.2' fill='currentColor' />
            {[0, 45, 90, 135, 180, 225, 270, 315].map(a => (
              <line
                key={a}
                x1={12 + 7.2 * Math.cos((a * Math.PI) / 180)}
                y1={12 + 7.2 * Math.sin((a * Math.PI) / 180)}
                x2={12 + 9.6 * Math.cos((a * Math.PI) / 180)}
                y2={12 + 9.6 * Math.sin((a * Math.PI) / 180)}
              />
            ))}
          </g>
        ) : (
          <path d='M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z' fill='currentColor' />
        )}
      </svg>
      <span className='settings-button-time'>{formatHours(hours)}</span>
    </button>
  )
}
