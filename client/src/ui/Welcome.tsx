import { useEffect, useState, type FC } from 'react'

import { flightStatusStore } from '../data/flightConnection'
import { useStore } from '../state/createStore'
import { SettingsButton } from './SettingsPanel'

const SEEN_KEY = 'window-seat.welcome-seen'

function seenBefore(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Private mode etc.: show it again next time, harmless.
  }
}

const isTouch = (): boolean => window.matchMedia?.('(pointer: coarse)').matches ?? false

/**
 * What this is and how to use it: shown on the first visit, reopenable from
 * the "?" button.
 */
export const Welcome: FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  const touch = isTouch()
  return (
    <div className='welcome-backdrop' onClick={onClose}>
      <div
        className='welcome'
        role='dialog'
        aria-modal='true'
        aria-labelledby='welcome-title'
        onClick={e => {
          e.stopPropagation()
        }}
      >
        <h1 id='welcome-title'>Window Seat</h1>
        <p className='welcome-lede'>
          Live air traffic on a photorealistic 3D Earth. Every plane here is a real flight in the sky
          right now, from community ADS-B receivers.
        </p>
        <ol className='welcome-steps'>
          <li>
            <b>Find a plane.</b> {touch ? 'Tap' : 'Click'} one on the map, or pick one from the list
            (planes near you come first; search any flight worldwide).
          </li>
          <li>
            <b>Follow it.</b> The camera flies in behind the aircraft and tracks it live.
          </li>
          <li>
            <b>Take the window seat.</b> See the world from a passenger window as it flies, by day or
            night, through real-time weather.
          </li>
        </ol>
        <div className='welcome-controls'>
          {touch ? (
            <span>Drag to look around · pinch to zoom · two-finger drag to tilt</span>
          ) : (
            <span>
              Drag to rotate · scroll to zoom · <kbd>F</kbd> follow · <kbd>W</kbd> window seat ·{' '}
              <kbd>S</kbd> switch side · <kbd>Esc</kbd> back
            </span>
          )}
        </div>
        <p className='welcome-hint'>
          Change the time of day, weather and graphics quality with the{' '}
          <span className='welcome-sun' aria-hidden>☀︎</span> button at the top.
        </p>
        <button type='button' className='welcome-start' onClick={onClose}>
          Start exploring
        </button>
        <p className='welcome-fine muted'>
          Positions can lag a few seconds; not for navigation. Imagery © Google; flight data
          adsb.lol (ODbL) and adsb.fi; weather Open-Meteo; night lights NASA.
        </p>
      </div>
    </div>
  )
}

/** Title chip with live status (opens Welcome), and the settings button. */
export const TopBar: FC = () => {
  const [open, setOpen] = useState(() => !seenBefore())
  const count = useStore(flightStatusStore, s => s.aircraftCount)
  const status = useStore(flightStatusStore, s => s.status)
  const close = (): void => {
    markSeen()
    setOpen(false)
  }
  return (
    <>
      <div className='top-bar'>
        <button
          type='button'
          className='brand'
          onClick={() => {
            setOpen(true)
          }}
          aria-label='About Window Seat'
        >
          <span className={`live-dot${status === 'open' ? ' on' : ''}`} />
          <span className='brand-name'>Window Seat</span>
          <span className='brand-count muted'>
            {status === 'open' ? `${count} live` : 'connecting…'}
          </span>
          <span className='brand-help' aria-hidden>
            ?
          </span>
        </button>
        <SettingsButton />
      </div>
      <Welcome open={open} onClose={close} />
    </>
  )
}
