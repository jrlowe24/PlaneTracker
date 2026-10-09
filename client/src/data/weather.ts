import type { Attribution, WeatherSample } from '@windowseat/shared'

import { createStore } from '../state/createStore'

export interface WeatherState {
  /** Current weather at the view center (from the server), if any. */
  sample: WeatherSample | null
  attribution: Attribution | null
}

export const weatherStore = createStore<WeatherState>({ sample: null, attribution: null })
