import type {
  Attribution,
  ClientMessage,
  RouteInfo,
  ServerMessage,
  Viewport
} from '@windowseat/shared'

import { createStore } from '../state/createStore'
import { AircraftRegistry } from './aircraftRegistry'
import { weatherStore } from './weather'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export interface FlightStatus {
  status: ConnectionStatus
  source: string | null
  attribution: string | null
  attributionUrl: string | null
  /** Extra source for followed aircraft (shown while following). */
  followAttribution: Attribution | null
  aircraftCount: number
}

export const flightStatusStore = createStore<FlightStatus>({
  status: 'connecting',
  source: null,
  attribution: null,
  attributionUrl: null,
  followAttribution: null,
  aircraftCount: 0
})

/**
 * Estimated offset between the server's clock and ours (server − client).
 * Position timestamps come from upstream/server clocks.
 */
let clockOffsetMs = 0

/** Current time on the server's clock (epoch ms). */
export function serverNow(): number {
  return Date.now() + clockOffsetMs
}

function updateClockOffset(serverTime: number): void {
  const sample = serverTime - Date.now()
  // Messages only arrive late, never early: the largest sample is the best
  // estimate. Decay slowly so a clock change can still be followed.
  clockOffsetMs = Math.max(sample, clockOffsetMs - 50)
}

class FlightConnection {
  readonly registry = new AircraftRegistry()
  /** Scheduled routes by callsign (from the server's route lookups). */
  readonly routes = new Map<string, RouteInfo>()
  private socket: WebSocket | null = null
  private viewport: Viewport | null = null
  private followHex: string | null = null
  private retryMs = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer != null) clearTimeout(this.retryTimer)
    this.socket?.close()
    this.socket = null
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport
    this.send({ type: 'viewport', viewport })
  }

  /** Tells the server which aircraft the camera follows (fast updates). */
  setFollow(hex: string | null): void {
    if (hex === this.followHex) return
    this.followHex = hex
    this.send({ type: 'follow', hex })
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  private connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
    this.socket = socket
    flightStatusStore.set({ status: 'connecting' })

    socket.addEventListener('open', () => {
      this.retryMs = 1000
      flightStatusStore.set({ status: 'open' })
      if (this.viewport != null) {
        this.send({ type: 'viewport', viewport: this.viewport })
      }
      if (this.followHex != null) {
        this.send({ type: 'follow', hex: this.followHex })
      }
    })
    socket.addEventListener('message', event => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      updateClockOffset(message.serverTime)
      if (message.type === 'hello') {
        // A new server session (reconnect/restart): keep aircraft on screen
        // and drop those it doesn't confirm within a grace period.
        this.registry.markAllUnconfirmed(Date.now())
        flightStatusStore.set({
          source: message.source,
          attribution: message.attribution,
          attributionUrl: message.attributionUrl,
          followAttribution: message.followAttribution
        })
      } else if (message.type === 'weather') {
        weatherStore.set({ sample: message.weather, attribution: message.attribution })
      } else if (message.type === 'routes') {
        for (const route of message.routes) this.routes.set(route.callsign, route)
      } else {
        this.registry.apply(message, Date.now())
        if (flightStatusStore.get().aircraftCount !== this.registry.list.length) {
          flightStatusStore.set({ aircraftCount: this.registry.list.length })
        }
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      flightStatusStore.set({ status: 'closed' })
      if (this.stopped) return
      this.retryTimer = setTimeout(() => {
        this.connect()
      }, this.retryMs)
      this.retryMs = Math.min(30_000, this.retryMs * 2)
    })
  }
}

/** One connection per page, surviving HMR like the tiles singleton. */
const GLOBAL_KEY = Symbol.for('window-seat.flight-connection')
const g = globalThis as { [GLOBAL_KEY]?: FlightConnection }
export const flightConnection: FlightConnection = (g[GLOBAL_KEY] ??=
  new FlightConnection())

if (import.meta.env.DEV) {
  ;(window as { __windowSeatFlights?: FlightConnection }).__windowSeatFlights =
    flightConnection
}
