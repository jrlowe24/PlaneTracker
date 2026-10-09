import { useFrame, useThree } from '@react-three/fiber'
import { AtmosphereContext, type AtmosphereTransientStates } from '@takram/three-atmosphere/r3f'
import { ecefToGeodetic, WGS84_A } from '@windowseat/shared'
import { useContext, useEffect, useMemo, type FC } from 'react'
import type { Camera } from 'three'

import { lightAnchor } from '../aircraft/lightAnchor'
import { nightState } from '../scene/nightLighting'
import { isMobileDevice, qualityStore } from '../state/quality'
import { NightLightsEffect } from './NightLightsEffect'
import { nightLightsPass, nightLightsStore } from './nightLightsStore'
import { NightLightTiles } from './nightLightTiles'

/** Detail tiles stream only below this camera altitude (horizon ~2,800 km). */
const DETAIL_MAX_ALTITUDE = 600_000
const FLUSH_INTERVAL_S = 0.25

class NightLightsController {
  readonly tiles = new NightLightTiles()
  readonly effect: NightLightsEffect
  private ready = false
  private active = false
  private sinceFlush = 0

  constructor(camera: Camera) {
    this.effect = new NightLightsEffect(camera)
    // Phones: the 8192×4096 light map alone is ~180 MB of GPU memory, enough
    // to get textures evicted on iOS (black terrain and sky).
    if (isMobileDevice()) return
    void this.tiles.load().then(ok => {
      if (!ok) return
      this.effect.setMaps(this.tiles.base, this.tiles.detail)
      this.ready = true
    })
  }

  update(camera: Camera, states: AtmosphereTransientStates, delta: number): void {
    if (!this.ready) return
    const { effect, tiles } = this
    effect.mainCamera = camera
    effect.setSun(states.sunDirection)
    // Skip the whole pass (a full-screen draw) when nothing in view can be
    // at night: the sun is higher above the camera's horizon than the
    // visible ground extends beyond it, with margin for twilight.
    const radius = camera.position.length()
    const reach = Math.acos(Math.min(1, WGS84_A / Math.max(radius, WGS84_A)))
    const elevation = Math.asin(
      Math.max(-1, Math.min(1, states.sunDirection.dot(camera.position) / radius))
    )
    const margin = this.active ? 0.2 : 0.15 // radians; hysteresis
    const active = elevation < reach + margin
    if (active !== this.active) {
      this.active = active
      // Toggle the pass, not the blend function: changing the blend
      // function recompiles the pass (a hitch at every day/night change).
      nightLightsPass.enabled = active
    }
    if (!active) {
      if (nightLightsStore.get().credit != null) nightLightsStore.set({ credit: null })
      return
    }

    const altitude = camera.position.length() - WGS84_A
    const detail = altitude < DETAIL_MAX_ALTITUDE && qualityStore.get().level !== 'low'
    if (detail) {
      const center = ecefToGeodetic(lightAnchor.x, lightAnchor.y, lightAnchor.z)
      tiles.setCenter(center.lat, center.lon)
    }
    const m = tiles.manifest!
    effect.setDetail(detail, tiles.origin, tiles.loaded, m.detail.tileDegrees, m.detail.columns)

    this.sinceFlush += delta
    if (this.sinceFlush >= FLUSH_INTERVAL_S) {
      this.sinceFlush = 0
      tiles.flush()
      const credit = nightState.night > 0.05 ? m.credit : null
      if (nightLightsStore.get().credit !== credit) nightLightsStore.set({ credit })
    }
  }

  dispose(): void {
    this.effect.dispose()
    this.tiles.dispose()
  }
}

/**
 * City lights at night (NASA Black Marble 2016), resolution by distance:
 * global ~5 km/px base everywhere, ~610 m/px detail tiles streamed into a
 * window around the view when the camera is within a few hundred km of the
 * ground, shaped up close by the urban surfaces in the imagery. Must sit
 * before AerialPerspective, which turns its output into light.
 */
export const NightLights: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const { transientStates } = useContext(AtmosphereContext)
  const controller = useMemo(() => new NightLightsController(camera), [camera])
  useEffect(
    () => () => {
      controller.dispose()
    },
    [controller]
  )
  useFrame((_, delta) => {
    if (transientStates != null) controller.update(camera, transientStates, delta)
  })
  return <primitive object={controller.effect} dispose={null} />
}
