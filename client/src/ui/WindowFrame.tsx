import { useEffect, useState, type FC } from 'react'

import { nightState } from '../scene/nightLighting'

import { cameraModeStore } from '../state/cameraMode'
import { useStore } from '../state/createStore'

/**
 * Passenger-window overlay for the window view: cabin wall with a rounded
 * window cutout, a soft inner shadow around the opening and a faint
 * reflection on the inner pane. Pointer events pass through to the canvas
 * (mouse-look).
 */
export const WindowFrame: FC = () => {
  const mode = useStore(cameraModeStore, s => s.mode)
  const transitioning = useStore(cameraModeStore, s => s.transitioning)
  const visible = mode === 'window'
  // The cabin is dim at night (cabin lights down for night flights).
  const [night, setNight] = useState(0)
  useEffect(() => {
    if (!visible) return
    const id = setInterval(() => {
      setNight(Math.round(nightState.night * 20) / 20)
    }, 500)
    return () => {
      clearInterval(id)
    }
  }, [visible])
  return (
    <div
      className={`window-overlay${visible ? ' visible' : ''}${visible && !transitioning ? ' settled' : ''}`}
      style={{ filter: `brightness(${1 - 0.82 * night})` }}
      aria-hidden
    >
      <div className='window-bezel'>
        <div className='window-pane' />
      </div>
    </div>
  )
}
