import { useEffect, useState, type FC } from 'react'

import { cameraModeStore, exitToGlobe } from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { selectionStore } from '../state/selection'
import { AircraftList } from './AircraftList'
import { AircraftPanel } from './AircraftPanel'
import { useSheetDrag } from './useSheetDrag'

type Snap = 'peek' | 'half' | 'full'

/** Sheet heights (px) for the window height. */
function heights(viewport: number): Record<Snap, number> {
  return {
    peek: 128,
    half: Math.round(viewport * 0.48),
    full: Math.round(viewport - 150)
  }
}

function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = (): void => {
      setHeight(window.innerHeight)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return height
}

/**
 * Phones: everything about aircraft lives in one bottom sheet, like a maps
 * app. Browsing, it holds search and the nearby list and snaps between
 * peek, half and full height (drag the grabber or tap it). With an aircraft
 * selected it shows its details (swipe down to close). While riding with
 * an aircraft only a compact card sits above the view bar.
 */
export const PhoneSheet: FC = () => {
  const selectedHex = useStore(selectionStore, s => s.selectedHex)
  const mode = useStore(cameraModeStore, s => s.mode)
  const viewport = useViewportHeight()
  const [snap, setSnap] = useState<Snap>('peek')
  const sizes = heights(viewport)

  // Back to the small sheet whenever the camera starts riding with a plane,
  // so the list doesn't cover the view when you come back.
  const [lastMode, setLastMode] = useState(mode)
  if (mode !== lastMode) {
    setLastMode(mode)
    if (mode !== 'globe') setSnap('peek')
  }

  const closeDetails = (): void => {
    const camera = cameraModeStore.get()
    if (camera.mode !== 'globe' && camera.targetHex === selectionStore.get().selectedHex) exitToGlobe()
    selectionStore.set({ selectedHex: null })
  }

  const showingDetails = selectedHex != null
  const list = useSheetDrag(
    ({ dy, velocity }) => {
      // Project the release a little along its velocity, then snap.
      const target = sizes[snap] - dy - velocity * 180
      const order: Snap[] = ['peek', 'half', 'full']
      let best: Snap = 'peek'
      for (const s of order) if (Math.abs(sizes[s] - target) < Math.abs(sizes[best] - target)) best = s
      setSnap(best)
    },
    () => {
      setSnap(s => (s === 'peek' ? 'half' : 'peek'))
    }
  )
  const details = useSheetDrag(({ dy, velocity }) => {
    if (dy > 70 || velocity > 0.5) closeDetails()
  })

  if (mode !== 'globe') {
    return selectedHex == null ? null : (
      <div className='phone-follow-card'>
        <AircraftPanel />
      </div>
    )
  }

  if (showingDetails) {
    const offset = details.offset != null ? Math.max(0, details.offset) : 0
    return (
      <div
        className='phone-sheet details'
        style={offset > 0 ? { transform: `translateY(${offset}px)`, transition: 'none' } : undefined}
      >
        <div className='sheet-grab' {...details.handlers}>
          <div className='sheet-grip' />
        </div>
        <AircraftPanel />
      </div>
    )
  }

  const live = list.offset == null ? null : Math.min(sizes.full, Math.max(80, sizes[snap] - list.offset))
  return (
    <div
      className={`phone-sheet list snap-${snap}`}
      style={{ height: live ?? sizes[snap], transition: live != null ? 'none' : undefined }}
    >
      <div className='sheet-grab' {...list.handlers}>
        <div className='sheet-grip' />
      </div>
      <AircraftList
        sheet
        onSearchFocus={() => {
          setSnap('full')
        }}
      />
    </div>
  )
}
