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
import type { Group, Object3D } from 'three'

import { AircraftSystem } from '../aircraft/AircraftSystem'
import { CameraRig } from '../camera/CameraRig'
import { config } from '../config'
import { DevBench } from '../dev/DevBench'
import { EllipsoidGlobe } from '../globe/EllipsoidGlobe'
import { GoogleTilesGlobe } from '../globe/GoogleTilesGlobe'
import { cameraModeStore } from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { getSimulatedDate } from '../state/settings'
import { PostEffects } from './PostEffects'
import { QualityApplier } from './QualityApplier'
import { nightState } from './nightLighting'
import { RainShafts } from '../weather/RainShafts'

// Present at runtime in 3d-tiles-renderer 0.5.3, but omitted from its .d.ts.
type GlobeControlsRuntime = GlobeControlsImpl & {
  scaleZoomOrientationAtEdges: boolean
}

function setEdgeZoomScaling(controls: GlobeControlsRuntime, enabled: boolean): void {
  controls.scaleZoomOrientationAtEdges = enabled
}

/** Default view: Seattle from above, north up. */
const DEFAULT_VIEW = {
  latitude: 47.6062,
  longitude: -122.3321,
  heading: 0,
  pitch: -89.9,
  distance: 25_000
}

/**
 * Furthest the globe camera may tilt from straight down. GlobeControls calls
 * this "altitude", but zero is top-down and PI / 2 is on the horizon. Leave
 * a margin above the horizon so zooming cannot pull the camera through land.
 */
const MAX_FREE_LOOK_TILT = Math.PI * 0.45

/**
 * `?view=lat,lon,heading,pitch,distance[,height]` (degrees / meters; height
 * of the target point above the ellipsoid) overrides the initial camera,
 * e.g. `?view=0,0,0,-90,2e7` for a whole-Earth view.
 */
function getInitialView(): typeof DEFAULT_VIEW & { height: number } {
  const raw = new URLSearchParams(window.location.search).get('view')
  const values = raw?.split(',').map(Number) ?? []
  if (
    (values.length !== 5 && values.length !== 6) ||
    values.some(v => !Number.isFinite(v))
  ) {
    return { ...DEFAULT_VIEW, height: 0 }
  }
  const [latitude, longitude, heading, pitch, distance, height = 0] = values as [
    number,
    number,
    number,
    number,
    number,
    number?
  ]
  return { latitude, longitude, heading, pitch, distance, height }
}

const GlobeAndControls: FC = () => {
  const [ground, setGround] = useState<Object3D | null>(null)
  const onGround = useCallback((object: Object3D | null) => {
    setGround(object)
  }, [])

  const controls = useThree(
    ({ controls }) => controls as GlobeControlsRuntime | null
  )
  // The camera rig drives the camera while following an aircraft and during
  // fly-to transitions.
  const globeControlsEnabled = useStore(
    cameraModeStore,
    s => s.mode === 'globe' && !s.transitioning
  )
  // GlobeControls adjusts the camera height against very coarse LoD tiles
  // during the initial load, which can make the camera jump into the sky.
  // Re-enable it on the first user interaction (as takram's examples do).
  useEffect(() => {
    if (controls == null) return
    const previousEdgeZoom = controls.scaleZoomOrientationAtEdges
    setEdgeZoomScaling(controls, true)
    const onStart = (): void => {
      controls.adjustHeight = true
      controls.removeEventListener('start', onStart)
    }
    controls.addEventListener('start', onStart)
    return () => {
      setEdgeZoomScaling(controls, previousEdgeZoom)
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
          enabled={globeControlsEnabled}
          enableDamping
          adjustHeight={false}
          minAltitude={0}
          maxAltitude={MAX_FREE_LOOK_TILT}
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
    const { longitude, latitude, heading, pitch, distance, height } = getInitialView()
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      new Geodetic(radians(longitude), radians(latitude), height).toECEF(),
      camera.position,
      camera.quaternion,
      camera.up
    )
  }, [camera])

  // Dev: jump the camera without reloading (a reload starts a new billable
  // Google tiles session):
  // __windowSeatView(lat, lon, heading, pitch, distance, targetHeight = 0).
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as {
      __windowSeatView?: (
        lat: number,
        lon: number,
        heading: number,
        pitch: number,
        distance: number,
        targetHeight?: number
      ) => void
    }
    w.__windowSeatView = (lat, lon, heading, pitch, distance, targetHeight = 0) => {
      new PointOfView(distance, radians(heading), radians(pitch)).decompose(
        new Geodetic(radians(lon), radians(lat), targetHeight).toECEF(),
        camera.position,
        camera.quaternion,
        camera.up
      )
      camera.updateMatrixWorld()
    }
    return () => {
      delete w.__windowSeatView
    }
  }, [camera])

  // Sun and moon follow the (optionally offset) real UTC clock.
  const atmosphereRef = useRef<AtmosphereApi>(null)
  const starsRef = useRef<Group>(null)
  useFrame(() => {
    atmosphereRef.current?.updateByDate(getSimulatedDate())
    if (starsRef.current != null) starsRef.current.visible = nightState.night > 0.12
  })

  return (
    <Atmosphere ref={atmosphereRef} correctAltitude>
      <Sky />
      {/* Brighter than takram's default so the night sky reads at our
          (reduced) night exposure. */}
      <group ref={starsRef}>
        <Stars data='/atmosphere/stars.bin' intensity={6} pointSize={1.5} />
      </group>
      <GlobeAndControls />
      <AircraftSystem />
      <RainShafts />
      <CameraRig />
      <PostEffects />
      <QualityApplier />
      {import.meta.env.DEV && <DevBench />}
    </Atmosphere>
  )
}
