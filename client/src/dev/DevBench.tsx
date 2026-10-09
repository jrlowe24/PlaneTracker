import { advance, useThree } from '@react-three/fiber'
import { useEffect, type FC } from 'react'

export interface BenchResult {
  frames: number
  /** Mean CPU + GPU time per frame (GPU synchronized each frame), ms. */
  meanMs: number
  p95Ms: number
  /** 1000 / mean: the frame rate this frame cost allows. */
  fps: number
}

/**
 * Dev-only frame benchmark: `await __windowSeatBench(120)` renders frames
 * synchronously (R3F advance) and forces the GPU to finish each one with a
 * 1-pixel readback. Works even when the tab is throttled (hidden pane), so
 * frame cost can be measured independently of requestAnimationFrame.
 */
export const DevBench: FC = () => {
  const state = useThree()
  useEffect(() => {
    const gl = state.gl.getContext()
    const pixel = new Uint8Array(4)
    const bench = async (frames = 120): Promise<BenchResult> => {
      const times: number[] = []
      let timestamp = performance.now()
      for (let i = 0; i < frames + 10; ++i) {
        const start = performance.now()
        timestamp += 1000 / 60
        advance(timestamp, true, state)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        const elapsed = performance.now() - start
        if (i >= 10) times.push(elapsed)
        // Yield so network messages and timers still run.
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0))
      }
      times.sort((a, b) => a - b)
      const meanMs = times.reduce((a, b) => a + b, 0) / times.length
      return {
        frames,
        meanMs: Math.round(meanMs * 100) / 100,
        p95Ms: Math.round(times[Math.floor(times.length * 0.95)]! * 100) / 100,
        fps: Math.round(1000 / meanMs)
      }
    }
    const w = window as { __windowSeatBench?: typeof bench }
    w.__windowSeatBench = bench
    return () => {
      delete w.__windowSeatBench
    }
  }, [state])
  return null
}
