import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type FC } from 'react'

import { config } from '../config'
import { getGoogleTiles } from '../globe/googleTiles'
import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'
import { resolutionStore } from '../state/resolution'

/** Frame time budget: 60 fps with a little slack. */
const TARGET_MS = 1000 / 60
const SLOW_MS = TARGET_MS * 1.12
const MIN_SCALE = 0.5
const STEP_DOWN = 0.85
const STEP_UP = 1.08
/** Seconds of averaging before a decision; going up needs longer. */
const WINDOW_DOWN_S = 0.75
const WINDOW_UP_S = 3

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
  private sum = 0
  private count = 0
  private elapsed = 0

  /** Returns a new scale when it should change, else null. */
  sample(deltaS: number): number | null {
    const ms = deltaS * 1000
    // Ignore stalls (tab hidden, debugger, page load hitches).
    if (ms > 250) return null
    this.sum += ms
    this.count += 1
    this.elapsed += deltaS
    const mean = this.sum / this.count
    let next: number | null = null
    if (this.elapsed >= WINDOW_DOWN_S && mean > SLOW_MS && this.scale > MIN_SCALE) {
      next = Math.max(MIN_SCALE, this.scale * STEP_DOWN)
    } else if (this.elapsed >= WINDOW_UP_S && mean < TARGET_MS * 1.04 && this.scale < 1) {
      next = Math.min(1, this.scale * STEP_UP)
    }
    if (next != null || this.elapsed >= WINDOW_UP_S) {
      this.sum = 0
      this.count = 0
      this.elapsed = 0
    }
    if (next == null) return null
    this.scale = Math.round(next * 20) / 20
    return this.scale
  }

  reset(): void {
    this.scale = 1
    this.sum = 0
    this.count = 0
    this.elapsed = 0
  }
}

/** Applies the quality preset's resolution (adaptively) and tile error target. */
export const QualityApplier: FC = () => {
  const setDpr = useThree(({ setDpr }) => setDpr)
  const level = useStore(qualityStore, s => s.level)
  const preset = QUALITY_PRESETS[level]
  const governor = useMemo(() => new ResolutionGovernor(), [])
  const scale = useStore(resolutionStore, s => s.scale)

  useEffect(() => {
    // A new preset starts at full resolution again.
    governor.reset()
    resolutionStore.set({ scale: 1 })
  }, [governor, preset.maxDpr])

  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, preset.maxDpr) * scale)
  }, [setDpr, preset.maxDpr, scale])

  useFrame((_, delta) => {
    const next = governor.sample(delta)
    if (next != null) resolutionStore.set({ scale: next })
  })

  useEffect(() => {
    if (config.tilesDisabled) return
    getGoogleTiles({ apiKey: config.googleMapsApiKey }).errorTarget = preset.tileErrorTarget
  }, [preset.tileErrorTarget])

  return null
}
