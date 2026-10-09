import type { Object3D } from 'three'

import { createStore } from '../state/createStore'

/** The nav lights mesh, for the post effect that gives only it a glow. */
export const navLightsStore = createStore<{ mesh: Object3D | null }>({ mesh: null })
