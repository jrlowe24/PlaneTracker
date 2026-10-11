#!/usr/bin/env node
/**
 * Builds public/runways/runways.json: every lit runway worldwide with both
 * ends located, from OurAirports (public domain), so runway lights show
 * from any distance without waiting for street data (runwayLights.ts).
 *
 * Each entry: [lat1, lon1, lat2, lon2, lighting, elevation1, elevation2]
 * (degrees; lighting 0 basic, 1 instrument, 2 precision, as the shader
 * codes it; elevations in meters above sea level, or null).
 *
 * A failed download leaves an empty list (OSM-derived runways still work).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://davidmegginson.github.io/ourairports-data'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'runways', 'runways.json')

/** Minimal CSV parser (quoted fields, doubled quotes). */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; ++i) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          ++i
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...body] = rows
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

async function download(name) {
  const response = await fetch(`${BASE}/${name}`)
  if (!response.ok) throw new Error(`${name}: ${response.status}`)
  return parseCsv(await response.text())
}

const FT = 0.3048
const num = s => (s === '' ? null : Number(s))

/** Same thresholds as the street worker's runway classes (roadRaster.worker.ts). */
function lighting(lengthM) {
  if (lengthM >= 2400) return 2
  if (lengthM >= 1500) return 1
  return 0
}

async function main() {
  let runways = []
  try {
    const [airportRows, runwayRows] = await Promise.all([download('airports.csv'), download('runways.csv')])
    const airports = new Map(airportRows.map(a => [a.id, a]))
    for (const r of runwayRows) {
      if (r.closed === '1') continue
      const airport = airports.get(r.airport_ref)
      if (airport == null) continue
      const type = airport.type
      if (type === 'heliport' || type === 'closed' || type === 'seaplane_base' || type === 'balloonport') continue
      // Lit: flagged so, or any airline airport (many omit the flag).
      const lit = r.lighted === '1' || type === 'large_airport' || type === 'medium_airport'
      if (!lit) continue
      const ends = [num(r.le_latitude_deg), num(r.le_longitude_deg), num(r.he_latitude_deg), num(r.he_longitude_deg)]
      if (ends.some(v => v == null || !Number.isFinite(v))) continue
      if (/WATER/i.test(r.surface)) continue
      const lengthM = (num(r.length_ft) ?? 0) * FT
      if (lengthM < 700) continue
      const airportElevation = num(airport.elevation_ft)
      const elevation = v => {
        const ft = num(v) ?? airportElevation
        return ft == null ? null : Math.round(ft * FT * 10) / 10
      }
      const round = v => Math.round(v * 1e5) / 1e5
      runways.push([
        round(ends[0]),
        round(ends[1]),
        round(ends[2]),
        round(ends[3]),
        lighting(lengthM),
        elevation(r.le_elevation_ft),
        elevation(r.he_elevation_ft)
      ])
    }
    console.info(`[runways] ${runways.length} lit runways`)
  } catch (error) {
    console.warn('[runways] OurAirports unavailable; writing an empty list:', error.message)
    runways = []
  }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(runways))
}

await main()
