import { createStore } from './createStore'

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
  showDevPanel: boolean
}

const params = new URLSearchParams(window.location.search)

/** `?t=<hours>` starts with a time offset, e.g. `?t=-6`. */
function initialTimeOffsetMs(): number {
  const hours = Number(params.get('t') ?? 0)
  return Number.isFinite(hours) ? hours * 3_600_000 : 0
}

export const settingsStore = createStore<Settings>({
  timeOffsetMs: initialTimeOffsetMs(),
  exposure: 10,
  interpolationDelayMs: 12_000,
  cloudSource: 'weather',
  cloudCoverage: 0.35,
  showDevPanel: import.meta.env.DEV
})

/** Simulated "now" used for sun/moon position. */
export function getSimulatedDate(): Date {
  return new Date(Date.now() + settingsStore.get().timeOffsetMs)
}
