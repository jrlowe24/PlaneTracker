import { createStore } from './createStore'
import { isMobileDevice } from './device'

export { isMobileDevice }

export type QualityLevel = 'low' | 'medium' | 'high'

export interface QualitySettings {
  /** Volumetric clouds: off, or takram's preset of that name. */
  clouds: false | 'low' | 'medium' | 'high'
  /** Clouds cast shadows on the terrain (Beer shadow maps). */
  cloudShadows: boolean
  /** Cloud render resolution, as a fraction of the screen's. */
  cloudResolution: number
  /** Crepuscular rays through clouds. */
  lightShafts: boolean
  /** Lens flare / glare post effect (~2 ms at 2560×1600 on an M3 Pro). */
  lensFlare: boolean
  /** 3D Tiles screen-space error target in pixels (higher = coarser, faster). */
  tileErrorTarget: number
  /** Device-pixel-ratio cap (resolution scale). */
  maxDpr: number
  /**
   * The cap at night: the terrain is barely visible then (coarser tiles,
   * coarser clouds) and the lights are sized in pixels, so they read just
   * as well from afar at a lower resolution (bigger, if anything).
   */
  nightMaxDpr: number
  /**
   * The cap at night with the camera close to the ground (low over a city,
   * on approach), where lamps and windows are big enough for sharpness to
   * show.
   */
  closeNightMaxDpr: number
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    // takram's cheapest clouds (no detail noise, short marches) at a third
    // of the screen resolution: a few ms on a phone.
    clouds: 'low',
    cloudShadows: false,
    cloudResolution: 0.35,
    lightShafts: false,
    lensFlare: false,
    tileErrorTarget: 20,
    maxDpr: 1,
    nightMaxDpr: 1,
    closeNightMaxDpr: 1
  },
  medium: {
    clouds: 'medium',
    cloudShadows: true,
    cloudResolution: 0.5,
    lightShafts: false,
    lensFlare: false,
    tileErrorTarget: 12,
    maxDpr: 1.5,
    nightMaxDpr: 1.25,
    closeNightMaxDpr: 1.75
  },
  high: {
    clouds: 'high',
    cloudShadows: true,
    cloudResolution: 0.5,
    // Off: screen-space cascade limits showed as bright bands over the
    // ground at some angles, and they cost frame time.
    lightShafts: false,
    lensFlare: true,
    tileErrorTarget: 6,
    // Not 2: every full-screen buffer (a dozen, half float) is 44% smaller
    // at 1.5 on a 2x display (~250 MB less), for slightly softer edges.
    maxDpr: 1.5,
    nightMaxDpr: 1.5,
    closeNightMaxDpr: 2
  }
}

/** Unmasked GPU renderer string, if the browser exposes it. */
function gpuRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext != null ? gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return typeof renderer === 'string' ? renderer : ''
  } catch {
    return ''
  }
}

/**
 * Picks a preset for this device: phones and tablets get 'low';
 * Apple silicon and discrete GPUs 'high'; integrated/unknown GPUs 'medium'.
 */
export function detectQuality(): QualityLevel {
  if (isMobileDevice()) return 'low'
  const gpu = gpuRenderer()
  if (/Apple M\d|NVIDIA|GeForce|RTX|Radeon RX|Radeon Pro/i.test(gpu)) return 'high'
  if (/SwiftShader|llvmpipe|Software/i.test(gpu)) return 'low'
  return 'medium'
}

const STORAGE_KEY = 'window-seat.quality'

function readStored(): QualityLevel | 'auto' | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'low' || value === 'medium' || value === 'high' || value === 'auto'
      ? value
      : null
  } catch {
    return null
  }
}

function initialChoice(): QualityLevel | 'auto' {
  const param = new URLSearchParams(window.location.search).get('quality')
  if (param === 'low' || param === 'medium' || param === 'high') return param
  return readStored() ?? 'auto'
}

export interface QualityState {
  /** What the user picked; 'auto' follows `detected`. */
  choice: QualityLevel | 'auto'
  detected: QualityLevel
  level: QualityLevel
}

const choice = initialChoice()
const detected = detectQuality()

export const qualityStore = createStore<QualityState>({
  choice,
  detected,
  level: choice === 'auto' ? detected : choice
})

export function setQualityChoice(next: QualityLevel | 'auto'): void {
  qualityStore.set(s => ({ choice: next, level: next === 'auto' ? s.detected : next }))
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage unavailable (private mode); the choice lasts for this page.
  }
}
