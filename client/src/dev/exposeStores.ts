import { modelLightAnchors } from '../aircraft/detailState'
import { cloudCoverStore } from '../clouds/cloudCoverStore'
import { weatherStore } from '../data/weather'
import { cameraModeStore } from '../state/cameraMode'
import { qualityStore } from '../state/quality'
import { resolutionStore } from '../state/resolution'
import { selectionStore } from '../state/selection'
import { settingsStore } from '../state/settings'

/** Dev only: stores on window for console debugging and scripted checks. */
export function exposeStores(): void {
  ;(window as { __windowSeatStores?: unknown }).__windowSeatStores = {
    cameraModeStore,
    qualityStore,
    resolutionStore,
    selectionStore,
    settingsStore,
    weatherStore,
    modelLightAnchors,
    cloudCover: cloudCoverStore
  }
}
