import type { Texture } from 'three'

import { createStore } from '../state/createStore'

/** Credit for the attribution line while city lights are visible. */
export const nightLightsStore = createStore<{ credit: string | null; streets: boolean }>({
  credit: null,
  streets: false
})

/**
 * The night light emission buffer AerialPerspective adds to the terrain,
 * and whether it's current (the pass is skipped by day).
 */
export const nightEmission: { texture: Texture | null; enabled: boolean } = { texture: null, enabled: false }
