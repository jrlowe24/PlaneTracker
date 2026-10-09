import { createStore } from './createStore'

export type CameraMode = 'globe' | 'follow' | 'window'

export interface CameraModeState {
  mode: CameraMode
  /** Aircraft the follow/window camera is attached to. */
  targetHex: string | null
  /** Window view: which side of the cabin. */
  windowSide: 'left' | 'right'
  /** True while a fly-to transition runs (globe controls stay disabled). */
  transitioning: boolean
}

export const cameraModeStore = createStore<CameraModeState>({
  mode: 'globe',
  targetHex: null,
  windowSide: 'left',
  transitioning: false
})

export function followAircraft(hex: string): void {
  cameraModeStore.set({ mode: 'follow', targetHex: hex })
}

export function enterWindowView(hex: string): void {
  cameraModeStore.set({ mode: 'window', targetHex: hex })
}

export function exitToGlobe(): void {
  cameraModeStore.set({ mode: 'globe' })
}
