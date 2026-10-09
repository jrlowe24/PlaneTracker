import type { AircraftState } from '@windowseat/shared'

import { normalizeReadsb, USER_AGENT, type ReadsbResponse } from './adsbLol'
import { nextBackoff, UpstreamError } from './regionPoller'

/**
 * Fast updates for the aircraft clients are following, from adsb.fi's open
 * data API (readsb format, same as adsb.lol). Measured October 2026:
 * `GET /api/v2/hex/{hex}` served 1 request/s without rate limiting, with
 * positions < 0.4 s old. Terms (per third-party summary): personal,
 * non-commercial use with attribution and a link.
 *
 * One request at a time, ≥ 1.1 s apart, round-robin over followed hexes;
 * the rest of the traffic stays on the slower adsb.lol region poller.
 * One-off lookups (worldwide search by callsign, registration or hex) share
 * the same slot and go first.
 */

export const ADSB_FI_BASE_URL = 'https://opendata.adsb.fi/api'
export const ADSB_FI_ATTRIBUTION = {
  text: 'Followed aircraft: adsb.fi',
  url: 'https://adsb.fi'
}

const REQUEST_INTERVAL_MS = 1100
const MAX_QUEUED_LOOKUPS = 8

interface Lookup {
  path: string
  resolve: (states: AircraftState[]) => void
}

export class FollowFeed {
  private hexes: string[] = []
  private next = 0
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private pausedUntil = 0
  private backoffMs = 0
  private readonly lookups: Lookup[] = []

  constructor(
    private readonly onData: (states: AircraftState[], receivedAt: number) => void,
    private readonly baseUrl = ADSB_FI_BASE_URL
  ) {}

  /** The set of hex codes being followed by any client. */
  setHexes(hexes: Iterable<string>): void {
    this.hexes = [...new Set(hexes)]
    this.next = 0
  }

  /**
   * Queues a lookup (`/v2/callsign/UAL1`, `/v2/registration/N123AB`,
   * `/v2/hex/abc123`) in the shared request slot. Resolves with the
   * aircraft found (empty on errors or when the queue is full).
   */
  lookup(path: string): Promise<AircraftState[]> {
    if (this.lookups.length >= MAX_QUEUED_LOOKUPS) return Promise.resolve([])
    return new Promise(resolve => {
      this.lookups.push({ path, resolve })
    })
  }

  start(): void {
    this.timer ??= setInterval(() => {
      void this.tick()
    }, REQUEST_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    if (Date.now() < this.pausedUntil) {
      // Don't leave searches hanging through a long backoff.
      for (const lookup of this.lookups.splice(0)) lookup.resolve([])
      return
    }
    const lookup = this.lookups.shift()
    if (lookup == null && this.hexes.length === 0) return
    const path = lookup?.path ?? `/v2/hex/${this.hexes[this.next++ % this.hexes.length]!}`
    this.busy = true
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(5000)
      })
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'))
        throw new UpstreamError(
          `adsb.fi ${response.status} for ${path}`,
          response.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
        )
      }
      const body = (await response.json()) as ReadsbResponse
      this.backoffMs = 0
      const states = normalizeReadsb(body, Date.now())
      this.onData(states, Date.now())
      lookup?.resolve(states)
    } catch (error) {
      lookup?.resolve([])
      this.backoffMs = nextBackoff(this.backoffMs, error, {
        initialBackoffMs: 2000,
        maxBackoffMs: 60_000
      })
      this.pausedUntil = Date.now() + this.backoffMs
      console.warn(
        `[follow] ${error instanceof Error ? error.message : String(error)}; pausing ${Math.round(this.backoffMs / 1000)} s`
      )
    } finally {
      this.busy = false
    }
  }
}
