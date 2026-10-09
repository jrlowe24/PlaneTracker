import { createStore } from './createStore'

/** Current dynamic resolution scale (1 = the quality preset's pixel ratio). */
export const resolutionStore = createStore({ scale: 1 })
