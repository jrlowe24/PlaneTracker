import { createStore } from '../state/createStore'

/** Cloud cover the renderer uses at the view center (0…1), for display. */
export const cloudCoverStore = createStore({
  low: 0,
  mid: 0,
  high: 0,
  /** True when it comes from the blended weather grid. */
  regional: false
})
