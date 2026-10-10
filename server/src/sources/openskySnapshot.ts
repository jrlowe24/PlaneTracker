import type { Attribution, AircraftState } from '@windowseat/shared'

import { USER_AGENT } from './adsbLol'

/**
 * Worldwide overview from the OpenSky Network: one `GET /api/states/all`
 * returns every aircraft they track (~6-7k), which lets zoomed-out views
 * show all traffic at once while live regional polling (adsb.lol) refines
 * the area in view.
 *
 * Budget (OpenSky API credits, 4 per global request): anonymous 400/day,
 * so one snapshot every 15 min; with OAuth client credentials
 * (OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET) 4000/day, so every 90 s.
 * The remaining-credits header stretches the interval as the budget runs
 * low. Data: OpenSky Network, non-commercial use with attribution.
 */

export const OPENSKY_ATTRIBUTION: Attribution = {
  text: 'Worldwide overview: The OpenSky Network',
  url: 'https://opensky-network.org'
}

const API = 'https://opensky-network.org/api/states/all?extended=1'
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const ANONYMOUS_INTERVAL_MS = 15 * 60_000
const AUTHENTICATED_INTERVAL_MS = 90_000
/** Positions older than this at snapshot time are dropped. */
const MAX_POSITION_AGE_S = 120

/** OpenSky aircraft category (extended=1) to the ADS-B emitter category. */
const CATEGORIES: Record<number, string> = {
  2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 7: 'A6', 8: 'A7',
  9: 'B1', 10: 'B2', 11: 'B3', 12: 'B4', 13: 'B6', 14: 'B7'
}

type StateVector = [
  string, string | null, string, number | null, number, number | null, number | null,
  number | null, boolean, number | null, number | null, number | null, unknown,
  number | null, string | null, boolean, number, number?
]

export function normalizeOpenSky(states: StateVector[], snapshotTime: number): AircraftState[] {
  const out: AircraftState[] = []
  for (const s of states) {
    const [icao, callsign, , timePosition, , lon, lat, baro, onGround, velocity, track, vrate, , geo, squawk] = s
    if (lat == null || lon == null || timePosition == null) continue
    if (snapshotTime - timePosition > MAX_POSITION_AGE_S) continue
    const ft = (m: number | null): number | null => (m == null ? null : Math.round(m / 0.3048))
    out.push({
      hex: icao.toLowerCase(),
      callsign: callsign?.trim() || null,
      registration: null,
      typeCode: null,
      category: s[17] != null ? (CATEGORIES[s[17]] ?? null) : null,
      squawk: squawk ?? null,
      lat,
      lon,
      altBaro: onGround ? null : ft(baro),
      altGeom: onGround ? null : ft(geo),
      onGround,
      groundSpeed: velocity == null ? null : velocity * 1.943844,
      track,
      verticalRate: vrate == null ? null : Math.round(vrate * 196.85),
      positionTimestamp: timePosition * 1000,
      overview: true
    })
  }
  return out
}

export class OpenSkySnapshot {
  private timer: NodeJS.Timeout | null = null
  private token: { value: string; expiresAt: number } | null = null
  private readonly clientId = process.env.OPENSKY_CLIENT_ID
  private readonly clientSecret = process.env.OPENSKY_CLIENT_SECRET
  /** How long overview aircraft stay valid (a little over two intervals). */
  readonly maxAgeMs: number

  constructor(private readonly onData: (states: AircraftState[], receivedAt: number) => void) {
    this.maxAgeMs = 2 * this.baseInterval() + 120_000
  }

  private baseInterval(): number {
    return this.clientId != null && this.clientSecret != null
      ? AUTHENTICATED_INTERVAL_MS
      : ANONYMOUS_INTERVAL_MS
  }

  start(): void {
    if (this.timer != null) return
    void this.tick()
  }

  stop(): void {
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.tick()
    }, ms)
  }

  private async authHeader(): Promise<Record<string, string>> {
    if (this.clientId == null || this.clientSecret == null) return {}
    if (this.token == null || Date.now() > this.token.expiresAt - 60_000) {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret
        }),
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`OpenSky token ${response.status}`)
      const body = (await response.json()) as { access_token: string; expires_in: number }
      this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    }
    return { authorization: `Bearer ${this.token.value}` }
  }

  private async tick(): Promise<void> {
    let next = this.baseInterval()
    try {
      const response = await fetch(API, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(await this.authHeader()) },
        signal: AbortSignal.timeout(30_000)
      })
      const remaining = Number(response.headers.get('x-rate-limit-remaining'))
      if (response.status === 429) {
        const retry = Number(response.headers.get('x-rate-limit-retry-after-seconds'))
        next = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60 * 60_000
        throw new Error('OpenSky rate limited')
      }
      if (!response.ok) throw new Error(`OpenSky ${response.status}`)
      const body = (await response.json()) as { time: number; states: StateVector[] | null }
      const states = normalizeOpenSky(body.states ?? [], body.time)
      this.onData(states, Date.now())
      // Stretch the interval when the daily budget runs low.
      if (Number.isFinite(remaining) && remaining < 40) next *= 4
      console.info(`[opensky] ${states.length} aircraft worldwide; next in ${Math.round(next / 1000)} s`)
    } catch (error) {
      // fetch() wraps network errors ("fetch failed"); the cause says why
      // (timeout, reset, DNS, TLS).
      const cause = error instanceof Error && error.cause != null ? error.cause : null
      const detail =
        cause instanceof Error ? `${cause.name}: ${cause.message}${'code' in cause ? ` (${String(cause.code)})` : ''}` : ''
      console.warn('[opensky]', error instanceof Error ? error.message : error, detail)
      // Network failures retry soon; API errors (rate limit etc.) keep the
      // interval chosen above.
      next = cause != null ? Math.max(60_000, Math.min(next, 5 * 60_000)) : Math.max(next, 5 * 60_000)
    }
    if (this.timer !== null || next > 0) this.schedule(next)
  }
}
