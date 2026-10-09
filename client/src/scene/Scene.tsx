import { useFrame, useThree } from '@react-three/fiber'
import {
  Atmosphere,
  Sky,
  Stars,
  type AtmosphereApi
} from '@takram/three-atmosphere/r3f'
import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import type { GlobeControls as GlobeControlsImpl } from '3d-tiles-renderer'
import { GlobeControls } from '3d-tiles-renderer/r3f'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC
} from 'react'
import type { Object3D } from 'three'

import { config } from '../config'
import { EllipsoidGlobe } from '../globe/EllipsoidGlobe'
import { GoogleTilesGlobe } from '../globe/GoogleTilesGlobe'
import { getSimulatedDate } from '../state/settings'
import { PostEffects } from './PostEffects'

/** Default view: over Lake Washington, looking west across downtown Seattle to the Olympics. */
const DEFAULT_VIEW = {
  latitude: 47.6062,
  longitude: -122.3321,
  heading: 150,
  pitch: -18,
  distance: 9000
}

/**
 * `?view=lat,lon,heading,pitch,distance` (degrees / meters) overrides the
 * initial camera, e.g. `?view=0,0,0,-90,2e7` for a whole-Earth view.
 */
function getInitialView(): typeof DEFAULT_VIEW {
  const raw = new URLSearchParams(window.location.search).get('view')
  const values = raw?.split(',').map(Number) ?? []
  if (values.length !== 5 || values.some(v => !Number.isFinite(v))) {
    return DEFAULT_VIEW
  }
  const [latitude, longitude, heading, pitch, distance] = values as [
    number,
    number,
    number,
    number,
    number
  ]
  return { latitude, longitude, heading, pitch, distance }
}

const GlobeAndControls: FC = () => {
  const [ground, setGround] = useState<Object3D | null>(null)
  const onGround = useCallback((object: Object3D | null) => {
    setGround(object)
  }, [])

  const controls = useThree(
    ({ controls }) => controls as GlobeControlsImpl | null
  )
  // GlobeControls adjusts the camera height against very coarse LoD tiles
  // during the initial load, which can make the camera jump into the sky.
  // Re-enable it on the first user interaction (as takram's examples do).
  useEffect(() => {
    if (controls == null) return
    const onStart = (): void => {
      controls.adjustHeight = true
      controls.removeEventListener('start', onStart)
    }
    controls.addEventListener('start', onStart)
    return () => {
      controls.removeEventListener('start', onStart)
    }
  }, [controls])

  return (
    <>
      {config.tilesDisabled ? (
        <EllipsoidGlobe onGround={onGround} />
      ) : (
        <GoogleTilesGlobe apiKey={config.googleMapsApiKey} onGround={onGround} />
      )}
      {ground != null && (
        <GlobeControls
          // Raycast only against the ground (tiles or ellipsoid), never
          // aircraft. The ellipsoid defaults to WGS84 in an identity frame,
          // which matches our ECEF scene.
          scene={ground}
          enableDamping
          adjustHeight={false}
          // Permit grazing, near-horizontal views.
          maxAltitude={Math.PI * 0.55}
        />
      )}
    </>
  )
}

export const Scene: FC = () => {
  const camera = useThree(({ camera }) => camera)

  useLayoutEffect(() => {
    // Only on first mount (camera still at the origin), not on HMR.
    if (camera.position.length() > 10) return
    const { longitude, latitude, heading, pitch, distance } = getInitialView()
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      new Geodetic(radians(longitude), radians(latitude)).toECEF(),
      camera.position,
      camera.quaternion,
      camera.up
    )
  }, [camera])

  // Sun and moon follow the (optionally offset) real UTC clock.
  const atmosphereRef = useRef<AtmosphereApi>(null)
  useFrame(() => {
    atmosphereRef.current?.updateByDate(getSimulatedDate())
  })

  return (
    <Atmosphere ref={atmosphereRef} correctAltitude>
      <Sky />
      <Stars data='/atmosphere/stars.bin' />
      <GlobeAndControls />
      <PostEffects />
    </Atmosphere>
  )
}
