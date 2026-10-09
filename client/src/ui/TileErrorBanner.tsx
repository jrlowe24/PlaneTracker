import type { FC } from 'react'

import { tileStatusStore } from '../globe/tileStatus'
import { useStore } from '../state/createStore'

export const TileErrorBanner: FC = () => {
  const error = useStore(tileStatusStore, s => s.error)
  if (error == null) return null
  return (
    <div className='banner banner-error' role='alert'>
      <strong>Google 3D tiles failed to load.</strong> {error}
      <div className='banner-hint'>
        Check that VITE_GOOGLE_MAPS_API_KEY is valid, the Map Tiles API is
        enabled, and the key's HTTP-referrer restriction allows this origin.
      </div>
    </div>
  )
}
