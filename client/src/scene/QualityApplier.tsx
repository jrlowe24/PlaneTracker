import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type FC } from 'react'

import { config } from '../config'
import { getGoogleTiles } from '../globe/googleTiles'
import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'
import { resolutionStore } from '../state/resolution'

/** Frame time budget: 60 fps with a little slack. */
const TARGET_MS = 1000 / 60
/**
 * Only sustained slowness (below ~48 fps) costs sharpness: brief dips and
 * 50-55 fps aren't worth a visibly softer image.
 */
const SLOW_MS = TARGET_MS * 1.25
const MIN_SCALE = 0.6
const STEP_DOWN = 0.9
const STEP_UP = 1.08
/** Below this scale, coarser terrain is traded in before more resolution. */
const TILE_TRADE_SCALE = 0.7
const MAX_TILE_FACTOR = 1.5
const TILE_STEP = 1.25
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
      // Resolution first; once it's fairly low, coarser terrain too
      // (draw calls and triangles cost CPU and vertex time resolution
      // can't win back).
      if (this.scale <= TILE_TRADE_SCALE && this.tileFactor < MAX_TILE_FACTOR) {
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
  const level = useStore(qualityStore, s => s.level)
  const preset = QUALITY_PRESETS[level]
  const governor = useMemo(() => new ResolutionGovernor(), [])
  const scale = useStore(resolutionStore, s => s.scale)
  const tileFactor = useStore(resolutionStore, s => s.tileFactor)

  useEffect(() => {
    // A new preset starts at full resolution again.
    governor.reset()
    resolutionStore.set({ scale: 1, tileFactor: 1 })
  }, [governor, preset.maxDpr])

  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, preset.maxDpr) * scale)
  }, [setDpr, preset.maxDpr, scale])

  useFrame((_, delta) => {
    if (resolutionStore.get().locked) return
    if (governor.sample(delta)) {
      resolutionStore.set({ scale: governor.scale, tileFactor: governor.tileFactor })
    }
    // Auto quality that still can't keep up at the lowest resolution steps
    // down a preset: a lighter preset at full sharpness looks better than a
    // heavy one rendered blurry.
    const quality = qualityStore.get()
    if (quality.choice === 'auto' && quality.level !== 'low' && governor.takeDowngrade()) {
      qualityStore.set({ level: quality.level === 'high' ? 'medium' : 'low' })
    }
  })

  useEffect(() => {
    if (config.tilesDisabled) return
    getGoogleTiles({ apiKey: config.googleMapsApiKey }).errorTarget =
      preset.tileErrorTarget * tileFactor
  }, [preset.tileErrorTarget, tileFactor])

  return null
}
