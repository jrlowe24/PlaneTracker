import type { Attribution, AircraftState } from '@windowseat/shared'

import { normalizeReadsb, USER_AGENT, type ReadsbResponse } from './adsbLol'

/**
 * Worldwide overview from any feed that serves every aircraft as one
 * readsb-format JSON document (`{ now, ac: [...] }`), e.g. airplanes.live
 * or adsb.lol with granted access. Configured by environment:
 *
 * - GLOBAL_FEED_URL: the snapshot URL (required to enable it);
 * - GLOBAL_FEED_HEADERS: extra request headers as JSON, e.g. an API key
 *   (`{"api-auth":"…"}`); never logged;
 * - GLOBAL_FEED_INTERVAL_S: seconds between snapshots (default 60);
 * - GLOBAL_FEED_ATTRIBUTION / GLOBAL_FEED_ATTRIBUTION_URL: the credit line.
 *
 * Replaces the OpenSky snapshot, whose API refuses connections from cloud
 * hosts (Railway's included).
 */

export interface OverviewSource {
  readonly attribution: Attribution
  /** How long overview aircraft stay valid. */
  readonly maxAgeMs: number
  start(): void
  stop(): void
}

const DEFAULT_INTERVAL_S = 60

export class ReadsbSnapshot implements OverviewSource {
  readonly attribution: Attribution
  readonly maxAgeMs: number
  private readonly intervalMs: number
  private readonly headers: Record<string, string>
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly url: string,
    private readonly onData: (states: AircraftState[], receivedAt: number) => void,
    env: NodeJS.ProcessEnv = process.env
  ) {
    const interval = Number(env.GLOBAL_FEED_INTERVAL_S)
    this.intervalMs = (Number.isFinite(interval) && interval >= 10 ? interval : DEFAULT_INTERVAL_S) * 1000
    this.maxAgeMs = 3 * this.intervalMs + 60_000
    let headers: Record<string, string> = {}
    try {
      headers = env.GLOBAL_FEED_HEADERS != null ? (JSON.parse(env.GLOBAL_FEED_HEADERS) as Record<string, string>) : {}
    } catch {
      console.warn('[global] GLOBAL_FEED_HEADERS is not valid JSON; ignored')
    }
    this.headers = headers
    this.attribution = {
      text: env.GLOBAL_FEED_ATTRIBUTION ?? 'Worldwide overview: airplanes.live',
      url: env.GLOBAL_FEED_ATTRIBUTION_URL ?? 'https://airplanes.live'
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    let next = this.intervalMs
    try {
      const response = await fetch(this.url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...this.headers },
        signal: AbortSignal.timeout(30_000)
      })
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'))
        next = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 5 * this.intervalMs
        throw new Error('rate limited')
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as ReadsbResponse
      // readsb files give `now` in seconds, the v2 APIs in milliseconds.
      if (typeof body.now === 'number' && body.now < 1e11) body.now *= 1000
      const states = normalizeReadsb(body, Date.now()).map(s => ({ ...s, overview: true as const }))
      this.onData(states, Date.now())
      console.info(`[global] ${states.length} aircraft worldwide; next in ${Math.round(next / 1000)} s`)
    } catch (error) {
      console.warn('[global] snapshot failed:', error instanceof Error ? error.message : error)
      next = Math.max(next, 2 * this.intervalMs)
    }
    if (this.running) this.timer = setTimeout(() => void this.tick(), next)
  }
}
