import { createStore } from '../state/createStore'

/** Credit for the attribution line while city lights are visible. */
export const nightLightsStore = createStore<{ credit: string | null }>({ credit: null })
