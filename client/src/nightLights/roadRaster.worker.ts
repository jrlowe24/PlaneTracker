/// <reference lib="webworker" />
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile'
import Pbf from 'pbf'

/**
 * Turns one OpenStreetMap vector tile (OpenMapTiles schema, from
 * OpenFreeMap) into a night light image: linear RGB emission, drawn
 * additively. Streets get a pool of light along them and lamps at real
 * spacing, colored by road type and district (sodium orange, warm or
 * neutral LED); commercial and industrial areas and airport aprons a
 * diffuse glow; runways and taxiways their lighting: white edge and
 * centerline lights, green thresholds, red ends, approach light rows, and
 * green/blue taxiway lights.
 */

export interface RoadRasterRequest {
  id: number
  url: string
  /** Tile coordinates (for world-fixed variation). */
  z: number
  x: number
  y: number
  size: number
  /** Ground meters per pixel at the tile's latitude. */
  metersPerPixel: number
}

export interface RoadRasterResponse {
  id: number
  pixels: Uint8ClampedArray | null
  error?: string
}

type Rgb = readonly [number, number, number]

// Linear light colors (relative), roughly by lamp type.
const SODIUM: Rgb = [1.0, 0.42, 0.1]
const WARM_LED: Rgb = [1.0, 0.68, 0.36]
const NEUTRAL_LED: Rgb = [0.95, 0.85, 0.7]
const WHITE: Rgb = [0.92, 0.94, 1.0]
const GREEN: Rgb = [0.15, 1.0, 0.35]
const BLUE: Rgb = [0.2, 0.35, 1.0]
const RED: Rgb = [1.0, 0.08, 0.05]

interface RoadStyle {
  /** Lamp spacing along the road, meters. */
  spacing: number
  /** Lamps on both sides (staggered) or one side. */
  bothSides: boolean
  /** Width of the lit band, meters. */
  width: number
  /** Light pool brightness (0 … 1). */
  pool: number
  /** Lamp brightness (0 … 1). */
  lamp: number
  /** Color choice: [district share using the first palette entry, palette]. */
  colors: readonly [number, readonly Rgb[]]
}

const ROADS: Record<string, RoadStyle> = {
  motorway: { spacing: 60, bothSides: true, width: 34, pool: 0.32, lamp: 0.9, colors: [0.55, [SODIUM, NEUTRAL_LED]] },
  trunk: { spacing: 50, bothSides: true, width: 28, pool: 0.32, lamp: 0.9, colors: [0.5, [SODIUM, NEUTRAL_LED]] },
  primary: { spacing: 38, bothSides: true, width: 24, pool: 0.36, lamp: 1.0, colors: [0.3, [SODIUM, NEUTRAL_LED]] },
  secondary: { spacing: 38, bothSides: true, width: 20, pool: 0.32, lamp: 0.9, colors: [0.35, [SODIUM, NEUTRAL_LED]] },
  tertiary: { spacing: 36, bothSides: false, width: 16, pool: 0.26, lamp: 0.75, colors: [0.45, [SODIUM, WARM_LED]] },
  busway: { spacing: 38, bothSides: false, width: 16, pool: 0.26, lamp: 0.75, colors: [0.3, [SODIUM, NEUTRAL_LED]] },
  minor: { spacing: 34, bothSides: false, width: 12, pool: 0.2, lamp: 0.6, colors: [0.5, [SODIUM, WARM_LED]] },
  service: { spacing: 45, bothSides: false, width: 7, pool: 0.08, lamp: 0.3, colors: [0.5, [SODIUM, WARM_LED]] }
}

/** Diffuse glow of whole areas (parking lots, yards, signage, porch lights). */
/**
 * Lit areas: a faint glow plus scattered lamps (parking lots, yards) on a
 * jittered grid of `spacing` meters, a `share` of them lit.
 */
const AREAS: Record<string, { glow: number; color: Rgb; spacing: number; share: number; lamp: number }> = {
  commercial: { glow: 0.012, color: WARM_LED, spacing: 40, share: 0.5, lamp: 0.6 },
  retail: { glow: 0.015, color: NEUTRAL_LED, spacing: 35, share: 0.6, lamp: 0.7 },
  industrial: { glow: 0.008, color: SODIUM, spacing: 45, share: 0.45, lamp: 0.65 },
  railway: { glow: 0.006, color: SODIUM, spacing: 60, share: 0.35, lamp: 0.6 },
  residential: { glow: 0.003, color: WARM_LED, spacing: 0, share: 0, lamp: 0 },
  stadium: { glow: 0.03, color: WHITE, spacing: 30, share: 0.8, lamp: 0.9 }
}

/** Deterministic 0…1 hash of integer coordinates. */
function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function rgba(color: Rgb, intensity: number): string {
  const c = (v: number): number => Math.round(Math.min(1, v * intensity) * 255)
  return `rgb(${c(color[0])},${c(color[1])},${c(color[2])})`
}

type Point = { x: number; y: number }
type Ctx = OffscreenCanvasRenderingContext2D

/** Points every `spacing` px along a polyline, with the unit direction there. */
function along(line: Point[], spacing: number, phase: number, visit: (x: number, y: number, dx: number, dy: number) => void): void {
  let carry = phase
  for (let i = 1; i < line.length; ++i) {
    const a = line[i - 1]!
    const b = line[i]!
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    const dx = (b.x - a.x) / length
    const dy = (b.y - a.y) / length
    let d = carry
    for (; d < length; d += spacing) visit(a.x + dx * d, a.y + dy * d, dx, dy)
    carry = d - length
  }
}

/** A lamp: bright core with a soft falloff (radius in px). */
function lamp(ctx: Ctx, x: number, y: number, radius: number, color: Rgb, intensity: number): void {
  const r = Math.max(0.8, radius)
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r)
  gradient.addColorStop(0, rgba(color, intensity))
  gradient.addColorStop(0.35, rgba(color, intensity * 0.35))
  gradient.addColorStop(1, 'rgb(0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
}

function strokeLine(ctx: Ctx, line: Point[], width: number, style: string): void {
  ctx.lineWidth = width
  ctx.strokeStyle = style
  ctx.beginPath()
  line.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()
}

function fillRings(ctx: Ctx, rings: Point[][], style: string): void {
  ctx.fillStyle = style
  ctx.beginPath()
  for (const ring of rings) ring.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.fill('evenodd')
}

function render(request: RoadRasterRequest, data: ArrayBuffer): Uint8ClampedArray {
  const { size, metersPerPixel: mpp } = request
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const tile = new VectorTile(new Pbf(new Uint8Array(data)))
  const geometry = (feature: VectorTileFeature): Point[][] => {
    const k = size / feature.extent
    return feature.loadGeometry().map(ring => ring.map(p => ({ x: p.x * k, y: p.y * k })))
  }
  // District (~600 m) a pixel position falls in, world-fixed.
  const cells = 2 ** request.z / 2 ** 14 // tiles per z14 tile
  const district = (x: number, y: number, salt: number): number => {
    const z14x = (request.x + x / size) / cells
    const z14y = (request.y + y / size) / cells
    return hash(Math.floor(z14x * 4), Math.floor(z14y * 4), salt)
  }

  // Area glow and lamps first (underneath).
  const landuse = tile.layers.landuse
  for (let i = 0; i < (landuse?.length ?? 0); ++i) {
    const feature = landuse!.feature(i)
    const area = AREAS[String(feature.properties.class)]
    if (area == null || feature.type !== 3) continue
    const rings = geometry(feature)
    fillRings(ctx, rings, rgba(area.color, area.glow))
    if (area.spacing > 0) scatterLamps(ctx, rings, area.spacing / mpp, area.share, area.color, area.lamp, 4 / mpp, request)
  }

  // Streets: light pools, then lamps.
  const roads = tile.layers.transportation
  for (let i = 0; i < (roads?.length ?? 0); ++i) {
    const feature = roads!.feature(i)
    const props = feature.properties
    if (feature.type !== 2 || props.brunnel === 'tunnel') continue
    const style = ROADS[String(props.class)]
    if (style == null) continue
    for (const line of geometry(feature)) {
      if (line.length < 2) continue
      const mid = line[Math.floor(line.length / 2)]!
      const [share, palette] = style.colors
      const color = district(mid.x, mid.y, 1) < share ? palette[0]! : palette[1]!
      // Some districts are brighter than others.
      const level = 0.6 + 0.8 * district(mid.x, mid.y, 2)
      const width = Math.max(1, style.width / mpp)
      // Soft-edged pool, faint: the lamps carry the light.
      strokeLine(ctx, line, width * 1.5, rgba(color, style.pool * 0.12 * level))
      strokeLine(ctx, line, width * 0.7, rgba(color, style.pool * 0.22 * level))
      const spacing = style.spacing / mpp
      const side = (style.width * 0.4) / mpp
      const radius = 5 / mpp
      let n = 0
      along(line, spacing, spacing * hash(i, 7), (x, y, dx, dy) => {
        const s = style.bothSides ? (n++ % 2 === 0 ? 1 : -1) : 1
        lamp(ctx, x - dy * side * s, y + dx * side * s, radius, color, style.lamp * level)
      })
    }
  }

  // Airports.
  const aeroway = tile.layers.aeroway
  for (let i = 0; i < (aeroway?.length ?? 0); ++i) {
    const feature = aeroway!.feature(i)
    const cls = String(feature.properties.class)
    if (cls === 'apron' && feature.type === 3) {
      // High-mast floodlights.
      const rings = geometry(feature)
      fillRings(ctx, rings, rgba(NEUTRAL_LED, 0.05))
      scatterLamps(ctx, rings, 70 / mpp, 0.9, NEUTRAL_LED, 1.0, 12 / mpp, request)
      continue
    }
    if (feature.type !== 2) continue
    for (const line of geometry(feature)) {
      if (line.length < 2) continue
      if (cls === 'runway') drawRunway(ctx, line, mpp, size)
      else if (cls === 'taxiway') drawTaxiway(ctx, line, mpp)
    }
  }

  return ctx.getImageData(0, 0, size, size).data
}

/** Lamps on a jittered grid inside polygons (clipped to them). */
function scatterLamps(
  ctx: Ctx,
  rings: Point[][],
  spacing: number,
  share: number,
  color: Rgb,
  intensity: number,
  radius: number,
  tile: RoadRasterRequest
): void {
  if (spacing < 2) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  ctx.save()
  ctx.beginPath()
  for (const ring of rings) ring.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.clip('evenodd')
  // Grid anchored to the tile so neighbouring tiles line up.
  for (let gy = Math.floor(minY / spacing); gy * spacing <= maxY; ++gy) {
    for (let gx = Math.floor(minX / spacing); gx * spacing <= maxX; ++gx) {
      const h = hash(gx + tile.x * 7919, gy + tile.y * 104729, tile.z)
      if (h > share) continue
      const jx = hash(gx, gy, 11) - 0.5
      const jy = hash(gx, gy, 13) - 0.5
      lamp(ctx, (gx + 0.5 + 0.6 * jx) * spacing, (gy + 0.5 + 0.6 * jy) * spacing, radius, color, intensity * (0.5 + h / share))
    }
  }
  ctx.restore()
}

function drawTaxiway(ctx: Ctx, line: Point[], mpp: number): void {
  const r = 2.5 / mpp
  along(line, 30 / mpp, 15 / mpp, (x, y) => {
    lamp(ctx, x, y, r, GREEN, 0.4)
  })
  const edge = 12 / mpp
  along(line, 60 / mpp, 30 / mpp, (x, y, dx, dy) => {
    lamp(ctx, x - dy * edge, y + dx * edge, r, BLUE, 0.3)
    lamp(ctx, x + dy * edge, y - dx * edge, r, BLUE, 0.3)
  })
}

/**
 * Runway lighting. Ends that fall inside the tile (not where the tile cut
 * the runway) are real thresholds: they get green threshold and red end
 * bars and a 900 m approach lighting system with a crossbar at 300 m.
 */
function drawRunway(ctx: Ctx, line: Point[], mpp: number, size: number): void {
  const half = 23 / mpp
  const r = 3 / mpp
  // Edge lights (white, every 60 m).
  along(line, 60 / mpp, 30 / mpp, (x, y, dx, dy) => {
    lamp(ctx, x - dy * half, y + dx * half, r, WHITE, 0.9)
    lamp(ctx, x + dy * half, y - dx * half, r, WHITE, 0.9)
  })
  // Centerline (every 15 m, dimmer).
  along(line, 15 / mpp, 7.5 / mpp, (x, y) => {
    lamp(ctx, x, y, r * 0.7, WHITE, 0.4)
  })
  const margin = size * 0.01
  const inside = (p: Point): boolean => p.x > margin && p.y > margin && p.x < size - margin && p.y < size - margin
  const ends: Array<[Point, Point]> = [
    [line[0]!, line[1]!],
    [line[line.length - 1]!, line[line.length - 2]!]
  ]
  for (const [end, next] of ends) {
    if (!inside(end)) continue
    const length = Math.hypot(next.x - end.x, next.y - end.y)
    if (length === 0) continue
    // Unit vector pointing outward from the runway at this end.
    const ox = (end.x - next.x) / length
    const oy = (end.y - next.y) / length
    // Threshold bar (green, just outside) and end bar (red, just inside).
    for (let k = -8; k <= 8; ++k) {
      const across = (k * 3) / mpp
      lamp(ctx, end.x + ox * (3 / mpp) - oy * across, end.y + oy * (3 / mpp) + ox * across, r * 0.8, GREEN, 0.9)
      lamp(ctx, end.x - ox * (3 / mpp) - oy * across, end.y - oy * (3 / mpp) + ox * across, r * 0.8, RED, 0.7)
    }
    // Approach lights: barrettes every 30 m out to 900 m, crossbar at 300 m.
    for (let d = 30; d <= 900; d += 30) {
      const bar = d === 300 ? 15 : 2
      for (let k = -bar; k <= bar; ++k) {
        const across = (k * 1.5) / mpp
        lamp(ctx, end.x + ox * (d / mpp) - oy * across, end.y + oy * (d / mpp) + ox * across, r * 0.8, WHITE, 0.8)
      }
    }
  }
}

self.onmessage = async (event: MessageEvent<RoadRasterRequest>) => {
  const request = event.data
  try {
    const response = await fetch(request.url)
    if (!response.ok) throw new Error(`tile ${response.status}`)
    const pixels = render(request, await response.arrayBuffer())
    const message: RoadRasterResponse = { id: request.id, pixels }
    ;(self as unknown as Worker).postMessage(message, [pixels.buffer])
  } catch (error) {
    const message: RoadRasterResponse = {
      id: request.id,
      pixels: null,
      error: error instanceof Error ? error.message : String(error)
    }
    ;(self as unknown as Worker).postMessage(message)
  }
}
