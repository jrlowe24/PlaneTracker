import { useEffect, useState, type FC } from 'react'

import { config } from '../config'
import { getGoogleTiles } from '../globe/googleTiles'

/**
 * Data attribution, visible at all times.
 *
 * Google requires the Google Maps logo plus the copyright strings of every
 * displayed tile, aggregated and sorted by frequency on one line. The tiles'
 * `asset.copyright` values are collected by GoogleCloudAuthPlugin and exposed
 * via TilesRenderer.getAttributions().
 */
const GoogleAttribution: FC = () => {
  const [credits, setCredits] = useState('')

  useEffect(() => {
    const tiles = getGoogleTiles({ apiKey: config.googleMapsApiKey })
    let queued = false
    const update = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        const text = tiles
          .getAttributions()
          .filter(a => a.type === 'string')
          .map(a => String(a.value))
          .filter(value => value !== '')
          .join('; ')
        setCredits(text)
      })
    }
    tiles.addEventListener('tile-visibility-change', update)
    tiles.addEventListener('load-tileset', update)
    update()
    return () => {
      tiles.removeEventListener('tile-visibility-change', update)
      tiles.removeEventListener('load-tileset', update)
    }
  }, [])

  return (
    <div className='attribution-google'>
      <img
        className='google-logo'
        src='/attribution/google.png'
        alt='Google'
        draggable={false}
      />
      {credits !== '' && <span className='credits'>{credits}</span>}
    </div>
  )
}

export const Attribution: FC = () => (
  <div className='attribution'>
    {config.tilesDisabled ? (
      <div className='attribution-note'>
        Google 3D tiles disabled ({config.tilesDisabledReason})
      </div>
    ) : (
      <GoogleAttribution />
    )}
  </div>
)
