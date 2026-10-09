import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { settingsStore } from '../state/settings'

/** Dev only: stores on window for console debugging and scripted checks. */
export function exposeStores(): void {
  ;(window as { __windowSeatStores?: unknown }).__windowSeatStores = {
    cameraModeStore,
    selectionStore,
    settingsStore
  }
}
