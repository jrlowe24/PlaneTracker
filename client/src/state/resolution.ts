import { createStore } from './createStore'

export interface ResolutionState {
  /** Current dynamic resolution scale (1 = the quality preset's pixel ratio). */
  scale: number
  /**
   * Multiplier on the tile error target (≥ 1 = coarser terrain), raised
   * when resolution alone isn't enough to hold the frame rate.
   */
  tileFactor: number
  /** Dev/benchmarks: hold the current values (no adaptive changes). */
  locked: boolean
}

export const resolutionStore = createStore<ResolutionState>({ scale: 1, tileFactor: 1, locked: false })
