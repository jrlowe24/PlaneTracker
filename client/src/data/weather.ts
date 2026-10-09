import type { Attribution, WeatherGridCell, WeatherSample } from '@windowseat/shared'

import { createStore } from '../state/createStore'

export interface WeatherState {
  /** Current weather at the view center (from the server), if any. */
  sample: WeatherSample | null
  attribution: Attribution | null
  /** Cloud cover per 1° cell (key "lat,lon"), merged as the view moves. */
  grid: ReadonlyMap<string, WeatherGridCell>
}

export const weatherStore = createStore<WeatherState>({
  sample: null,
  attribution: null,
  grid: new Map()
})

const MAX_GRID_CELLS = 600

export function gridKey(lat: number, lon: number): string {
  return `${lat},${lon}`
}

/** Merges newly received grid cells (newest wins; oldest dropped past a cap). */
export function mergeWeatherGrid(cells: readonly WeatherGridCell[]): void {
  const grid = new Map(weatherStore.get().grid)
  for (const cell of cells) {
    const key = gridKey(cell.lat, cell.lon)
    grid.delete(key)
    grid.set(key, cell)
  }
  while (grid.size > MAX_GRID_CELLS) grid.delete(grid.keys().next().value!)
  weatherStore.set({ grid })
}
