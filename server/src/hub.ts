import {
  encodeAircraft,
  greatCircleDistance,
  nauticalMilesToMeters,
  type AircraftMessage,
  type AircraftTuple,
  type ClientMessage,
  type HelloMessage,
  type RouteInfo,
  type RoutesMessage,
  type Viewport,
  type WeatherGridMessage,
  type WeatherMessage
} from '@windowseat/shared'
import type { WebSocket } from 'ws'

import type { AircraftCache } from './cache'
import { mergeViewports } from './regions'
import type { RouteResolver } from './routes'
import { ADSB_FI_ATTRIBUTION, type FollowFeed } from './sources/followFeed'
import { OPEN_METEO_ATTRIBUTION, type WeatherService } from './weather'
import type { FlightSource } from './sources/types'

export interface HubOptions {
  /** How often clients receive updates. */
  pushIntervalMs: number
  /** Aircraft not reported for this long are dropped. */
  staleAfterMs: number
  /** Viewports are widened by this factor so aircraft don't pop at the edge. */
  viewportMargin: number
  /** Skip a push when a client's socket has this much unsent data. */
  maxBufferedBytes: number
}

export const defaultHubOptions: HubOptions = {
  pushIntervalMs: 1000,
  staleAfterMs: 60_000,
  viewportMargin: 1.15,
  maxBufferedBytes: 4 * 1024 * 1024
}

/** Upper bound for a client viewport: a hemisphere. */
const MAX_VIEWPORT_RADIUS_NM = 5400

interface ClientSession {
  socket: WebSocket
  viewport: Viewport | null
  /** hex → cache revision last sent to this client. */
  sent: Map<string, number>
  /** Callsigns whose route this client already has. */
  sentRoutes: Set<string>
  /** Aircraft this client follows (fast updates), if any. */
  followHex: string | null
  /** Where weather was last sent for, and when. */
  weatherAt: { lat: number; lon: number } | null
  weatherSentAt: number
  /** Where the cloud cover grid was last sent for, and when. */
  gridAt: { lat: number; lon: number } | null
  gridSentAt: number
  resetPending: boolean
}

export function parseClientMessage(data: unknown): ClientMessage | null {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch {
    return null
  }
  if (typeof message !== 'object' || message == null) return null
  const m = message as { type?: unknown; viewport?: Partial<Viewport> }
  if (m.type === 'follow') {
    const hex = (message as { hex?: unknown }).hex
    if (hex === null) return { type: 'follow', hex: null }
    if (typeof hex === 'string' && /^~?[0-9a-f]{6}$/.test(hex)) return { type: 'follow', hex }
    return null
  }
  if (m.type === 'viewport' && m.viewport != null) {
    const { lat, lon, radiusNm } = m.viewport
    if (
      typeof lat === 'number' &&
      typeof lon === 'number' &&
      typeof radiusNm === 'number' &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      radiusNm > 0
    ) {
      return {
        type: 'viewport',
        viewport: {
          lat,
          lon,
          radiusNm: Math.min(radiusNm, MAX_VIEWPORT_RADIUS_NM)
        }
      }
    }
  }
  return null
}

/**
 * Connects WebSocket clients to the cache and the single upstream source.
 * Clients send their viewport; the hub merges all viewports into upstream
 * regions and pushes each client the aircraft inside its own viewport as
 * deltas (changed states + removals) at ~1 Hz.
 */
export class Hub {
  private readonly options: HubOptions
  private readonly clients = new Set<ClientSession>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly cache: AircraftCache,
    private readonly source: FlightSource,
    options: Partial<HubOptions> = {},
    private readonly routes: RouteResolver | null = null,
    private readonly followFeed: FollowFeed | null = null,
    private readonly weather: WeatherService | null = null
  ) {
    this.options = { ...defaultHubOptions, ...options }
  }

  start(): void {
    this.routes?.start()
    this.followFeed?.start()
    this.source.start({
      onAircraft: (states, receivedAt) => {
        this.cache.upsert(states, receivedAt)
      },
      onReset: () => {
        this.cache.clear()
        for (const client of this.clients) {
          client.resetPending = true
          client.sent.clear()
        }
      }
    })
    this.timer = setInterval(() => {
      this.push()
    }, this.options.pushIntervalMs)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
    this.routes?.stop()
    this.followFeed?.stop()
    this.source.stop()
  }

  get clientCount(): number {
    return this.clients.size
  }

  addClient(socket: WebSocket): void {
    const client: ClientSession = {
      socket,
      viewport: null,
      sent: new Map(),
      sentRoutes: new Set(),
      followHex: null,
      weatherAt: null,
      weatherSentAt: 0,
      gridAt: null,
      gridSentAt: 0,
      resetPending: false
    }
    this.clients.add(client)
    const hello: HelloMessage = {
      type: 'hello',
      serverTime: Date.now(),
      source: this.source.name,
      attribution: this.source.attribution,
      attributionUrl: this.source.attributionUrl,
      followAttribution: this.followFeed == null ? null : ADSB_FI_ATTRIBUTION
    }
    socket.send(JSON.stringify(hello))

    socket.on('message', data => {
      const message = parseClientMessage(data)
      if (message?.type === 'viewport') {
        client.viewport = message.viewport
        this.updateRegions()
        // Respond quickly with what the cache already has.
        this.pushTo(client, Date.now())
      } else if (message?.type === 'follow') {
        client.followHex = message.hex
        this.updateFollowed()
      }
    })
    socket.on('close', () => {
      this.clients.delete(client)
      this.updateRegions()
      this.updateFollowed()
    })
  }

  private updateFollowed(): void {
    if (this.followFeed == null) return
    const hexes: string[] = []
    for (const client of this.clients) {
      if (client.followHex != null) hexes.push(client.followHex)
    }
    this.followFeed.setHexes(hexes)
  }

  private updateRegions(): void {
    const viewports: Viewport[] = []
    for (const client of this.clients) {
      if (client.viewport != null) viewports.push(client.viewport)
    }
    this.source.setRegions(mergeViewports(viewports))
  }

  private push(): void {
    const now = Date.now()
    this.cache.prune(now, this.options.staleAfterMs)
    for (const client of this.clients) {
      this.pushTo(client, now)
      this.pushWeather(client, now)
    }
  }

  /**
   * Sends weather for the client's view center when the view has moved more
   * than ~50 km from where weather was last sent, or every 10 minutes. The
   * distance hysteresis keeps small pans across a 0.25° cell boundary from
   * flip-flopping the clouds.
   */
  private pushWeather(client: ClientSession, now: number): void {
    if (this.weather == null || client.viewport == null) return
    this.pushWeatherGrid(client, now)
    const { lat, lon } = client.viewport
    const last = client.weatherAt
    const moved = last == null ? Infinity : greatCircleDistance(last.lat, last.lon, lat, lon)
    if (moved < 50_000 && now - client.weatherSentAt < 10 * 60_000) return
    client.weatherAt = { lat, lon }
    client.weatherSentAt = now
    void this.weather.get(lat, lon).then(sample => {
      if (sample == null || client.socket.readyState !== client.socket.OPEN) return
      const message: WeatherMessage = {
        type: 'weather',
        serverTime: Date.now(),
        weather: sample,
        attribution: OPEN_METEO_ATTRIBUTION
      }
      client.socket.send(JSON.stringify(message))
    })
  }

  /**
   * Sends the cloud cover grid (1° cells, ~±350 km) around the view when
   * the view has moved more than ~80 km from where it was last sent (well
   * before the edge of the grid comes into view), or every 15 minutes.
   */
  private pushWeatherGrid(client: ClientSession, now: number): void {
    const { lat, lon } = client.viewport!
    const last = client.gridAt
    const moved = last == null ? Infinity : greatCircleDistance(last.lat, last.lon, lat, lon)
    if (moved < 80_000 && now - client.gridSentAt < 15 * 60_000) return
    client.gridAt = { lat, lon }
    client.gridSentAt = now
    void this.weather!.grid.around(lat, lon).then(cells => {
      if (cells.length === 0 || client.socket.readyState !== client.socket.OPEN) return
      const message: WeatherGridMessage = { type: 'weatherGrid', serverTime: Date.now(), cells }
      client.socket.send(JSON.stringify(message))
    })
  }

  private pushTo(client: ClientSession, now: number): void {
    const { socket, viewport, sent } = client
    if (viewport == null || socket.readyState !== socket.OPEN) return
    if (socket.bufferedAmount > this.options.maxBufferedBytes) return

    const radius =
      nauticalMilesToMeters(viewport.radiusNm) * this.options.viewportMargin
    const upserts: AircraftTuple[] = []
    const newRoutes: RouteInfo[] = []
    const inView = new Set<string>()
    for (const entry of this.cache.within(viewport.lat, viewport.lon, radius)) {
      const hex = entry.state.hex
      inView.add(hex)
      const callsign = entry.state.callsign
      if (this.routes != null && callsign != null && !client.sentRoutes.has(callsign)) {
        const route = this.routes.get(callsign)
        if (route != null) {
          newRoutes.push(route)
          client.sentRoutes.add(callsign)
        }
      }
      if (sent.get(hex) !== entry.revision) {
        upserts.push(encodeAircraft(entry.state))
        sent.set(hex, entry.revision)
      }
    }
    if (newRoutes.length > 0) {
      const routesMessage: RoutesMessage = { type: 'routes', serverTime: now, routes: newRoutes }
      socket.send(JSON.stringify(routesMessage))
    }
    const removals: string[] = []
    for (const hex of sent.keys()) {
      if (!inView.has(hex)) {
        removals.push(hex)
        sent.delete(hex)
      }
    }
    if (upserts.length === 0 && removals.length === 0 && !client.resetPending) {
      return
    }
    const message: AircraftMessage = {
      type: 'aircraft',
      serverTime: now,
      reset: client.resetPending,
      upserts,
      removals
    }
    client.resetPending = false
    socket.send(JSON.stringify(message))
  }
}
