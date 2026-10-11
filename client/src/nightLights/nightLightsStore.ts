import type { Texture } from 'three'

import type { RoadLightTiles } from './roadTiles'

import { createStore } from '../state/createStore'

/** Credit for the attribution line while city lights are visible. */
export const nightLightsStore = createStore<{ credit: string | null; streets: boolean }>({
  credit: null,
  streets: false
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
