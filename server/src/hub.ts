import {
  encodeAircraft,
  nauticalMilesToMeters,
  type AircraftMessage,
  type AircraftTuple,
  type ClientMessage,
  type HelloMessage,
  type Viewport
} from '@windowseat/shared'
import type { WebSocket } from 'ws'

import type { AircraftCache } from './cache'
import { mergeViewports } from './regions'
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
    options: Partial<HubOptions> = {}
  ) {
    this.options = { ...defaultHubOptions, ...options }
  }

  start(): void {
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
      resetPending: false
    }
    this.clients.add(client)
    const hello: HelloMessage = {
      type: 'hello',
      serverTime: Date.now(),
      source: this.source.name,
      attribution: this.source.attribution,
      attributionUrl: this.source.attributionUrl
    }
    socket.send(JSON.stringify(hello))

    socket.on('message', data => {
      const message = parseClientMessage(data)
      if (message?.type === 'viewport') {
        client.viewport = message.viewport
        this.updateRegions()
        // Respond quickly with what the cache already has.
        this.pushTo(client, Date.now())
      }
    })
    socket.on('close', () => {
      this.clients.delete(client)
      this.updateRegions()
    })
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
    }
  }

  private pushTo(client: ClientSession, now: number): void {
    const { socket, viewport, sent } = client
    if (viewport == null || socket.readyState !== socket.OPEN) return
    if (socket.bufferedAmount > this.options.maxBufferedBytes) return

    const radius =
      nauticalMilesToMeters(viewport.radiusNm) * this.options.viewportMargin
    const upserts: AircraftTuple[] = []
    const inView = new Set<string>()
    for (const entry of this.cache.within(viewport.lat, viewport.lon, radius)) {
      const hex = entry.state.hex
      inView.add(hex)
      if (sent.get(hex) !== entry.revision) {
        upserts.push(encodeAircraft(entry.state))
        sent.set(hex, entry.revision)
      }
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
