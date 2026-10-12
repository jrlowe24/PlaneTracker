import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AircraftState } from '@windowseat/shared'
import { WebSocketServer } from 'ws'

import { AircraftCache } from './cache'
import { readFixture } from './fixtures'
import {
  isOriginAllowed,
  parseAllowedOrigins,
  WS_MAX_PAYLOAD_BYTES
} from './httpSecurity'
import { Hub } from './hub'
import { RouteResolver } from './routes'
import { SearchService } from './search'
import { AdsbLolSource } from './sources/adsbLol'
import { FollowFeed } from './sources/followFeed'
import { OpenSkySnapshot } from './sources/openskySnapshot'
import { ReadsbSnapshot } from './sources/readsbSnapshot'
import { WeatherService } from './weather'
import { ReplaySource } from './sources/replay'
import { SyntheticSource } from './sources/synthetic'
import type { FlightSource } from './sources/types'

/**
 * Flight data server. Exactly one upstream source per process:
 *
 * - default: live adsb.lol polling for the clients' merged viewports
 * - REPLAY=1: loops a recorded fixture (REPLAY_FILE, default fixtures/sea.ndjson.gz)
 * - SYNTH=<count>: synthetic worldwide traffic for stress tests
 *
 * Routes (origin/destination by callsign) are looked up unless ROUTES=0 or
 * the traffic is synthetic. With live data, followed aircraft get ~1 Hz
 * updates from adsb.fi (FOLLOW_FEED=0 disables).
 */

const PORT = Number(process.env.PORT ?? 8787)
const here = dirname(fileURLToPath(import.meta.url))

async function createSource(): Promise<FlightSource> {
  const synth = Number(process.env.SYNTH ?? 0)
  if (synth > 0) {
    return new SyntheticSource(synth)
  }
  if (process.env.REPLAY === '1' || process.env.REPLAY === 'true') {
    const file = resolve(
      here,
      '..',
      process.env.REPLAY_FILE ?? 'fixtures/sea.ndjson.gz'
    )
    const fixture = await readFixture(file)
    console.info(
      `[server] replaying ${file}: ${fixture.frames.length} frames, ${Math.round(
        (fixture.frames.at(-1)?.t ?? 0) / 1000
      )} s`
    )
    return new ReplaySource(fixture)
  }
  return new AdsbLolSource()
}

const source = await createSource()
const cache = new AircraftCache()
const routesEnabled = process.env.ROUTES !== '0' && !source.name.startsWith('synthetic')
const routes = routesEnabled ? new RouteResolver(resolve(here, '../.cache/routes.json')) : null
const followEnabled = source instanceof AdsbLolSource && process.env.FOLLOW_FEED !== '0'
const followFeed = followEnabled
  ? new FollowFeed((states, receivedAt) => cache.upsert(states, receivedAt))
  : null
// Current weather (Open-Meteo) for the clouds; WEATHER=0 disables.
const weather = process.env.WEATHER === '0' ? null : new WeatherService()
// Worldwide overview, live data only; OVERVIEW=0 disables. A readsb
// snapshot feed (GLOBAL_FEED_URL, e.g. airplanes.live) when configured,
// else OpenSky (which refuses connections from cloud hosts).
const upsertOverview = (states: AircraftState[], receivedAt: number): void => {
  cache.upsert(states, receivedAt)
}
const overview =
  source instanceof AdsbLolSource && process.env.OVERVIEW !== '0'
    ? process.env.GLOBAL_FEED_URL != null && process.env.GLOBAL_FEED_URL !== ''
      ? new ReadsbSnapshot(process.env.GLOBAL_FEED_URL, upsertOverview)
      : new OpenSkySnapshot(upsertOverview)
    : null
const hub = new Hub(cache, source, {}, routes, followFeed, weather, overview)
// Worldwide search (live lookups only with live data).
const search = new SearchService(cache, followFeed, source instanceof AdsbLolSource ? source : null)

/**
 * Origins allowed to call the HTTP API from a browser (the site is hosted
 * separately in production): comma-separated, or * (default).
 */
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS ?? '*')

const http = createServer((req, res) => {
  const origin = req.headers.origin
  if (!isOriginAllowed(origin, ALLOWED_ORIGINS)) {
    res.writeHead(403)
    res.end()
    return
  }
  if (origin != null) {
    res.setHeader('access-control-allow-origin', ALLOWED_ORIGINS.has('*') ? '*' : origin)
    res.setHeader('vary', 'origin')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' })
    res.end()
    return
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        source: source.name,
        aircraft: cache.size,
        clients: hub.clientCount
      })
    )
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/api/search') {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const query = (url.searchParams.get('q') ?? '').slice(0, 32)
    void search
      .search(query)
      .then(response => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(response))
      })
      .catch(error => {
        console.warn('[search]', error instanceof Error ? error.message : error)
        if (res.writableEnded) return
        res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'Search temporarily unavailable' }))
      })
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  perMessageDeflate: true,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: ({ origin }, done) => {
    if (isOriginAllowed(origin, ALLOWED_ORIGINS)) done(true)
    else done(false, 403, 'Origin not allowed')
  }
})
wss.on('connection', socket => {
  // Protocol errors such as an oversized or invalid compressed frame are
  // emitted on the individual socket. Without a listener Node treats them as
  // uncaught errors and terminates the whole server.
  socket.on('error', error => {
    const code = 'code' in error ? String(error.code) : error.name
    console.warn(`[ws] closing client after ${code}`)
  })
  hub.addClient(socket)
})

hub.start()
http.listen(PORT, () => {
  console.log(
    `[server] listening on http://localhost:${PORT} (ws: /ws), source: ${source.name}`
  )
})

function shutdown(): void {
  hub.stop()
  wss.close()
  http.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
