import { ecefToGeodetic, geodeticToEcef, WGS84_A } from '@windowseat/shared'
import {
  DataArrayTexture,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  type Camera
} from 'three'

import type { RoadRasterRequest, RoadRasterResponse } from './roadRaster.worker'

/**
 * Street, area and airport lighting from OpenStreetMap (OpenFreeMap vector
 * tiles, no key), rasterized into a texture array in two windows of
 * WINDOW×WINDOW Web Mercator tiles around the view:
 *
 * - level 0: zoom 14 (~1.6–2.4 km tiles; every street, lamp by lamp),
 * - level 1: zoom 12 (~6.5–10 km tiles; the arterials and airports beyond),
 * - level 2: zoom 10 (~26–40 km tiles; motorways and main roads farther out).
 *
 * The shader maps each pixel's ground position to tile coordinates with a
 * local Mercator expansion around each window's anchor (accurate to well
 * under a meter across a window), so no large coordinates reach the GPU.
 */

export const WINDOW = 4
export const ROAD_TILE_SIZE = 512
const SIZE = ROAD_TILE_SIZE
const LEVELS = [
  // z, max camera altitude (m) at which the level is used, how far ahead
  // of the camera the window centers (m).
  { z: 14, maxAltitude: 14_000, lead: 2_500 },
  { z: 12, maxAltitude: 60_000, lead: 9_000 },
  // Motorways and main roads out to the horizon from cruise altitudes.
  { z: 10, maxAltitude: 250_000, lead: 35_000 }
] as const
export const ROAD_LEVELS = LEVELS.length
const WORKERS = 2
const MAX_IN_FLIGHT = 4
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
  /** Texture layer per window cell (row-major), −1 while not loaded. */
  layers: Float32Array
}

interface Slot {
  key: string
  loaded: boolean
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
    layers: new Float32Array(WINDOW * WINDOW).fill(-1)
  }
  /** Window origin tile. */
  ox = Number.NaN
  oy = Number.NaN
  private readonly anchorEcef = new Vector3()
  private lat0 = 0
  private lon0 = 0
  readonly slots: Slot[] = Array.from({ length: WINDOW * WINDOW }, () => ({ key: '', loaded: false }))

  constructor(
    readonly index: number,
    readonly z: number
  ) {}

  /** Re-centers the window if `center` (tile coords) left its middle. */
  place(center: { x: number; y: number }): boolean {
    const ox = Math.floor(center.x - WINDOW / 2 + 0.5)
    const oy = Math.floor(center.y - WINDOW / 2 + 0.5)
    if (Number.isFinite(this.ox) && Math.abs(ox - this.ox) < 1 && Math.abs(oy - this.oy) < 1) return false
    // Hysteresis: only move when the center is more than 0.75 tile off.
    const mx = this.ox + WINDOW / 2
    const my = this.oy + WINDOW / 2
    if (Number.isFinite(this.ox) && Math.abs(center.x - mx) < 0.75 && Math.abs(center.y - my) < 0.75) return false
    this.ox = ox
    this.oy = oy
    // Anchor: the window's middle.
    const n = 2 ** this.z
    this.lon0 = ((ox + WINDOW / 2) / n) * 360 - 180
    this.lat0 = latOfTileY(oy + WINDOW / 2, this.z)
    const p = geodeticToEcef(this.lat0, this.lon0, 0)
    this.anchorEcef.set(p.x, p.y, p.z)
    const lat = (this.lat0 * Math.PI) / 180
    const lon = (this.lon0 * Math.PI) / 180
    this.uniforms.east.set(-Math.sin(lon), Math.cos(lon), 0)
    this.uniforms.north.set(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat))
    const { m, n: nRadius } = radii(lat)
    const s = n / (2 * Math.PI)
    const sec = 1 / Math.cos(lat)
    this.uniforms.mercator = [WINDOW / 2, WINDOW / 2, (s * sec) / nRadius, (s * sec) / m]
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
    const sx = ((tx % WINDOW) + WINDOW) % WINDOW
    const sy = ((ty % WINDOW) + WINDOW) % WINDOW
    return sy * WINDOW + sx
  }

  layerOf(slot: number): number {
    return this.index * WINDOW * WINDOW + slot
  }

  updateUniforms(camera: Vector3, enabled: boolean): void {
    this.uniforms.enabled = enabled && Number.isFinite(this.ox)
    this.uniforms.anchor.copy(this.anchorEcef).sub(camera)
    for (let cy = 0; cy < WINDOW; ++cy) {
      for (let cx = 0; cx < WINDOW; ++cx) {
        const { x, y } = this.cellTile(cx, cy)
        const slot = this.slotFor(x, y)
        const s = this.slots[slot]!
        this.uniforms.layers[cy * WINDOW + cx] =
          s.loaded && s.key === `${this.z}/${x}/${y}` ? this.layerOf(slot) : -1
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
  readonly levels = LEVELS.map((l, i) => new Level(i, l.z))
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

  constructor() {
    this.data = new Uint8Array(SIZE * SIZE * 4 * WINDOW * WINDOW * LEVELS.length)
    this.lampData = new Uint8Array(this.data.length)
    const lamps = new DataArrayTexture(this.lampData, SIZE, SIZE, WINDOW * WINDOW * LEVELS.length)
    lamps.format = RGBAFormat
    lamps.type = UnsignedByteType
    lamps.colorSpace = NoColorSpace
    lamps.minFilter = NearestFilter
    lamps.magFilter = NearestFilter
    lamps.generateMipmaps = false
    lamps.needsUpdate = true
    this.lamps = lamps
    const texture = new DataArrayTexture(this.data, SIZE, SIZE, WINDOW * WINDOW * LEVELS.length)
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
    LEVELS.forEach((spec, i) => {
      const level = this.levels[i]!
      const enabled = this.available && altitude < spec.maxAltitude
      if (enabled) {
        const lead = Math.min(reach, spec.lead)
        ground.copy(up).multiplyScalar(WGS84_A)
        if (horizontalLength > 1e-6) ground.addScaledVector(horizontal, lead / horizontalLength)
        const g = ecefToGeodetic(ground.x, ground.y, ground.z)
        level.place(tileOf(g.lat, g.lon, level.z))
        this.request(level)
      }
      level.updateUniforms(position, enabled)
    })
  }

  private request(level: Level): void {
    if (this.template == null || this.pending.size >= MAX_IN_FLIGHT) return
    const cells: Array<{ cx: number; cy: number; d: number }> = []
    for (let cy = 0; cy < WINDOW; ++cy) {
      for (let cx = 0; cx < WINDOW; ++cx) {
        cells.push({ cx, cy, d: Math.hypot(cx + 0.5 - WINDOW / 2, cy + 0.5 - WINDOW / 2) })
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
        metersPerPixel: ((2 * Math.PI * WGS84_A) / 2 ** level.z) * Math.cos((lat * Math.PI) / 180) / SIZE
      }
      this.pending.set(request.id, { level, slot, key })
      this.workers[this.nextWorker++ % this.workers.length]!.postMessage(request)
    }
  }

  private receive(response: RoadRasterResponse): void {
    const entry = this.pending.get(response.id)
    if (entry == null) return
    this.pending.delete(response.id)
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
    s.loaded = true
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate()
    this.texture.dispose()
    this.lamps.dispose()
  }
}
