import { decodeAircraft, type AircraftState } from '@windowseat/shared'

import type { Fixture } from '../fixtures'
import type { FlightSource, FlightSourceListener } from './types'

/**
 * Plays a recorded fixture back in real time, on a loop. Timestamps are
 * shifted so the data looks live. Each loop starts with a reset so clients
 * don't interpolate from the end of the recording back to its start.
 */
export class ReplaySource implements FlightSource {
  readonly name: string
  readonly attribution: string
  readonly attributionUrl: string | null = 'https://adsb.lol'

  private timer: NodeJS.Timeout | null = null
  private readonly durationMs: number

  constructor(private readonly fixture: Fixture) {
    this.name = `replay:${fixture.header.name}`
    this.attribution = `${fixture.header.attribution} — recorded ${new Date(
      fixture.header.recordedAt
    )
      .toISOString()
      .slice(0, 10)}`
    const last = fixture.frames.at(-1)?.t ?? 0
    this.durationMs = last + fixture.header.intervalMs
  }

  setRegions(): void {
    // Replay always plays the whole recording.
  }

  start(listener: FlightSourceListener): void {
    if (this.timer != null || this.fixture.frames.length === 0) return
    const { frames, header } = this.fixture
    let loopStart = Date.now()
    let index = 0
    let loop = 0

    const tick = (): void => {
      const now = Date.now()
      let elapsed = now - loopStart
      if (elapsed >= this.durationMs) {
        loopStart += this.durationMs
        elapsed = now - loopStart
        index = 0
        ++loop
        listener.onReset?.()
        console.info(`[replay] loop ${loop}`)
      }
      // Recorded timestamp + shift = live timestamp.
      const shift = loopStart - header.recordedAt
      while (index < frames.length && frames[index]!.t <= elapsed) {
        const frame = frames[index]!
        const states: AircraftState[] = frame.ac.map(tuple => {
          const state = decodeAircraft(tuple)
          state.positionTimestamp += shift
          return state
        })
        listener.onAircraft(states, now)
        ++index
      }
    }
    tick()
    this.timer = setInterval(tick, 100)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}
