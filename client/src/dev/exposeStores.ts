import { weatherStore } from '../data/weather'
import { cameraModeStore } from '../state/cameraMode'
import { qualityStore } from '../state/quality'
import { selectionStore } from '../state/selection'
import { settingsStore } from '../state/settings'

/** Dev only: stores on window for console debugging and scripted checks. */
export function exposeStores(): void {
  ;(window as { __windowSeatStores?: unknown }).__windowSeatStores = {
    cameraModeStore,
    qualityStore,
    selectionStore,
    settingsStore,
    weatherStore
  }
}
