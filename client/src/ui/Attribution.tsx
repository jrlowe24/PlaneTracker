import { useCallback, useEffect, useRef, useState, type FC } from 'react'

import { config } from '../config'
import { flightStatusStore } from '../data/flightConnection'
import { getGoogleTiles } from '../globe/googleTiles'
import { weatherStore } from '../data/weather'
import { nightLightsStore } from '../nightLights/nightLightsStore'
import { cameraModeStore } from '../state/cameraMode'
import { qualityStore } from '../state/quality'
import { settingsStore } from '../state/settings'
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

/** NASA Black Marble while city lights are visible. */
const NightLightsCredit: FC = () => {
  const credit = useStore(nightLightsStore, s => s.credit)
  const streets = useStore(nightLightsStore, s => s.streets)
  if (credit == null) return null
  return (
    <>
      {' · '}
      <a href='https://science.nasa.gov/earth/earth-observatory/earth-at-night/' target='_blank' rel='noreferrer'>
        {credit}
      </a>
      {streets && (
        <>
          {' · '}
          <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noreferrer'>
            Street lights © OpenStreetMap contributors
          </a>{' '}
          (<a href='https://openfreemap.org' target='_blank' rel='noreferrer'>OpenFreeMap</a>)
        </>
      )}
    </>
  )
}

/** OpenStreetMap/OpenFreeMap while their semantic water mask is active. */
const WaterCredit: FC = () => {
  const enabled = useStore(settingsStore, s => s.waterMaterial)
  if (!enabled || config.tilesDisabled) return null
  return (
    <div className='attribution-flight'>
      Water ©{' '}
      <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noreferrer'>
        OpenStreetMap contributors
      </a>{' '}
      (<a href='https://openfreemap.org' target='_blank' rel='noreferrer'>OpenFreeMap</a>)
    </div>
  )
}

/** Open-Meteo (CC BY 4.0) while live weather drives the clouds. */
const WeatherCredit: FC = () => {
  const attribution = useStore(weatherStore, s => s.attribution)
  const live = useStore(settingsStore, s => s.cloudSource === 'weather')
  const clouds = useStore(qualityStore, s => s.settings.clouds !== false)
  if (attribution == null || !live || !clouds) return null
  return (
    <>
      {' · '}
      {attribution.url != null ? (
        <a href={attribution.url} target='_blank' rel='noreferrer'>
          {attribution.text}
        </a>
      ) : (
        attribution.text
      )}
    </>
  )
}

/** Attribution required by the active flight data source (adsb.lol: ODbL). */
const FlightDataAttribution: FC = () => {
  const attribution = useStore(flightStatusStore, s => s.attribution)
  const url = useStore(flightStatusStore, s => s.attributionUrl)
  const follow = useStore(flightStatusStore, s => s.followAttribution)
  const overview = useStore(flightStatusStore, s => s.overviewAttribution)
  const following = useStore(cameraModeStore, s => s.mode !== 'globe')
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
      {overview != null && (
        <>
          {' · '}
          <a href={overview.url ?? undefined} target='_blank' rel='noreferrer'>
            {overview.text}
          </a>
        </>
      )}
      <WeatherCredit />
      <NightLightsCredit />
      {following && follow != null && (
        <>
          {' · '}
          {follow.url != null ? (
            <a href={follow.url} target='_blank' rel='noreferrer'>
              {follow.text}
            </a>
          ) : (
            follow.text
          )}
        </>
      )}
    </div>
  )
}

/**
 * Publishes the attribution's height as --attribution-h, so bottom UI
 * (phone sheet, view bar) always sits above it, however many lines the
 * credits wrap to.
 */
function useHeightVariable(): (element: HTMLDivElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null)
  return useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (element == null) return
    observer.current = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--attribution-h', `${element.offsetHeight}px`)
    })
    observer.current.observe(element)
  }, [])
}

/**
 * On phones the credits are one short row (logo, then the text on a single
 * line, cut off with an ellipsis); tapping the text shows it all.
 */
export const Attribution: FC = () => {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={`attribution${expanded ? ' expanded' : ''}`}
      ref={useHeightVariable()}
      onClick={event => {
        if ((event.target as HTMLElement).closest('a') == null) setExpanded(e => !e)
      }}
    >
      <FlightDataAttribution />
      <WaterCredit />
      {config.tilesDisabled ? (
        <div className='attribution-note'>
          Google 3D tiles disabled ({config.tilesDisabledReason})
        </div>
      ) : (
        <GoogleAttribution />
      )}
    </div>
  )
}
