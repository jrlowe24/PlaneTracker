import {
  greatCircleDistance,
  type AircraftState
} from '@windowseat/shared'

export interface CacheEntry {
  state: AircraftState
  /** Server wall time when the upstream last reported this aircraft. */
  lastSeenAt: number
  /** Increments whenever `state` changes; lets the hub send only deltas. */
  revision: number
}

/** Latest state per aircraft, keyed by ICAO hex. */
export class AircraftCache {
  private readonly entries = new Map<string, CacheEntry>()
  private revision = 0

  get size(): number {
    return this.entries.size
  }

  get(hex: string): CacheEntry | undefined {
    return this.entries.get(hex)
  }

  /**
   * Inserts or updates states. An older position never replaces a newer one,
   * which matters when overlapping regions return the same aircraft.
   */
  upsert(states: readonly AircraftState[], receivedAt: number): number {
    let changed = 0
    for (const state of states) {
      const entry = this.entries.get(state.hex)
      if (entry == null) {
        this.entries.set(state.hex, {
          state,
          lastSeenAt: receivedAt,
          revision: ++this.revision
        })
        ++changed
        continue
      }
      entry.lastSeenAt = Math.max(entry.lastSeenAt, receivedAt)
      if (state.positionTimestamp > entry.state.positionTimestamp) {
        entry.state = state
        entry.revision = ++this.revision
        ++changed
      }
    }
    return changed
  }

  /** Removes aircraft not reported for `maxAgeMs`; returns their hex codes. */
  prune(now: number, maxAgeMs: number): string[] {
    const removed: string[] = []
    for (const [hex, entry] of this.entries) {
      if (now - entry.lastSeenAt > maxAgeMs) {
        this.entries.delete(hex)
        removed.push(hex)
      }
    }
    return removed
  }

  clear(): void {
    this.entries.clear()
  }

  /** Entries within `radiusMeters` of a point. */
  *within(lat: number, lon: number, radiusMeters: number): Generator<CacheEntry> {
    // Cheap latitude band rejection before the haversine.
    const latBand = radiusMeters / 111_000 + 0.01
    for (const entry of this.entries.values()) {
      if (Math.abs(entry.state.lat - lat) > latBand) continue
      if (
        greatCircleDistance(lat, lon, entry.state.lat, entry.state.lon) <=
        radiusMeters
      ) {
        yield entry
      }
    }
  }
}
