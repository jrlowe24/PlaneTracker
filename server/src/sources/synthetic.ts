import {
  destinationPoint,
  initialBearing,
  knotsToMetersPerSecond,
  type AircraftState
} from '@windowseat/shared'

import type { FlightSource, FlightSourceListener } from './types'

interface SyntheticAircraft {
  hex: string
  callsign: string
  typeCode: string
  lat0: number
  lon0: number
  bearing0: number
  speedKt: number
  altitudeFt: number
}

const TYPES = ['A320', 'B738', 'A21N', 'B77W', 'A359', 'E75L', 'AT76', 'C172', 'GLF6', 'B39M']

/** Deterministic PRNG so runs are comparable. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Latitudes biased toward 20–60° N like real traffic (resampled, not clamped). */
function sampleLatitude(random: () => number): number {
  for (;;) {
    const lat = 40 + (random() + random() + random() - 1.5) * 50
    if (lat > -60 && lat < 80) return lat
  }
}

/**
 * Stress-test source: N aircraft on great circles all over the globe
 * (denser at mid-northern latitudes, like real traffic). Each aircraft is
 * reported every ~5 s, staggered, like a polled feed.
 */
export class SyntheticSource implements FlightSource {
  readonly name: string
  readonly attribution = 'Synthetic test traffic'
  readonly attributionUrl = null

  private readonly aircraft: SyntheticAircraft[] = []
  private readonly startedAt = Date.now()
  private timer: NodeJS.Timeout | null = null

  constructor(count: number, seed = 1) {
    this.name = `synthetic:${count}`
    const random = mulberry32(seed)
    for (let i = 0; i < count; ++i) {
      const typeCode = TYPES[i % TYPES.length]!
      this.aircraft.push({
        hex: `f${i.toString(16).padStart(5, '0')}`,
        callsign: `TST${i}`,
        typeCode,
        lat0: sampleLatitude(random),
        lon0: random() * 360 - 180,
        bearing0: random() * 360,
        speedKt: typeCode === 'C172' ? 110 : 380 + random() * 120,
        altitudeFt: typeCode === 'C172' ? 4500 : 28_000 + Math.round(random() * 12) * 1000
      })
    }
  }

  setRegions(): void {
    // Everything is synthesized; regions don't matter.
  }

  private stateAt(a: SyntheticAircraft, now: number): AircraftState {
    const seconds = (now - this.startedAt) / 1000
    const distance = knotsToMetersPerSecond(a.speedKt) * seconds
    const p = destinationPoint(a.lat0, a.lon0, a.bearing0, distance)
    const ahead = destinationPoint(a.lat0, a.lon0, a.bearing0, distance + 1000)
    return {
      hex: a.hex,
      callsign: a.callsign,
      registration: null,
      typeCode: a.typeCode,
      category: a.typeCode === 'C172' ? 'A1' : 'A3',
      squawk: '2000',
      lat: p.lat,
      lon: p.lon,
      altBaro: a.altitudeFt,
      altGeom: a.altitudeFt + 100,
      onGround: false,
      groundSpeed: a.speedKt,
      track: initialBearing(p.lat, p.lon, ahead.lat, ahead.lon),
      verticalRate: 0,
      positionTimestamp: now
    }
  }

  start(listener: FlightSourceListener): void {
    if (this.timer != null) return
    let slot = 0
    const slots = 5
    const emit = (all: boolean): void => {
      const now = Date.now()
      const states: AircraftState[] = []
      for (let i = all ? 0 : slot; i < this.aircraft.length; i += all ? 1 : slots) {
        states.push(this.stateAt(this.aircraft[i]!, now))
      }
      slot = (slot + 1) % slots
      listener.onAircraft(states, now)
    }
    emit(true)
    this.timer = setInterval(() => {
      emit(false)
    }, 1000)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}
