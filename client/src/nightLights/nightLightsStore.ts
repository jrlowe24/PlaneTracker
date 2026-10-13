import type { Texture } from 'three'

import type { RoadLightTiles } from './roadTiles'

import { createStore } from '../state/createStore'

/** Credit for the attribution line while city lights are visible. */
export const nightLightsStore = createStore<{ credit: string | null; streets: boolean }>({
  credit: null,
  streets: false
})

/** Developer A/B control for the treatment of sub-pixel city fixtures. */
export type NightLightingMode = 'current' | 'photographic' | 'noBoost'
export const nightLightingTestStore = createStore<{ mode: NightLightingMode; forceAircraftWorkLights: boolean }>({
  mode: 'current', forceAircraftWorkLights: false
})

/**
 * The night light emission buffer (lights and their glow) AerialPerspective
 * adds to the terrain, and whether it's current (the pass is skipped by day).
 */
export const nightEmission: {
  texture: Texture | null
  enabled: boolean
  roads: RoadLightTiles | null
  /** NASA's coarse night light map (equirectangular), once loaded. */
  baseMap: Texture | null
} = {
  texture: null,
  enabled: false,
  roads: null,
  baseMap: null
}
