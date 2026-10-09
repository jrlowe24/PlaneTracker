import { useEffect, useState, type FC } from 'react'

import { config } from '../config'
import { flightStatusStore } from '../data/flightConnection'
import { getGoogleTiles } from '../globe/googleTiles'
import { useStore } from '../state/createStore'

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

/** Attribution required by the active flight data source (adsb.lol: ODbL). */
const FlightDataAttribution: FC = () => {
  const attribution = useStore(flightStatusStore, s => s.attribution)
  const url = useStore(flightStatusStore, s => s.attributionUrl)
  if (attribution == null) return null
  return (
    <div className='attribution-flight'>
      {url != null ? (
        <a href={url} target='_blank' rel='noreferrer'>
          {attribution}
        </a>
      ) : (
        attribution
      )}
    </div>
  )
}

export const Attribution: FC = () => (
  <div className='attribution'>
    <FlightDataAttribution />
    {config.tilesDisabled ? (
      <div className='attribution-note'>
        Google 3D tiles disabled ({config.tilesDisabledReason})
      </div>
    ) : (
      <GoogleAttribution />
    )}
  </div>
)
