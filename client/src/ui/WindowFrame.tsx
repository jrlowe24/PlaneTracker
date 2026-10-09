import type { FC } from 'react'

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
  return (
    <div
      className={`window-overlay${visible ? ' visible' : ''}${visible && !transitioning ? ' settled' : ''}`}
      aria-hidden
    >
      <div className='window-bezel'>
        <div className='window-pane' />
      </div>
    </div>
  )
}
