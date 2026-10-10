import { createStore } from './createStore'

export interface UiState {
  /** The time / weather / graphics sheet. */
  settingsOpen: boolean
}

export const uiStore = createStore<UiState>({ settingsOpen: false })
