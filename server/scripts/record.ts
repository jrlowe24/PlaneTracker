/**
 * Records live adsb.lol data for one region into a replay fixture.
 *
 *   pnpm record --preset sea
 *   pnpm record --name test --lat 51.47 --lon -0.45 --radius 80 --minutes 10
 *
 * Polls every 5 s (adsb.lol's cache interval), i.e. ~120 requests for 10 min.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { encodeAircraft } from '@windowseat/shared'

import { FixtureWriter } from '../src/fixtures'
import { fetchAdsbLolPoint } from '../src/sources/adsbLol'

const PRESETS = {
  // Seattle–Tacoma: SEA, BFI, PAE, RNT and the approach corridors.
  sea: { lat: 47.45, lon: -122.31, radius: 60 },
  // London: LHR, LGW, LCY, STN, LTN and the holding stacks.
  london: { lat: 51.47, lon: -0.3, radius: 60 }
} as const

const { values } = parseArgs({
  // pnpm forwards a literal "--" separator.
  args: process.argv.slice(2).filter(arg => arg !== '--'),
  options: {
    preset: { type: 'string' },
    name: { type: 'string' },
    lat: { type: 'string' },
    lon: { type: 'string' },
    radius: { type: 'string' },
    minutes: { type: 'string', default: '10' },
    interval: { type: 'string', default: '5' }
  }
})

const preset =
  values.preset != null ? PRESETS[values.preset as keyof typeof PRESETS] : undefined
if (values.preset != null && preset == null) {
  throw new Error(`Unknown preset ${values.preset}; use ${Object.keys(PRESETS).join(', ')}`)
}
const name = values.name ?? values.preset ?? 'recording'
const lat = Number(values.lat ?? preset?.lat)
const lon = Number(values.lon ?? preset?.lon)
const radiusNm = Number(values.radius ?? preset?.radius)
const minutes = Number(values.minutes)
const intervalMs = Number(values.interval) * 1000
if (![lat, lon, radiusNm, minutes, intervalMs].every(Number.isFinite)) {
  throw new Error('Pass --preset or --lat, --lon and --radius')
}

const here = dirname(fileURLToPath(import.meta.url))
const path = resolve(here, '../fixtures', `${name}.ndjson.gz`)
mkdirSync(dirname(path), { recursive: true })

const recordedAt = Date.now()
const writer = new FixtureWriter(path, {
  type: 'header',
  version: 1,
  name,
  source: 'adsb.lol',
  attribution: 'Flight data © adsb.lol contributors (ODbL)',
  center: { lat, lon },
  radiusNm,
  recordedAt,
  intervalMs
})

console.info(
  `Recording ${name} (${lat}, ${lon}, ${radiusNm} nm) for ${minutes} min every ${intervalMs / 1000} s → ${path}`
)

const endAt = recordedAt + minutes * 60_000
let frames = 0
let failures = 0
let consecutiveFailures = 0
while (Date.now() < endAt) {
  const started = Date.now()
  try {
    const states = await fetchAdsbLolPoint(
      { lat, lon, radiusNm },
      AbortSignal.timeout(10_000)
    )
    writer.write({ type: 'frame', t: Date.now() - recordedAt, ac: states.map(encodeAircraft) })
    ++frames
    consecutiveFailures = 0
    if (frames % 12 === 0) {
      console.info(`  ${Math.round((Date.now() - recordedAt) / 1000)} s: ${states.length} aircraft`)
    }
  } catch (error) {
    ++failures
    ++consecutiveFailures
    console.warn(`  request failed (${failures}):`, error instanceof Error ? error.message : error)
    if (consecutiveFailures > 8) break
    // Back off a little more after failures.
    await new Promise(r => setTimeout(r, intervalMs * Math.min(8, 2 ** consecutiveFailures)))
  }
  const wait = intervalMs - (Date.now() - started)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}
await writer.close()
console.info(`Done: ${frames} frames, ${failures} failures.`)
