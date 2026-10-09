import type { AircraftState } from '@windowseat/shared'

import { regionKey } from '../regions'
import type { Region } from './types'

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

export interface RegionPollerOptions {
  /**
   * Starting and minimum time between the starts of two upstream requests
   * (all regions). The poller adapts upward when the upstream rate-limits.
   */
  minRequestIntervalMs: number
  /** Upper bound for the adaptive request interval. */
  maxRequestIntervalMs: number
  /** Minimum time between two polls of the same region. */
  minRegionIntervalMs: number
  requestTimeoutMs: number
  initialBackoffMs: number
  maxBackoffMs: number
  /** Polls beyond this many regions are dropped (lowest priority last). */
  maxRegions: number
}

export const defaultRegionPollerOptions: RegionPollerOptions = {
  // Measured 2026-10: adsb.lol's nginx limiter allows a burst of ~2 requests
  // per IP, then roughly one every 5 s.
  minRequestIntervalMs: 5500,
  maxRequestIntervalMs: 60_000,
  // adsb.lol caches point queries for 5 s.
  minRegionIntervalMs: 5000,
  requestTimeoutMs: 10_000,
  initialBackoffMs: 2000,
  maxBackoffMs: 120_000,
  // 8 regions × 5.5 s ≈ 45 s per refresh, inside the 60 s stale limit.
  maxRegions: 8
}

export interface RegionSchedule {
  key: string
  region: Region
  lastPolledAt: number
}

/**
 * Picks the region whose data is oldest, provided it is due. Regions that
 * were never polled come first, in the order given.
 */
export function pickNextRegion(
  schedules: readonly RegionSchedule[],
  now: number,
  minRegionIntervalMs: number
): RegionSchedule | null {
  let best: RegionSchedule | null = null
  for (const schedule of schedules) {
    if (now - schedule.lastPolledAt < minRegionIntervalMs) continue
    if (best == null || schedule.lastPolledAt < best.lastPolledAt) {
      best = schedule
    }
  }
  return best
}

/**
 * Additive-increase/multiplicative-decrease style adaptation of the request
 * interval: rate limiting widens it by half, every success after that narrows
 * it by 3 % until it is back at the minimum.
 */
export function adaptRequestInterval(
  currentMs: number,
  rateLimited: boolean,
  options: Pick<RegionPollerOptions, 'minRequestIntervalMs' | 'maxRequestIntervalMs'>
): number {
  const next = rateLimited ? currentMs * 1.5 + 500 : currentMs * 0.97
  return Math.min(
    options.maxRequestIntervalMs,
    Math.max(options.minRequestIntervalMs, next)
  )
}

/** Exponential backoff that honors Retry-After when the upstream sends one. */
export function nextBackoff(
  previousMs: number,
  error: unknown,
  options: Pick<RegionPollerOptions, 'initialBackoffMs' | 'maxBackoffMs'>
): number {
  const doubled =
    previousMs === 0 ? options.initialBackoffMs : previousMs * 2
  const retryAfter =
    error instanceof UpstreamError ? (error.retryAfterMs ?? 0) : 0
  return Math.min(options.maxBackoffMs, Math.max(doubled, retryAfter))
}

/**
 * One upstream poller for all clients: a single request in flight at a time,
 * spaced at least `minRequestIntervalMs` apart (adapting upward on 429),
 * each region refreshed at most every `minRegionIntervalMs`. With N regions
 * every region is refreshed about every max(minRegionIntervalMs,
 * N × request interval).
 */
export class RegionPoller {
  private readonly options: RegionPollerOptions
  private schedules: RegionSchedule[] = []
  private timer: NodeJS.Timeout | null = null
  private inFlight: AbortController | null = null
  private nextRequestAt = 0
  private backoffMs = 0
  private requestIntervalMs: number
  private onData: ((states: AircraftState[], receivedAt: number) => void) | null =
    null

  constructor(
    private readonly fetchRegion: (
      region: Region,
      signal: AbortSignal
    ) => Promise<AircraftState[]>,
    options: Partial<RegionPollerOptions> = {}
  ) {
    this.options = { ...defaultRegionPollerOptions, ...options }
    this.requestIntervalMs = this.options.minRequestIntervalMs
  }

  /** Current adaptive spacing between upstream requests. */
  get requestInterval(): number {
    return this.requestIntervalMs
  }

  setRegions(regions: Region[]): void {
    const previous = new Map(this.schedules.map(s => [s.key, s]))
    this.schedules = regions.slice(0, this.options.maxRegions).map(region => {
      const key = regionKey(region)
      return previous.get(key) ?? { key, region, lastPolledAt: 0 }
    })
    if (regions.length > this.options.maxRegions) {
      console.warn(
        `[poller] ${regions.length} regions requested, polling the first ${this.options.maxRegions}`
      )
    }
  }

  start(onData: (states: AircraftState[], receivedAt: number) => void): void {
    this.onData = onData
    if (this.timer != null) return
    this.timer = setInterval(() => {
      this.tick()
    }, 200)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
    this.inFlight?.abort()
    this.inFlight = null
  }

  private tick(): void {
    const now = Date.now()
    if (this.inFlight != null || now < this.nextRequestAt) return
    const schedule = pickNextRegion(
      this.schedules,
      now,
      this.options.minRegionIntervalMs
    )
    if (schedule == null) return

    schedule.lastPolledAt = now
    this.nextRequestAt = now + this.requestIntervalMs
    const controller = new AbortController()
    this.inFlight = controller
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.options.requestTimeoutMs)

    this.fetchRegion(schedule.region, controller.signal)
      .then(states => {
        this.backoffMs = 0
        this.requestIntervalMs = adaptRequestInterval(
          this.requestIntervalMs,
          false,
          this.options
        )
        this.onData?.(states, Date.now())
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted && this.timer == null) return
        const rateLimited = error instanceof UpstreamError && error.status === 429
        if (rateLimited) {
          this.requestIntervalMs = adaptRequestInterval(
            this.requestIntervalMs,
            true,
            this.options
          )
        }
        this.backoffMs = nextBackoff(this.backoffMs, error, this.options)
        this.nextRequestAt = Date.now() + this.backoffMs
        // Let the region be retried right after the backoff.
        schedule.lastPolledAt = 0
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `[poller] ${message}; backing off ${Math.round(this.backoffMs / 1000)} s, request interval now ${(this.requestIntervalMs / 1000).toFixed(1)} s`
        )
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.inFlight === controller) this.inFlight = null
      })
  }
}
