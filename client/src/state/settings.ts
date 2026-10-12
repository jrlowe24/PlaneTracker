import { createStore } from './createStore'

export type WeatherPrototype = 'live' | 'clear' | 'fair' | 'overcast'

export interface Settings {
  /**
   * Offset added to the real clock to get the simulated time that drives the
   * sun and moon. Dev control for testing day/night; 0 = live.
   */
  timeOffsetMs: number
  /** Camera exposure fed to the tone mapper. */
  exposure: number
  /**
   * How far behind the newest data aircraft are rendered, so there is
   * almost always a sample on each side to interpolate between.
   */
  interpolationDelayMs: number
  /** Clouds from live weather (Open-Meteo) or the manual coverage below. */
  cloudSource: 'weather' | 'manual'
  /** Manual cloud coverage, 0 (clear) … 1 (overcast). */
  cloudCoverage: number
  /** Dev visual lab; `live` delegates to the regular Weather control. */
  weatherPrototype: WeatherPrototype
  /** Browser-friendly precipitation: forecast-driven, forced for visual QA, or off. */
  precipitation: 'auto' | 'force' | 'off'
  /** Replace mapped OSM water surfaces with the procedural water material. */
  waterMaterial: boolean
  /** Experimental color/roughness heuristic for likely water in 3D tiles. */
  experimentalWater: boolean
  showDevPanel: boolean
}

const params = new URLSearchParams(window.location.search)
const WEATHER_PROTOTYPE_KEY = 'window-seat.weather-prototype'

/** `?t=<hours>` starts with a time offset, e.g. `?t=-6`. */
function initialTimeOffsetMs(): number {
  const hours = Number(params.get('t') ?? 0)
  return Number.isFinite(hours) ? hours * 3_600_000 : 0
}

/** `?weather=clear|fair|overcast` opens a repeatable development scene. */
function initialWeatherPrototype(): Settings['weatherPrototype'] {
  const value = params.get('weather')
  if (value === 'clear' || value === 'fair' || value === 'overcast') return value
  try {
    const stored = window.sessionStorage.getItem(WEATHER_PROTOTYPE_KEY)
    return stored === 'clear' || stored === 'fair' || stored === 'overcast' ? stored : 'live'
  } catch {
    return 'live'
  }
}

export const settingsStore = createStore<Settings>({
  timeOffsetMs: initialTimeOffsetMs(),
  exposure: 10,
  interpolationDelayMs: 12_000,
  cloudSource: 'weather',
  cloudCoverage: 0.35,
  weatherPrototype: initialWeatherPrototype(),
  precipitation: 'auto',
  waterMaterial: false,
  experimentalWater: params.get('water') === '1',
  // Keep the diagnostic panel hidden by default; press ` to show it when needed.
  showDevPanel: false
})

/** Keeps the visual-lab selection across shader-triggered page reloads. */
export function setWeatherPrototype(value: Settings['weatherPrototype']): void {
  settingsStore.set({ weatherPrototype: value })
  try {
    window.sessionStorage.setItem(WEATHER_PROTOTYPE_KEY, value)
  } catch {
    // Session storage can be unavailable in private browsing.
  }
}

/** Simulated "now" used for sun/moon position. */
export function getSimulatedDate(): Date {
  return new Date(Date.now() + settingsStore.get().timeOffsetMs)
}
