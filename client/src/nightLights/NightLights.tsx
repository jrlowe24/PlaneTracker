import { useFrame, useThree } from '@react-three/fiber'
import { AtmosphereContext, type AtmosphereTransientStates } from '@takram/three-atmosphere/r3f'
import { ecefToGeodetic, WGS84_A } from '@windowseat/shared'
import { useContext, useEffect, useMemo, type FC } from 'react'
import type { Camera } from 'three'

import { lightAnchor } from '../aircraft/lightAnchor'
import { nightState } from '../scene/nightLighting'
import { isMobileDevice, qualityStore } from '../state/quality'
import { NightLightsPass } from './NightLightsPass'
import { nightEmission, nightLightsStore } from './nightLightsStore'
import { NightLightTiles } from './nightLightTiles'
import { RoadLightTiles } from './roadTiles'

/** Detail tiles stream only below this camera altitude (horizon ~2,800 km). */
const DETAIL_MAX_ALTITUDE = 600_000
const FLUSH_INTERVAL_S = 0.25

class NightLightsController {
  readonly tiles = new NightLightTiles()
  private roads: RoadLightTiles | null = null
  readonly effect: NightLightsPass
  private ready = false
  private active = false
  private sinceFlush = 0

  constructor(camera: Camera) {
    this.effect = new NightLightsPass(camera)
    this.effect.enabled = false
    // Phones: the 8192×4096 light map alone is ~180 MB of GPU memory, enough
    // to get textures evicted on iOS (black terrain and sky).
    if (isMobileDevice()) return
    this.roads = new RoadLightTiles()
    void this.tiles.load().then(ok => {
      if (!ok) return
      this.effect.setMaps(this.tiles.base, this.tiles.detail)
      this.ready = true
    })
  }

  update(camera: Camera, states: AtmosphereTransientStates, delta: number): void {
    // Set every frame: a remounted controller must not leave a stale one.
    nightEmission.texture = this.effect.texture
    nightEmission.enabled = this.ready && this.effect.enabled
    nightEmission.roads = this.roads
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
      this.effect.enabled = active
      nightEmission.enabled = active
    }
    if (!active) {
      if (nightLightsStore.get().credit != null) nightLightsStore.set({ credit: null, streets: false })
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
    if (this.roads != null) {
      this.roads.update(camera)
      effect.setRoads(this.roads.texture, this.roads.lamps, this.roads.levels.map(l => l.uniforms))
      this.roads.runways.update(camera.position)
      effect.setRunways(this.roads.runways.uniforms)
    }

    this.sinceFlush += delta
    if (this.sinceFlush >= FLUSH_INTERVAL_S) {
      this.sinceFlush = 0
      tiles.flush()
      const credit = nightState.night > 0.05 ? m.credit : null
      const streets = credit != null && (this.roads?.levels.some(l => l.uniforms.enabled) ?? false)
      const store = nightLightsStore.get()
      if (store.credit !== credit || store.streets !== streets) nightLightsStore.set({ credit, streets })
    }
  }

  dispose(): void {
    if (nightEmission.texture === this.effect.texture) {
      nightEmission.texture = null
      nightEmission.enabled = false
      nightEmission.roads = null
    }
    this.effect.dispose()
    this.tiles.dispose()
    this.roads?.dispose()
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
