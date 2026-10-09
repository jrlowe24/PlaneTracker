import { createStore } from './createStore'

export interface Selection {
  /** ICAO hex of the selected aircraft. */
  selectedHex: string | null
}

export const selectionStore = createStore<Selection>({ selectedHex: null })
