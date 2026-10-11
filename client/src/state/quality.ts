import { createStore } from './createStore'
import { isMobileDevice } from './device'

export { isMobileDevice }

/** Overall presets (Auto picks one of the first three). */
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra'
export type QualityChoice = QualityLevel | 'auto' | 'custom'

/**
 * What can be set on its own (Settings → Graphics). Each preset sets all
 * of them; changing one makes the choice 'custom'.
 */
export interface QualityElements {
  /** Render resolution (pixel ratio cap; see RESOLUTION). */
  resolution: 'low' | 'medium' | 'high' | 'ultra'
  /** Terrain detail: 3D Tiles error target (see TERRAIN). */
  terrain: 'low' | 'medium' | 'high' | 'ultra'
  clouds: 'off' | 'low' | 'medium' | 'high'
  cloudShadows: boolean
  /**
   * City lights at night: low, NASA's map at ~5 km plus streets; medium,
   * its ~600 m detail too; high, lit windows on buildings as well.
   */
  cityLights: 'low' | 'medium' | 'high'
  /** How many aircraft near the camera get full models. */
  aircraft: 'low' | 'medium' | 'high'
  /** Lens flare / glare post effect (~2 ms at 2560×1600 on an M3 Pro). */
  lensFlare: boolean
}

/** What the renderer reads (resolved from QualityElements). */
export interface QualitySettings {
  /** Volumetric clouds: off, or takram's preset of that name. */
  clouds: false | 'low' | 'medium' | 'high'
  /** Clouds cast shadows on the terrain (Beer shadow maps). */
  cloudShadows: boolean
  /** Cloud render resolution, as a fraction of the screen's. */
  cloudResolution: number
  /** Crepuscular rays through clouds. */
  lightShafts: boolean
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
  /** NASA's ~600 m city light tiles near the view. */
  cityLightDetail: boolean
  /** Lit windows on buildings. */
  buildingWindows: boolean
  /** Most aircraft drawn with full models at once. */
  maxDetailedAircraft: number
  /** Landing and taxi lights, with their beams on the ground at night. */
  landingLights: boolean
  /** Tile cache (bytes): finer terrain needs more to hold the view. */
  tileCacheBytes: number
}

/**
 * Pixel ratio caps: day, night, night close to the ground. Not 2 by day on
 * High: every full-screen buffer (a dozen, half float) is 44% smaller at
 * 1.5 on a 2x display (~250 MB less), for slightly softer edges.
 */
const RESOLUTION: Record<QualityElements['resolution'], [number, number, number]> = {
  low: [1, 1, 1],
  medium: [1.5, 1.25, 1.75],
  high: [1.5, 1.5, 2],
  ultra: [2, 2, 2]
}

/**
 * Terrain error targets (pixels). Each step finer costs a lot of main-
 * thread time walking and streaming tiles, every frame (6 → 9: ~35% less
 * time in the tile update and ~30% fewer tiles in use, flying low over a
 * city), for detail mostly visible only when looking for it.
 */
const TERRAIN: Record<QualityElements['terrain'], number> = { low: 20, medium: 12, high: 9, ultra: 6 }

/**
 * Tile cache (upper bound) by terrain detail. A full cache can't load what
 * the view needs (tiles in use can't be evicted), so the view stays coarse
 * in places; finer terrain uses more tiles. With distant terrain coarser
 * (QualityApplier) a low city view uses ~400 MB on High, ~700 on Ultra.
 */
const TILE_CACHE: Record<QualityElements['terrain'], number> = { low: 500e6, medium: 800e6, high: 1200e6, ultra: 2000e6 }

/** Cloud resolution (fraction of the screen) by preset. */
const CLOUD_RESOLUTION: Record<Exclude<QualityElements['clouds'], 'off'>, number> = {
  // takram's cheapest clouds (no detail noise, short marches) at a third
  // of the screen resolution: a few ms on a phone.
  low: 0.35,
  medium: 0.5,
  high: 0.5
}

const DETAILED_AIRCRAFT: Record<QualityElements['aircraft'], number> = { low: 3, medium: 6, high: 12 }

export const PRESETS: Record<QualityLevel, QualityElements> = {
  low: {
    resolution: 'low',
    terrain: 'low',
    clouds: 'low',
    cloudShadows: false,
    cityLights: 'low',
    aircraft: 'low',
    lensFlare: false
  },
  medium: {
    resolution: 'medium',
    terrain: 'medium',
    clouds: 'medium',
    cloudShadows: true,
    cityLights: 'medium',
    aircraft: 'medium',
    lensFlare: false
  },
  high: {
    resolution: 'high',
    terrain: 'high',
    clouds: 'high',
    cloudShadows: true,
    cityLights: 'high',
    aircraft: 'high',
    lensFlare: true
  },
  ultra: {
    resolution: 'ultra',
    terrain: 'ultra',
    clouds: 'high',
    cloudShadows: true,
    cityLights: 'high',
    aircraft: 'high',
    lensFlare: true
  }
}

export function resolveQuality(e: QualityElements): QualitySettings {
  const [maxDpr, nightMaxDpr, closeNightMaxDpr] = RESOLUTION[e.resolution]
  return {
    clouds: e.clouds === 'off' ? false : e.clouds,
    cloudShadows: e.cloudShadows,
    cloudResolution: e.clouds === 'off' ? 0.5 : CLOUD_RESOLUTION[e.clouds],
    // Off: screen-space cascade limits showed as bright bands over the
    // ground at some angles, and they cost frame time.
    lightShafts: false,
    lensFlare: e.lensFlare,
    tileErrorTarget: TERRAIN[e.terrain],
    maxDpr,
    nightMaxDpr,
    closeNightMaxDpr,
    cityLightDetail: e.cityLights !== 'low',
    buildingWindows: e.cityLights === 'high',
    maxDetailedAircraft: DETAILED_AIRCRAFT[e.aircraft],
    landingLights: e.aircraft !== 'low',
    tileCacheBytes: TILE_CACHE[e.terrain]
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
const CUSTOM_KEY = 'window-seat.quality.custom'
const LEVELS: readonly string[] = ['low', 'medium', 'high', 'ultra']

function readStored(): QualityChoice | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value != null && (LEVELS.includes(value) || value === 'auto' || value === 'custom')
      ? (value as QualityChoice)
      : null
  } catch {
    return null
  }
}

/** The stored custom elements, filled in from `base` where missing. */
function readCustom(base: QualityElements): QualityElements {
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY)
    if (raw == null) return base
    const stored = JSON.parse(raw) as Partial<QualityElements>
    const merged = { ...base }
    for (const key of Object.keys(base) as Array<keyof QualityElements>) {
      if (typeof stored[key] === typeof base[key]) (merged as Record<string, unknown>)[key] = stored[key]
    }
    return merged
  } catch {
    return base
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode): the choice lasts for this page.
  }
}

function initialChoice(): QualityChoice {
  const param = new URLSearchParams(window.location.search).get('quality')
  if (param != null && LEVELS.includes(param)) return param as QualityLevel
  return readStored() ?? 'auto'
}

export interface QualityState {
  /** What the user picked: a preset, 'auto' (follows `level`) or 'custom'. */
  choice: QualityChoice
  detected: QualityLevel
  /** The preset in effect (Auto may step it down when frames run long). */
  level: QualityLevel
  /** Each element's setting. */
  elements: QualityElements
  /** What the renderer reads, from `elements`. */
  settings: QualitySettings
}

const choice = initialChoice()
const detected = detectQuality()
const level: QualityLevel = choice === 'auto' || choice === 'custom' ? detected : choice
const elements = choice === 'custom' ? readCustom(PRESETS[level]) : PRESETS[level]

export const qualityStore = createStore<QualityState>({
  choice,
  detected,
  level,
  elements,
  settings: resolveQuality(elements)
})

/** Picks a preset (or Auto): every element follows it. */
export function setQualityChoice(next: QualityLevel | 'auto'): void {
  qualityStore.set(s => {
    const preset = next === 'auto' ? s.detected : next
    return { choice: next, level: preset, elements: PRESETS[preset], settings: resolveQuality(PRESETS[preset]) }
  })
  store(STORAGE_KEY, next)
}

/** Auto stepping down a preset when frames run long (QualityApplier). */
export function stepDownAuto(): void {
  const { choice, level } = qualityStore.get()
  if (choice !== 'auto' || level === 'low') return
  const next: QualityLevel = level === 'ultra' ? 'high' : level === 'high' ? 'medium' : 'low'
  qualityStore.set({ level: next, elements: PRESETS[next], settings: resolveQuality(PRESETS[next]) })
}

/** Sets one element; the choice becomes 'custom' (remembered). */
export function setQualityElement<K extends keyof QualityElements>(key: K, value: QualityElements[K]): void {
  const elements = { ...qualityStore.get().elements, [key]: value }
  qualityStore.set({ choice: 'custom', elements, settings: resolveQuality(elements) })
  store(STORAGE_KEY, 'custom')
  store(CUSTOM_KEY, JSON.stringify(elements))
}
