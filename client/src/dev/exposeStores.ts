import { modelLightAnchors } from '../aircraft/detailState'
import { cloudCoverStore } from '../clouds/cloudCoverStore'
import { nightCloudUniforms } from '../clouds/nightClouds'
import { flightConnection } from '../data/flightConnection'
import { weatherStore } from '../data/weather'
import { nightState } from '../scene/nightLighting'
import { cameraModeStore, followAircraft } from '../state/cameraMode'
import { qualityStore, setQualityChoice, setQualityElement } from '../state/quality'
import { resolutionStore } from '../state/resolution'
import { selectionStore } from '../state/selection'
import { settingsStore } from '../state/settings'
import { setViewSolarHours } from '../state/skyTime'

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
    cloudCover: cloudCoverStore,
    flightConnection,
    followAircraft,
    setViewSolarHours,
    nightState,
    nightCloudUniforms,
    setQualityChoice,
    setQualityElement
  }
}
