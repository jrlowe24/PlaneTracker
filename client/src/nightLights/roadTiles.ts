import { ecefToGeodetic, geodeticToEcef, WGS84_A } from '@windowseat/shared'
import {
  DataArrayTexture,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  UnsignedByteType,
  Vector3,
  type Camera
} from 'three'

import type { RoadRasterRequest, RoadRasterResponse } from './roadRaster.worker'
import { RunwayLights } from './runwayLights'

/**
 * Street, area and airport lighting from OpenStreetMap (OpenFreeMap vector
 * tiles, no key), rasterized into a texture array in two windows of
 * window×window Web Mercator tiles around the view (6 at street level, 4 beyond):
 *
 * - level 0: zoom 14 (~1.6–2.4 km tiles; every street, lamp by lamp),
 * - level 1: zoom 12 (~6.5–10 km tiles; the arterials and airports beyond),
 * - level 2: zoom 10 (~26–40 km tiles; motorways and main roads farther out).
 *
 * The shader maps each pixel's ground position to tile coordinates with a
 * local Mercator expansion around each window's anchor (accurate to well
 * under a meter across a window), so no large coordinates reach the GPU.
 */

/** Largest window (tiles per side): the shader's per-level array stride. */
export const MAX_WINDOW = 6
export const ROAD_TILE_SIZE = 512
const SIZE = ROAD_TILE_SIZE
export type LightDistance = 'near' | 'medium' | 'far'

interface LevelSpec {
  /** Web Mercator zoom of the street data. */
  z: number
  /** Window, tiles per side. */
  window: number
  /** Highest camera altitude (m) at which the level is used. */
  maxAltitude: number
  /** How far ahead of the camera the window centers (m). */
  lead: number
}

/**
 * Street-tile windows by light distance (Settings → Graphics): how far out
 * lamps are drawn one by one. Each layer is two 512² RGBA textures (2 MB).
 * Always three levels: street (z14), roads (z12), motorways and main roads
 * to the horizon from cruise altitudes (z10).
 */
export const LIGHT_DISTANCE_LEVELS: Record<LightDistance, readonly LevelSpec[]> = {
  // 17 layers, ~35 MB: street by street over a few km.
  near: [
    { z: 14, window: 2, maxAltitude: 8_000, lead: 1_500 },
    { z: 12, window: 2, maxAltitude: 40_000, lead: 5_000 },
    { z: 10, window: 3, maxAltitude: 250_000, lead: 25_000 }
  ],
  // 41 layers, ~85 MB.
  medium: [
    { z: 14, window: 4, maxAltitude: 11_000, lead: 2_500 },
    { z: 12, window: 3, maxAltitude: 50_000, lead: 7_000 },
    { z: 10, window: 4, maxAltitude: 250_000, lead: 35_000 }
  ],
  // 68 layers, ~140 MB: street level spans 6x6 tiles (~10 km), lamp by
  // lamp much farther out; the budget the dark terrain frees at night.
  far: [
    { z: 14, window: 6, maxAltitude: 14_000, lead: 3_500 },
    { z: 12, window: 4, maxAltitude: 60_000, lead: 9_000 },
    { z: 10, window: 4, maxAltitude: 250_000, lead: 35_000 }
  ]
}
export const ROAD_LEVELS = 3
const WORKERS = 2
const MAX_IN_FLIGHT = 6
const TILEJSON = 'https://tiles.openfreemap.org/planet'

/** WGS84 meridian (M) and prime vertical (N) radii of curvature. */
function radii(lat: number): { m: number; n: number } {
  const e2 = 0.00669437999014
  const s = Math.sin(lat)
  const w = Math.sqrt(1 - e2 * s * s)
  return { m: (WGS84_A * (1 - e2)) / (w * w * w), n: WGS84_A / w }
}

function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const phi = (lat * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n
  }
}

function latOfTileY(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

/** Per-level values the shader needs (see NightLightsPass). */
export interface RoadLevelUniforms {
  enabled: boolean
  /** Window anchor relative to the camera (m). */
  anchor: Vector3
  east: Vector3
  north: Vector3
  /** Anchor in window tile coordinates; X / Y meters scale; tanφ / M. */
  mercator: [x0: number, y0: number, kx: number, ky: number]
  curvature: number
  /** Ground meters per texel at the anchor. */
  metersPerTexel: number
  /** Window origin tile (world-fixed integer cells for procedural lamps). */
  origin: [x: number, y: number]
  /** Tiles per side of this level's window. */
  window: number
  /** Texture layer per window cell (row-major, `window` wide), −1 while not loaded. */
  layers: Float32Array
  /**
   * Per window cell, 0 … 1: how far a newly arrived tile has faded in (the
   * coarser level shows through meanwhile), times the level's own fade
   * with altitude: lights cross-fade instead of popping in.
   */
  fade: Float32Array
}

/** Seconds a newly loaded tile takes to fade in. */
const TILE_FADE_S = 0.6
/** Each level fades out over the top quarter of its altitude range. */
const LEVEL_FADE = 0.25

interface Slot {
  key: string
  loaded: boolean
  /** When the tile arrived (performance.now()). */
  loadedAt: number
}

class Level {
  readonly uniforms: RoadLevelUniforms = {
    enabled: false,
    anchor: new Vector3(),
    east: new Vector3(),
    north: new Vector3(),
    mercator: [0, 0, 0, 0],
    curvature: 0,
    metersPerTexel: 1,
    origin: [0, 0],
    window: 4,
    layers: new Float32Array(MAX_WINDOW * MAX_WINDOW).fill(-1),
    fade: new Float32Array(MAX_WINDOW * MAX_WINDOW)
  }
  /** Window origin tile. */
  ox = Number.NaN
  oy = Number.NaN
  private readonly anchorEcef = new Vector3()
  private lat0 = 0
  private lon0 = 0
  readonly slots: Slot[]

  constructor(
    readonly index: number,
    readonly z: number,
    readonly window: number,
    /** First texture layer of this level's window. */
    private readonly layerBase: number
  ) {
    this.slots = Array.from({ length: window * window }, () => ({ key: '', loaded: false, loadedAt: 0 }))
    this.uniforms.window = window
  }

  /** Re-centers the window if `center` (tile coords) left its middle. */
  place(center: { x: number; y: number }): boolean {
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return false
    const ox = Math.floor(center.x - this.window / 2 + 0.5)
    const oy = Math.floor(center.y - this.window / 2 + 0.5)
    if (Number.isFinite(this.ox) && Math.abs(ox - this.ox) < 1 && Math.abs(oy - this.oy) < 1) return false
    // Hysteresis: only move when the center is more than 0.75 tile off.
    const mx = this.ox + this.window / 2
    const my = this.oy + this.window / 2
    if (Number.isFinite(this.ox) && Math.abs(center.x - mx) < 0.75 && Math.abs(center.y - my) < 0.75) return false
    this.ox = ox
    this.oy = oy
    // Anchor: the window's middle.
    const n = 2 ** this.z
    this.lon0 = ((ox + this.window / 2) / n) * 360 - 180
    this.lat0 = latOfTileY(oy + this.window / 2, this.z)
    const p = geodeticToEcef(this.lat0, this.lon0, 0)
    this.anchorEcef.set(p.x, p.y, p.z)
    const lat = (this.lat0 * Math.PI) / 180
    const lon = (this.lon0 * Math.PI) / 180
    this.uniforms.east.set(-Math.sin(lon), Math.cos(lon), 0)
    this.uniforms.north.set(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat))
    const { m, n: nRadius } = radii(lat)
    const s = n / (2 * Math.PI)
    const sec = 1 / Math.cos(lat)
    this.uniforms.mercator = [this.window / 2, this.window / 2, (s * sec) / nRadius, (s * sec) / m]
    this.uniforms.curvature = Math.tan(lat) / m
    this.uniforms.origin = [ox, oy]
    this.uniforms.metersPerTexel = ((2 * Math.PI * WGS84_A) / n) * Math.cos(lat) / SIZE
    return true
  }

  /** Tile at window cell (cx, cy). */
  cellTile(cx: number, cy: number): { x: number; y: number } {
    return { x: this.ox + cx, y: this.oy + cy }
  }

  slotFor(tx: number, ty: number): number {
    const sx = ((tx % this.window) + this.window) % this.window
    const sy = ((ty % this.window) + this.window) % this.window
    return sy * this.window + sx
  }

  layerOf(slot: number): number {
    return this.layerBase + slot
  }

  updateUniforms(camera: Vector3, strength: number): void {
    this.uniforms.enabled = strength > 0 && Number.isFinite(this.ox)
    // Never placed yet (the lights came on with the camera above this
    // level's range): nothing to show, and no cells to look up.
    if (!Number.isFinite(this.ox) || !Number.isFinite(this.oy)) {
      this.uniforms.layers.fill(-1)
      this.uniforms.fade.fill(0)
      return
    }
    this.uniforms.anchor.copy(this.anchorEcef).sub(camera)
    const now = performance.now()
    for (let cy = 0; cy < this.window; ++cy) {
      for (let cx = 0; cx < this.window; ++cx) {
        const { x, y } = this.cellTile(cx, cy)
        const slot = this.slotFor(x, y)
        const s = this.slots[slot]!
        const ready = s.loaded && s.key === `${this.z}/${x}/${y}`
        this.uniforms.layers[cy * this.window + cx] = ready ? this.layerOf(slot) : -1
        const t = ready ? Math.min(1, (now - s.loadedAt) / (TILE_FADE_S * 1000)) : 0
        // Smoothstep: no visible start or end of the fade.
        this.uniforms.fade[cy * this.window + cx] = t * t * (3 - 2 * t) * strength
      }
    }
  }
}

const forward = new Vector3()
const up = new Vector3()
const ground = new Vector3()

export class RoadLightTiles {
  readonly texture: DataArrayTexture
  /** Exact lamp positions per texel cell (nearest filtering, no mips). */
  readonly lamps: DataArrayTexture
  /**
   * Building height and id per texel of the finest level's tiles (one
   * layer per window slot; see RoadRasterResponse.buildings), for lit
   * windows.
   */
  readonly buildings: DataArrayTexture
  readonly levels: Level[]
  private readonly specs: readonly LevelSpec[]
  private readonly layerCount: number
  /** Building layers: the finest level's tiles (the first layers). */
  private readonly buildingLayers: number
  /** Whole runways seen in the tiles, lit exactly by the shader. */
  readonly runways = new RunwayLights()
  /** False until OpenFreeMap's tile URL is known; stays false if it fails. */
  available = false
  private template: string | null = null
  private readonly workers: Worker[] = []
  private nextWorker = 0
  private nextId = 0
  private readonly pending = new Map<number, { level: Level; slot: number; key: string }>()
  private readonly failed = new Map<string, number>()
  private readonly data: Uint8Array
  private readonly lampData: Uint8Array
  private readonly buildingData: Uint8Array

  constructor(distance: LightDistance = 'far') {
    const specs = LIGHT_DISTANCE_LEVELS[distance]
    this.specs = specs
    let base = 0
    this.levels = specs.map((l, i) => {
      const level = new Level(i, l.z, l.window, base)
      base += l.window * l.window
      return level
    })
    this.layerCount = base
    this.buildingLayers = specs[0]!.window * specs[0]!.window
    const layerCount = this.layerCount
    const buildingLayers = this.buildingLayers
    this.data = new Uint8Array(SIZE * SIZE * 4 * layerCount)
    this.lampData = new Uint8Array(this.data.length)
    const lamps = new DataArrayTexture(this.lampData, SIZE, SIZE, layerCount)
    lamps.format = RGBAFormat
    lamps.type = UnsignedByteType
    lamps.colorSpace = NoColorSpace
    lamps.minFilter = NearestFilter
    lamps.magFilter = NearestFilter
    lamps.generateMipmaps = false
    lamps.needsUpdate = true
    this.lamps = lamps
    const texture = new DataArrayTexture(this.data, SIZE, SIZE, layerCount)
    texture.format = RGBAFormat
    texture.type = UnsignedByteType
    texture.colorSpace = NoColorSpace
    // No mipmaps: the shader samples each level where its texels are about
    // a pixel. (Regenerating the array's mips on every tile arrival was a
    // multi-millisecond hitch.)
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    this.texture = texture
    this.buildingData = new Uint8Array(SIZE * SIZE * 2 * buildingLayers)
    const buildings = new DataArrayTexture(this.buildingData, SIZE, SIZE, buildingLayers)
    buildings.format = RGFormat
    buildings.type = UnsignedByteType
    buildings.colorSpace = NoColorSpace
    buildings.minFilter = NearestFilter
    buildings.magFilter = NearestFilter
    buildings.generateMipmaps = false
    buildings.needsUpdate = true
    this.buildings = buildings
    void this.init()
  }

  private async init(): Promise<void> {
    try {
      const response = await fetch(TILEJSON)
      if (!response.ok) throw new Error(String(response.status))
      const json = (await response.json()) as { tiles?: string[] }
      this.template = json.tiles?.[0] ?? null
    } catch (error) {
      console.warn('[road lights] OpenFreeMap unavailable', error)
    }
    if (this.template == null) return
    for (let i = 0; i < WORKERS; ++i) {
      const worker = new Worker(new URL('./roadRaster.worker.ts', import.meta.url), {
        type: 'module',
        name: `road-lights-${i}`
      })
      worker.onmessage = (event: MessageEvent<RoadRasterResponse>) => {
        this.receive(event.data)
      }
      this.workers.push(worker)
    }
    this.available = true
  }

  /**
   * Places the windows around the view: each centers on where the camera
   * looks (its ray to the ground), at most `lead` meters ahead of the
   * point below it. Then queues missing tiles, nearest first.
   */
  update(camera: Camera): void {
    const position = camera.position
    const altitude = position.length() - WGS84_A
    up.copy(position).normalize()
    camera.getWorldDirection(forward)
    const horizontal = forward.clone().addScaledVector(up, -forward.dot(up))
    const horizontalLength = horizontal.length()
    const down = -forward.dot(up)
    // Ground distance (along the surface) to where the view ray lands.
    const reach = down > 0.01 ? (Math.max(0, altitude) * horizontalLength) / down : Infinity
    this.specs.forEach((spec, i) => {
      const level = this.levels[i]!
      const enabled = this.available && altitude < spec.maxAltitude
      // Fades out over the top of its altitude range (no pop at the limit).
      const t = Math.min(1, Math.max(0, (spec.maxAltitude - altitude) / (spec.maxAltitude * LEVEL_FADE)))
      const strength = enabled ? t * t * (3 - 2 * t) : 0
      if (enabled) {
        const lead = Math.min(reach, spec.lead)
        ground.copy(up).multiplyScalar(WGS84_A)
        if (horizontalLength > 1e-6) ground.addScaledVector(horizontal, lead / horizontalLength)
        const g = ecefToGeodetic(ground.x, ground.y, ground.z)
        level.place(tileOf(g.lat, g.lon, level.z))
        this.request(level)
      }
      level.updateUniforms(position, strength)
    })
  }

  private request(level: Level): void {
    if (this.template == null || this.pending.size >= MAX_IN_FLIGHT) return
    const cells: Array<{ cx: number; cy: number; d: number }> = []
    const w = level.window
    for (let cy = 0; cy < w; ++cy) {
      for (let cx = 0; cx < w; ++cx) {
        cells.push({ cx, cy, d: Math.hypot(cx + 0.5 - w / 2, cy + 0.5 - w / 2) })
      }
    }
    cells.sort((a, b) => a.d - b.d)
    const now = performance.now()
    for (const { cx, cy } of cells) {
      if (this.pending.size >= MAX_IN_FLIGHT) return
      const { x, y } = level.cellTile(cx, cy)
      const key = `${level.z}/${x}/${y}`
      const slot = level.slotFor(x, y)
      const s = level.slots[slot]!
      if (s.key === key) continue
      if ([...this.pending.values()].some(p => p.key === key)) continue
      if ((this.failed.get(key) ?? 0) > now) continue
      s.key = key
      s.loaded = false
      const lat = latOfTileY(y + 0.5, level.z)
      const request: RoadRasterRequest = {
        id: this.nextId++,
        url: this.template.replace('{z}', String(level.z)).replace('{x}', String(x)).replace('{y}', String(y)),
        z: level.z,
        x,
        y,
        size: SIZE,
        metersPerPixel: ((2 * Math.PI * WGS84_A) / 2 ** level.z) * Math.cos((lat * Math.PI) / 180) / SIZE,
        template: this.template
      }
      this.pending.set(request.id, { level, slot, key })
      this.workers[this.nextWorker++ % this.workers.length]!.postMessage(request)
    }
  }

  private receive(response: RoadRasterResponse): void {
    const entry = this.pending.get(response.id)
    if (entry == null) return
    this.pending.delete(response.id)
    if (response.runways != null) this.runways.add(response.runways)
    const { level, slot, key } = entry
    const s = level.slots[slot]!
    if (response.pixels == null || response.lamps == null) {
      // Retry later; keep the slot empty.
      this.failed.set(key, performance.now() + 30_000)
      if (s.key === key) s.key = ''
      return
    }
    if (s.key !== key) return // window moved on
    const layer = level.layerOf(slot)
    this.data.set(response.pixels, layer * SIZE * SIZE * 4)
    this.texture.addLayerUpdate(layer)
    this.texture.needsUpdate = true
    this.lampData.set(response.lamps, layer * SIZE * SIZE * 4)
    this.lamps.addLayerUpdate(layer)
    this.lamps.needsUpdate = true
    if (layer < this.buildingLayers) {
      const offset = layer * SIZE * SIZE * 2
      if (response.buildings != null) this.buildingData.set(response.buildings, offset)
      else this.buildingData.fill(0, offset, offset + SIZE * SIZE * 2)
      this.buildings.addLayerUpdate(layer)
      this.buildings.needsUpdate = true
    }
    s.loaded = true
    s.loadedAt = performance.now()
  }

  /**
   * Light from the streets and aprons around a ground point (ECEF), as
   * irradiance for lighting aircraft standing there: the finest loaded
   * level's pools and lamps averaged over ~40 m. False when not covered.
   */
  groundLight(position: Vector3, out: Vector3): boolean {
    const g = ecefToGeodetic(position.x, position.y, position.z)
    for (const level of this.levels) {
      if (!level.uniforms.enabled) continue
      const t = tileOf(g.lat, g.lon, level.z)
      const tx = Math.floor(t.x)
      const ty = Math.floor(t.y)
      const slot = level.slotFor(tx, ty)
      const s = level.slots[slot]!
      if (!s.loaded || s.key !== `${level.z}/${tx}/${ty}`) continue
      const half = Math.max(1, Math.round(20 / level.uniforms.metersPerTexel))
      const cx = Math.floor((t.x - tx) * SIZE)
      const cy = Math.floor((t.y - ty) * SIZE)
      const base = level.layerOf(slot) * SIZE * SIZE * 4
      let r = 0
      let gr = 0
      let b = 0
      let lamps = 0
      let n = 0
      for (let y = Math.max(0, cy - half); y <= Math.min(SIZE - 1, cy + half); ++y) {
        for (let x = Math.max(0, cx - half); x <= Math.min(SIZE - 1, cx + half); ++x) {
          const i = base + (y * SIZE + x) * 4
          r += this.data[i]!
          gr += this.data[i + 1]!
          b += this.data[i + 2]!
          lamps += this.data[i + 3]!
          ++n
        }
      }
      if (n === 0) return false
      // Pools carry the color; lamp energy adds (neutral) light.
      const k = 1 / (n * 255)
      const lamp = lamps * k * 0.15
      out.set(r * k + lamp, gr * k + lamp * 0.9, b * k + lamp * 0.8)
      return true
    }
    return false
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate()
    this.texture.dispose()
    this.lamps.dispose()
    this.buildings.dispose()
  }
}
