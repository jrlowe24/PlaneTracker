import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocketServer } from 'ws'

import { AircraftCache } from './cache'
import { readFixture } from './fixtures'
import { Hub } from './hub'
import { AdsbLolSource } from './sources/adsbLol'
import { ReplaySource } from './sources/replay'
import { SyntheticSource } from './sources/synthetic'
import type { FlightSource } from './sources/types'

/**
 * Flight data server. Exactly one upstream source per process:
 *
 * - default: live adsb.lol polling for the clients' merged viewports
 * - REPLAY=1: loops a recorded fixture (REPLAY_FILE, default fixtures/sea.ndjson.gz)
 * - SYNTH=<count>: synthetic worldwide traffic for stress tests
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
const hub = new Hub(cache, source)

const http = createServer((req, res) => {
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
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: '/ws', perMessageDeflate: true })
wss.on('connection', socket => {
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
