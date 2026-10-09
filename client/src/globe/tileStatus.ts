import { createStore, type Store } from '../state/createStore'

export interface TileStatus {
  /** Last load error, e.g. a rejected API key. */
  error: string | null
  /** Root tileset requests in this page (each is a billable session). */
  rootLoads: number
}

// Kept on globalThis so the count survives Vite HMR, like the tileset itself.
const KEY = Symbol.for('window-seat.tile-status')
const g = globalThis as { [KEY]?: Store<TileStatus> }

export const tileStatusStore: Store<TileStatus> = (g[KEY] ??=
  createStore<TileStatus>({ error: null, rootLoads: 0 }))
