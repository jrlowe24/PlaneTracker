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
  /** Tile URL template ({z}/{x}/{y}), for the runway index (see runwayIndex). */
  template: string
}

export interface RoadRasterResponse {
  id: number
  /** RGB: light pools and areas; A: lamp energy (for distant lamps, via mips). */
  pixels: Uint8ClampedArray | null
  /**
   * Lamps, one per pixel cell: R, G = position within the cell (/256),
   * B = color index (LAMP_COLORS, 0 = none), A = intensity.
   */
  lamps: Uint8Array | null
  /** Whole runways near the tile, for exact runway lighting (runwayLights.ts). */
  runways?: RunwayRecord[]
  error?: string
}

/** A whole runway: its two ends (degrees) and how it's lit. */
export interface RunwayRecord {
  a: [lon: number, lat: number]
  b: [lon: number, lat: number]
  lighting: RunwayLighting
}

type Rgb = readonly [number, number, number]

// Linear light colors (relative), roughly by lamp type.
const SODIUM: Rgb = [1.0, 0.56, 0.22]
const WARM_LED: Rgb = [1.0, 0.68, 0.36]
const NEUTRAL_LED: Rgb = [0.95, 0.85, 0.7]
const WHITE: Rgb = [0.92, 0.94, 1.0]
const GREEN: Rgb = [0.15, 1.0, 0.35]
const BLUE: Rgb = [0.2, 0.35, 1.0]
const RED: Rgb = [1.0, 0.08, 0.05]
/** Airfield white (its own palette entry: airfield lights are boosted). */
const RUNWAY: Rgb = [1.0, 0.96, 0.86]

/** Lamp color palette (index 0 = no lamp); the shader has the same table. */
export const LAMP_COLORS: readonly Rgb[] = [[0, 0, 0], SODIUM, WARM_LED, NEUTRAL_LED, WHITE, GREEN, BLUE, RED, RUNWAY]

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
  motorway: { spacing: 70, bothSides: false, width: 34, pool: 0.32, lamp: 1.0, colors: [0.55, [SODIUM, NEUTRAL_LED]] },
  trunk: { spacing: 60, bothSides: false, width: 28, pool: 0.32, lamp: 1.0, colors: [0.5, [SODIUM, NEUTRAL_LED]] },
  primary: { spacing: 50, bothSides: true, width: 24, pool: 0.36, lamp: 1.0, colors: [0.3, [SODIUM, NEUTRAL_LED]] },
  secondary: { spacing: 50, bothSides: true, width: 20, pool: 0.32, lamp: 1.0, colors: [0.35, [SODIUM, NEUTRAL_LED]] },
  tertiary: { spacing: 55, bothSides: false, width: 16, pool: 0.26, lamp: 0.9, colors: [0.45, [SODIUM, WARM_LED]] },
  busway: { spacing: 50, bothSides: false, width: 16, pool: 0.26, lamp: 0.9, colors: [0.3, [SODIUM, NEUTRAL_LED]] },
  minor: { spacing: 65, bothSides: false, width: 12, pool: 0.2, lamp: 0.85, colors: [0.5, [SODIUM, WARM_LED]] },
  service: { spacing: 70, bothSides: false, width: 7, pool: 0.08, lamp: 0.5, colors: [0.5, [SODIUM, WARM_LED]] }
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

/** Lamps of the tile being rendered (see RoadRasterResponse.lamps). */
let lampCells = new Uint8Array(0)
let lampEnergy = new Float32Array(0)
let lampSize = 0
/**
 * Coarse zooms (tens of meters per pixel): lamps only. Pools and area
 * glows a pixel or more wide read as glowing bands from afar.
 */
let poolsEnabled = true

/**
 * A lamp: its exact position goes into the lamp cells (the shader draws it
 * as a sharp point of the right size at any distance), its energy into the
 * far-distance channel, and the pool of light it casts on the ground into
 * the image (`radius` in px).
 */
function lamp(ctx: Ctx, x: number, y: number, radius: number, color: Rgb, base: number, pool = true): void {
  // Real lamps differ: aging, wattage, a few out. (Airfield lights don't.)
  let intensity = base
  if (pool) {
    const h = hash(Math.round(x * 16), Math.round(y * 16), 3)
    if (h < 0.08) return
    intensity *= 0.45 + 0.75 * h
  }
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  if (cx >= 0 && cy >= 0 && cx < lampSize && cy < lampSize) {
    const i = cy * lampSize + cx
    const value = Math.round(Math.min(1, intensity) * 255)
    if (value > lampCells[i * 4 + 3]!) {
      lampCells[i * 4] = Math.min(255, Math.floor((x - cx) * 256))
      lampCells[i * 4 + 1] = Math.min(255, Math.floor((y - cy) * 256))
      lampCells[i * 4 + 2] = Math.max(1, LAMP_COLORS.indexOf(color))
      lampCells[i * 4 + 3] = value
    }
    lampEnergy[i] = lampEnergy[i]! + intensity
  }
  // Airfield lights are inset fixtures: no pool on the ground.
  if (!pool || !poolsEnabled) return
  const r = Math.max(1.5, radius * 2)
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r)
  // Smooth falloff (no visible rim): bright under the lamp, fading out.
  gradient.addColorStop(0, rgba(color, intensity * 0.3))
  gradient.addColorStop(0.2, rgba(color, intensity * 0.2))
  gradient.addColorStop(0.45, rgba(color, intensity * 0.08))
  gradient.addColorStop(0.7, rgba(color, intensity * 0.025))
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

async function render(
  request: RoadRasterRequest,
  data: ArrayBuffer
): Promise<{ pixels: Uint8ClampedArray; lamps: Uint8Array; runways: RunwayRecord[] }> {
  const { size, metersPerPixel: mpp } = request
  lampSize = size
  poolsEnabled = mpp < 8
  lampCells = new Uint8Array(size * size * 4)
  lampEnergy = new Float32Array(size * size)
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
    if (poolsEnabled) fillRings(ctx, rings, rgba(area.color, area.glow))
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
      // Barely any continuous light along the road: the light comes from
      // each lamp's pool, islands of light with darkness between them.
      if (poolsEnabled) strokeLine(ctx, line, width, rgba(color, style.pool * 0.04 * level))
      const spacing = style.spacing / mpp
      const side = (style.width * 0.4) / mpp
      // Pool radius (lamp() draws it twice this): ~18 m on the ground.
      const radius = 9 / mpp
      let n = 0
      along(line, spacing, spacing * hash(i, 7), (x, y, dx, dy) => {
        const s = style.bothSides ? (n++ % 2 === 0 ? 1 : -1) : 1
        // Real poles aren't evenly spaced: shift each along the road.
        const j = (hash(Math.round(x * 8), Math.round(y * 8), 5) - 0.5) * 0.4 * spacing
        lamp(ctx, x + dx * j - dy * side * s, y + dy * j + dx * side * s, radius, color, style.lamp * level)
      })
    }
  }

  // Airports.
  const aeroway = tile.layers.aeroway
  let lit = false
  for (let i = 0; i < (aeroway?.length ?? 0); ++i) {
    const feature = aeroway!.feature(i)
    const cls = String(feature.properties.class)
    if (feature.type === 2 && (cls === 'runway' || cls === 'taxiway')) lit = true
  }
  // Runways themselves are lit exactly by the shader from whole-runway
  // records (a tile shows only part of a runway, and lamps rasterized into
  // ~3 m cells collided and drifted). The records, and how taxiways are
  // lit, come from a coarser tile's runway index.
  const index = lit ? await runwayIndex(request).catch(() => null) : null
  const toIndex = (p: Point): Point => {
    const k = 2 ** (request.z - INDEX_ZOOM)
    return { x: (request.x + p.x / size) / k, y: (request.y + p.y / size) / k }
  }
  const lightingAt = (p: Point, near: number): RunwayLighting =>
    index == null ? 'instrument' : (index.lightingNear(toIndex(p), near) ?? 'basic')
  for (let i = 0; i < (aeroway?.length ?? 0); ++i) {
    const feature = aeroway!.feature(i)
    const cls = String(feature.properties.class)
    if (cls === 'apron' && feature.type === 3) {
      // High-mast floodlights.
      const rings = geometry(feature)
      if (poolsEnabled) fillRings(ctx, rings, rgba(NEUTRAL_LED, 0.05))
      scatterLamps(ctx, rings, 70 / mpp, 0.9, NEUTRAL_LED, 1.0, 12 / mpp, request)
      continue
    }
    if (feature.type !== 2) continue
    for (const line of geometry(feature)) {
      if (line.length < 2) continue
      if (cls === 'taxiway') drawTaxiway(ctx, line, mpp, lightingAt(line[Math.floor(line.length / 2)]!, 2000))
    }
  }

  // Nothing on roofs: lamps are drawn on any upward surface at their place,
  // so lamps (and pools) inside building footprints lit roofs. Clear them
  // where the tile has buildings (zoom 14 only; farther out roofs are a
  // pixel or less).
  const buildings = tile.layers.building
  if (buildings != null && buildings.length > 0) {
    const mask = new OffscreenCanvas(size, size)
    const mctx = mask.getContext('2d')!
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'black'
    mctx.fillStyle = 'white'
    for (let i = 0; i < buildings.length; ++i) {
      const feature = buildings.feature(i)
      if (feature.type !== 3) continue
      const rings = geometry(feature)
      for (const target of [ctx, mctx]) {
        target.beginPath()
        for (const ring of rings) ring.forEach((p, k) => (k === 0 ? target.moveTo(p.x, p.y) : target.lineTo(p.x, p.y)))
        target.fill('evenodd')
      }
    }
    const inside = mctx.getImageData(0, 0, size, size).data
    for (let i = 0; i < size * size; ++i) {
      if (inside[i * 4]! < 128) continue
      lampCells[i * 4 + 3] = 0
      lampCells[i * 4 + 2] = 0
      lampEnergy[i] = 0
    }
  }

  const pixels = ctx.getImageData(0, 0, size, size).data
  for (let i = 0; i < size * size; ++i) pixels[i * 4 + 3] = Math.min(255, Math.round(lampEnergy[i]! * 255))
  return { pixels, lamps: lampCells, runways: index?.runways ?? [] }
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

/**
 * Taxiways: a dim green centerline at airports with instrument runways.
 * Taxiways with centerline lights don't have edge lights, and
 * OpenStreetMap maps many parallel taxiways and taxilanes: blue edges on
 * every one turned the field into a mass of dots. Small fields: none (at
 * most their parallel taxiway has blue edge lights, but the tiles don't
 * tell it from the unlit taxilanes between hangar rows).
 */
function drawTaxiway(ctx: Ctx, line: Point[], mpp: number, lighting: RunwayLighting): void {
  if (lighting === 'unlit' || lighting === 'basic') return
  along(line, 30 / mpp, 15 / mpp, (x, y) => {
    lamp(ctx, x, y, 2 / mpp, GREEN, 0.2, false)
  })
}

/** Distance (px) from a point to a polyline. */
function distanceToLine(p: Point, line: Point[]): number {
  let best = Infinity
  for (let i = 1; i < line.length; ++i) {
    const a = line[i - 1]!
    const b = line[i]!
    const abx = b.x - a.x
    const aby = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)))
    best = Math.min(best, Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t))
  }
  return best
}

/**
 * How a runway is lit. OpenStreetMap has no lighting data (and the tiles
 * don't say how big an airport is), so it goes by runway length, which
 * separates them well: short strips are mostly unlit, general aviation
 * runways (to ~1.5 km) have edge lights only, regional runways a simpler
 * approach light system, airline runways (2.4 km and longer) everything.
 */
type RunwayLighting = 'unlit' | 'basic' | 'instrument' | 'precision'

function runwayLighting(length: number): RunwayLighting {
  if (length >= 2400) return 'precision'
  if (length >= 1500) return 'instrument'
  if (length >= 700) return 'basic'
  return 'unlit'
}

/**
 * Whole runways, measured from a coarse tile (a z14 tile, ~1.7 km across at
 * mid latitudes, shows only part of a long runway). z12: z10 tiles drop
 * pieces of some runways (most of Boeing Field's main one), and runway
 * ends need to be exact (z12 coordinates are ~1.6 m steps). Coordinates are in
 * tile units at INDEX_ZOOM. Runways that the coarse tile cuts at its edge
 * continue in the neighbouring tile, which is loaded too.
 */
const INDEX_ZOOM = 12

interface RunwayIndex {
  /** The lighting of the runway nearest `p` within `near` meters, or null. */
  lightingNear(p: Point, near: number): RunwayLighting | null
  /** Every whole runway in the index (lit ones). */
  runways: RunwayRecord[]
}

interface Segment {
  a: Point
  b: Point
}

const indexTiles = new Map<string, Promise<Segment[]>>()
const indexes = new Map<string, Promise<RunwayIndex>>()

/** Runway segments of a coarse tile, clipped to its exact bounds. */
function indexTile(template: string, x: number, y: number): Promise<Segment[]> {
  const key = `${x}/${y}`
  let tile = indexTiles.get(key)
  if (tile == null) {
    const url = template.replace('{z}', String(INDEX_ZOOM)).replace('{x}', String(x)).replace('{y}', String(y))
    tile = fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`tile ${response.status}`)
        return response.arrayBuffer()
      })
      .then(data => {
        const layer = new VectorTile(new Pbf(new Uint8Array(data))).layers.aeroway
        const segments: Segment[] = []
        for (let i = 0; i < (layer?.length ?? 0); ++i) {
          const feature = layer!.feature(i)
          if (feature.type !== 2 || String(feature.properties.class) !== 'runway') continue
          const k = 1 / feature.extent
          for (const line of feature.loadGeometry()) {
            for (let j = 1; j < line.length; ++j) {
              const a = { x: x + line[j - 1]!.x * k, y: y + line[j - 1]!.y * k }
              const b = { x: x + line[j]!.x * k, y: y + line[j]!.y * k }
              const clipped = clipSegment(a, b, x, y, x + 1, y + 1)
              if (clipped != null) segments.push(clipped)
            }
          }
        }
        return segments
      })
    tile.catch(() => indexTiles.delete(key))
    if (indexTiles.size > 24) indexTiles.delete(indexTiles.keys().next().value!)
    indexTiles.set(key, tile)
  }
  return tile
}

/** Liang–Barsky: the part of segment ab inside the box, or null. */
function clipSegment(a: Point, b: Point, x0: number, y0: number, x1: number, y1: number): Segment | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y]
  ] as const) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return null
  }
  return { a: { x: a.x + dx * t0, y: a.y + dy * t0 }, b: { x: a.x + dx * t1, y: a.y + dy * t1 } }
}

function runwayIndex(request: RoadRasterRequest): Promise<RunwayIndex> {
  const k = 2 ** Math.max(0, request.z - INDEX_ZOOM)
  const x = Math.floor(request.x / k)
  const y = Math.floor(request.y / k)
  const key = `${x}/${y}`
  let index = indexes.get(key)
  if (index == null) {
    index = buildIndex(request.template, x, y)
    index.catch(() => indexes.delete(key))
    if (indexes.size > 16) indexes.delete(indexes.keys().next().value!)
    indexes.set(key, index)
  }
  return index
}

async function buildIndex(template: string, x: number, y: number): Promise<RunwayIndex> {
  const segments = [...(await indexTile(template, x, y))]
  // Runways the tile edge cuts: add the neighbour's side of them.
  const eps = 1e-9
  const sides = new Set<string>()
  for (const { a, b } of segments) {
    for (const p of [a, b]) {
      if (p.x < x + eps) sides.add(`${x - 1}/${y}`)
      if (p.x > x + 1 - eps) sides.add(`${x + 1}/${y}`)
      if (p.y < y + eps) sides.add(`${x}/${y - 1}`)
      if (p.y > y + 1 - eps) sides.add(`${x}/${y + 1}`)
      // Cut at a corner: the diagonal neighbour too.
      const dx = p.x < x + eps ? -1 : p.x > x + 1 - eps ? 1 : 0
      const dy = p.y < y + eps ? -1 : p.y > y + 1 - eps ? 1 : 0
      if (dx !== 0 && dy !== 0) sides.add(`${x + dx}/${y + dy}`)
    }
  }
  const n = 2 ** INDEX_ZOOM
  for (const side of sides) {
    // (Runways across the antimeridian or the poles: not worth it.)
    const [sx, sy] = side.split('/').map(Number) as [number, number]
    if (sx < 0 || sy < 0 || sx >= n || sy >= n) continue
    segments.push(...(await indexTile(template, sx, sy).catch(() => [])))
  }

  // Meters per tile unit at this latitude.
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)))
  const meters = ((2 * Math.PI * 6378137) / n) * Math.cos(lat)

  // Pieces of one runway: end to end (within 60 m) and in line. Crossing
  // runways meet at an angle and stay separate.
  const parent = segments.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const join = 60 / meters
  for (let i = 0; i < segments.length; ++i) {
    for (let j = i + 1; j < segments.length; ++j) {
      const s = segments[i]!
      const t = segments[j]!
      const close = [s.a, s.b].some(p => [t.a, t.b].some(q => Math.hypot(p.x - q.x, p.y - q.y) < join))
      if (!close) continue
      const sl = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
      const tl = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y)
      if (sl === 0 || tl === 0) continue
      const cos = ((s.b.x - s.a.x) * (t.b.x - t.a.x) + (s.b.y - s.a.y) * (t.b.y - t.a.y)) / (sl * tl)
      if (Math.abs(cos) > 0.98) parent[find(i)] = find(j)
    }
  }
  const lengths = new Map<number, number>()
  segments.forEach((s, i) => {
    const root = find(i)
    lengths.set(root, (lengths.get(root) ?? 0) + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) * meters)
  })

  // Each runway: its two farthest-apart points (its ends; the pieces are
  // in line), so its lights follow one straight axis.
  const pieces = new Map<number, Point[]>()
  segments.forEach((s, i) => {
    const root = find(i)
    const points = pieces.get(root) ?? []
    points.push(s.a, s.b)
    pieces.set(root, points)
  })
  const runways: RunwayRecord[] = []
  const toDegrees = (p: Point): [number, number] => [
    (p.x / n) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * p.y) / n))) * 180) / Math.PI
  ]
  for (const [root, points] of pieces) {
    const lighting = runwayLighting(lengths.get(root) ?? 0)
    if (lighting === 'unlit') continue
    let best = -1
    let a = points[0]!
    let b = points[0]!
    for (let i = 0; i < points.length; ++i) {
      for (let j = i + 1; j < points.length; ++j) {
        const d = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)
        if (d > best) {
          best = d
          a = points[i]!
          b = points[j]!
        }
      }
    }
    runways.push({ a: toDegrees(a), b: toDegrees(b), lighting })
  }

  return {
    runways,
    lightingNear(p: Point, near: number): RunwayLighting | null {
      let best = near / meters
      let found = -1
      segments.forEach((s, i) => {
        const d = distanceToLine(p, [s.a, s.b])
        if (d < best) {
          best = d
          found = i
        }
      })
      return found < 0 ? null : runwayLighting(lengths.get(find(found)) ?? 0)
    }
  }
}

self.onmessage = async (event: MessageEvent<RoadRasterRequest>) => {
  const request = event.data
  try {
    const response = await fetch(request.url)
    if (!response.ok) throw new Error(`tile ${response.status}`)
    const { pixels, lamps, runways } = await render(request, await response.arrayBuffer())
    const message: RoadRasterResponse = { id: request.id, pixels, lamps, runways }
    ;(self as unknown as Worker).postMessage(message, [pixels.buffer, lamps.buffer])
  } catch (error) {
    const message: RoadRasterResponse = {
      id: request.id,
      pixels: null,
      lamps: null,
      error: error instanceof Error ? error.message : String(error)
    }
    ;(self as unknown as Worker).postMessage(message)
  }
}
