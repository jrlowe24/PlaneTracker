import { useFrame, useThree } from '@react-three/fiber'
import { ecefToGeodetic, geoidHeight } from '@windowseat/shared'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'

import { config } from '../config'
import { setAirportDetailBoost } from '../globe/airportDetail'
import { getGoogleTiles, setTileCacheBytes } from '../globe/googleTiles'
import { useStore } from '../state/createStore'
import { qualityStore, stepDownAuto } from '../state/quality'
import { resolutionStore } from '../state/resolution'
import { nightState } from './nightLighting'

/** Frame time budget: 60 fps with a little slack. */
const TARGET_MS = 1000 / 60
/**
 * Only sustained slowness (below ~48 fps) costs sharpness: brief dips and
 * 50-55 fps aren't worth a visibly softer image.
 */
const SLOW_MS = TARGET_MS * 1.25
/** Every preset may trade resolution for a stable frame rate. */
const MIN_SCALE = 0.6
const STEP_DOWN = 0.9
const STEP_UP = 1.08
/** Preserve crisp pixels first: geometry is cheaper to trade at night. */
const MAX_TILE_FACTOR = 1.5
const TILE_STEP = 1.25
/** Daytime tile cross-fade (see googleTiles.ts). */
const TILE_FADE_MS = 600
/** Tile error target multiplier at night (terrain barely visible). */
const NIGHT_TILE_FACTOR = 2
/**
 * Distant terrain: tiles far away (see FAR_HEIGHTS) may have up to
 * 1 + FAR_COARSER times the target error (the library's errorFalloff, a
 * fog-like curve like Cesium's dynamic screen-space error).
 */
const FAR_COARSER = 1.5
/** "Far" starts at this many camera heights above the ground, or FAR_MIN_M. */
const FAR_HEIGHTS = 4
const FAR_MIN_M = 5000
/** Camera height (m above sea level) for the close-up night resolution. */
const CLOSE_ENTER_M = 1500
const CLOSE_EXIT_M = 2500
/** Seconds of averaging before a decision; going up needs longer. */
const WINDOW_DOWN_S = 1.5
const WINDOW_UP_S = 3
/** Auto quality steps down a preset after this long at the floor and still slow. */
const FLOOR_DOWNGRADE_S = 4

/**
 * Adaptive resolution: keeps the frame rate at 60 by scaling the render
 * resolution below the preset's pixel ratio when frames run long, and back
 * up when there's headroom. Steps down quickly (a stutter is worse than a
 * slightly softer image) and up slowly; changes are quantized so render
 * targets aren't reallocated every frame. requestAnimationFrame caps the
 * measurement at the display rate, so "headroom" means sustained frames at
 * the display rate.
 */
class ResolutionGovernor {
  scale = 1
  tileFactor = 1
  /** Seconds spent at the lowest settings while still too slow. */
  floorSeconds = 0
  /** Smoothed frame time, ms. */
  private averageMs = TARGET_MS
  private sum = 0
  private count = 0
  private elapsed = 0

  /** Returns true when scale or tile factor changed. */
  sample(deltaS: number): boolean {
    const ms = deltaS * 1000
    // Ignore stalls (tab hidden, debugger, page load hitches).
    if (ms > 250) return false
    const atFloor = this.scale <= MIN_SCALE + 1e-6 && this.tileFactor >= MAX_TILE_FACTOR - 1e-6
    this.averageMs += (ms - this.averageMs) * 0.03
    this.floorSeconds = atFloor && this.averageMs > TARGET_MS * 1.1 ? this.floorSeconds + deltaS : 0
    this.sum += ms
    this.count += 1
    this.elapsed += deltaS
    const mean = this.sum / this.count
    let changed = false
    if (this.elapsed >= WINDOW_DOWN_S && mean > SLOW_MS) {
      // Close-city photogrammetry is often the dominant cost. Trade some
      // geometry first so one-pixel windows and lamps stay crisp; only then
      // lower the full-screen render resolution.
      if (this.tileFactor < MAX_TILE_FACTOR) {
        this.tileFactor = Math.min(MAX_TILE_FACTOR, this.tileFactor * TILE_STEP)
        changed = true
      } else if (this.scale > MIN_SCALE) {
        this.scale = Math.round(Math.max(MIN_SCALE, this.scale * STEP_DOWN) * 20) / 20
        changed = true
      }
    } else if (this.elapsed >= WINDOW_UP_S && mean < TARGET_MS * 1.04) {
      // Recover terrain detail first, then resolution.
      if (this.tileFactor > 1) {
        this.tileFactor = Math.max(1, this.tileFactor / TILE_STEP)
        changed = true
      } else if (this.scale < 1) {
        this.scale = Math.round(Math.min(1, this.scale * STEP_UP) * 20) / 20
        changed = true
      }
    }
    if (changed || this.elapsed >= WINDOW_UP_S) {
      this.sum = 0
      this.count = 0
      this.elapsed = 0
    }
    return changed
  }

  /** True (once) when it has sat at the floor and still been slow long enough. */
  takeDowngrade(): boolean {
    if (this.floorSeconds <= FLOOR_DOWNGRADE_S) return false
    this.floorSeconds = 0
    return true
  }

  reset(): void {
    this.scale = 1
    this.tileFactor = 1
    this.floorSeconds = 0
    this.sum = 0
    this.count = 0
    this.elapsed = 0
  }
}

/** Applies the quality preset's resolution and tile error target (both adaptively). */
export const QualityApplier: FC = () => {
  const setDpr = useThree(({ setDpr }) => setDpr)
  const preset = useStore(qualityStore, s => s.settings)
  const governor = useMemo(() => new ResolutionGovernor(), [])
  const scale = useStore(resolutionStore, s => s.scale)
  const tileFactor = useStore(resolutionStore, s => s.tileFactor)

  useEffect(() => {
    // A new preset starts at full resolution again.
    governor.reset()
    resolutionStore.set({ scale: 1, tileFactor: 1 })
  }, [governor, preset.maxDpr])

  // At night the terrain is barely visible (lights carry the view):
  // coarser tiles, about a quarter as many, in memory and on screen.
  // Hysteresis so dusk doesn't flip it back and forth.
  const [dark, setDark] = useState(false)
  useFrame(() => {
    const night = nightState.night
    if (!dark && night > 0.95) setDark(true)
    else if (dark && night < 0.75) setDark(false)
  })

  // Close to the ground (height above the geoid; hysteresis so climbing
  // or descending through it doesn't reallocate back and forth).
  const camera = useThree(({ camera }) => camera)
  const [close, setClose] = useState(false)
  const sinceCheck = useRef(0)
  useFrame((_, delta) => {
    sinceCheck.current += delta
    if (sinceCheck.current < 0.5) return
    sinceCheck.current = 0
    const p = camera.position
    const g = ecefToGeodetic(p.x, p.y, p.z)
    const height = g.height - geoidHeight(g.lat, g.lon)
    if (!close && height < CLOSE_ENTER_M) setClose(true)
    else if (close && height > CLOSE_EXIT_M) setClose(false)
    // "Far" relative to the camera's height: looking down from 10 km, the
    // ground below isn't far; toward the horizon it is.
    if (!config.tilesDisabled) {
      getGoogleTiles({ apiKey: config.googleMapsApiKey }).errorFalloffDensity = 1 / Math.max(FAR_MIN_M, FAR_HEIGHTS * height)
    }
  })

  // Night: sharp only up close (see nightMaxDpr, closeNightMaxDpr).
  const maxDpr = dark ? (close ? preset.closeNightMaxDpr : preset.nightMaxDpr) : preset.maxDpr
  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, maxDpr) * scale)
  }, [setDpr, maxDpr, scale])

  useFrame((_, delta) => {
    if (resolutionStore.get().locked) return
    if (governor.sample(delta)) {
      resolutionStore.set({ scale: governor.scale, tileFactor: governor.tileFactor })
    }
    // Auto quality that still can't keep up at the lowest resolution steps
    // down a preset: a lighter preset at full sharpness looks better than a
    // heavy one rendered blurry.
    const quality = qualityStore.get()
    if (quality.choice === 'auto' && quality.level !== 'low' && governor.takeDowngrade()) stepDownAuto()
  })

  useEffect(() => {
    if (config.tilesDisabled) return
    const tiles = getGoogleTiles({ apiKey: config.googleMapsApiKey })
    // Lit facades make close city geometry visible at night. Preserve their
    // shape while retaining the cheaper terrain target beyond the close view.
    const nightFactor = dark ? (close ? preset.closeNightTileFactor : NIGHT_TILE_FACTOR) : 1
    tiles.errorTarget = preset.tileErrorTarget * tileFactor * nightFactor
    // ...except around airports, where the night is spent looking.
    setAirportDetailBoost(nightFactor)
    setTileCacheBytes(tiles, preset.tileCacheBytes)
    // Distant terrain gets coarser tiles than the target: it's small, in
    // haze, and away from where you look, and it's where most tiles go in
    // views toward the horizon (what filled the cache on Ultra, leaving
    // nearer tiles unloaded).
    tiles.errorFalloff = tiles.errorTarget * FAR_COARSER
    // The tile cross-fade is a screen-door dither: at night it turned the
    // lights drawn on fading terrain into a grid of dots (neighbouring
    // pixels on different tiles). The terrain is barely visible then, so
    // tiles swap at once; the lights fade in on their own.
    const fade = tiles.getPluginByName('FADE_TILES_PLUGIN') as { fadeDuration: number } | null
    if (fade != null) fade.fadeDuration = dark ? 1 : TILE_FADE_MS
  }, [preset.tileErrorTarget, preset.tileCacheBytes, preset.closeNightTileFactor, tileFactor, dark, close])

  return null
}
