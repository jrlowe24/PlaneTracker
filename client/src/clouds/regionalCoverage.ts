import {
  convectiveCoverage,
  ecefToGeodetic,
  enuBasis,
  normalizeLongitude,
  type WeatherGridCell
} from '@windowseat/shared'
import { DataTexture, LinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType, Vector3 } from 'three'

import { gridKey } from '../data/weather'

/**
 * Cloud cover that varies across the map: the server's 1° weather cells
 * (low/mid/high cover) interpolated into a texture covering a square
 * around the view, in a local east/north plane. The clouds shader looks up
 * each sample's position in it, so a cloudy region stays put and you fly
 * into and out of it, instead of the whole sky thickening and clearing in
 * place as the view center's single weather sample changes.
 *
 * - Cell values ease toward new data (CELL_TIME_CONSTANT), so an updated
 *   forecast builds or thins clouds gradually; cells seen for the first
 *   time snap (they're at the edge of the grid, far away).
 * - The texture is re-centered when the view moves RECENTER_DISTANCE from
 *   its anchor; contents are geographic, so re-centering doesn't move
 *   clouds.
 * - Where no cell is known (beyond the grid), the nearest known cell's
 *   cover extends outward, so nothing snaps to a single reading.
 */

const SIZE = 64
/** Half-width of the covered square, meters. */
export const REGION_RADIUS = 600_000
const RECENTER_DISTANCE = 150_000
const CELL_TIME_CONSTANT = 90
const UPDATE_INTERVAL = 0.5

export interface Cover {
  low: number
  mid: number
  high: number
  /** Convective tower coverage (0 … 1). */
  conv: number
}

export class RegionalCoverage {
  readonly texture: DataTexture
  readonly anchor = new Vector3()
  readonly east = new Vector3(1, 0, 0)
  readonly north = new Vector3(0, 1, 0)
  /** False until the first grid arrives. */
  hasData = false

  private readonly data = new Uint8Array(SIZE * SIZE * 4)
  private readonly displayed = new Map<string, Cover>()
  private anchored = false
  private sinceUpdate = Infinity
  private readonly point = new Vector3()

  constructor() {
    const texture = new DataTexture(this.data, SIZE, SIZE, RGBAFormat, UnsignedByteType)
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.colorSpace = NoColorSpace
    texture.needsUpdate = true
    this.texture = texture
  }

  /** Call every frame with the view center (ECEF) and the received grid. */
  update(dt: number, center: Vector3, grid: ReadonlyMap<string, WeatherGridCell>): void {
    this.sinceUpdate += dt
    if (this.sinceUpdate < UPDATE_INTERVAL) return
    const elapsed = Math.min(this.sinceUpdate, 5)
    this.sinceUpdate = 0
    if (grid.size === 0) return

    // Ease displayed cells toward the data; new cells snap.
    const k = 1 - Math.exp(-elapsed / CELL_TIME_CONSTANT)
    for (const [key, cell] of grid) {
      const target = {
        low: cell.low / 100,
        mid: cell.mid / 100,
        high: cell.high / 100,
        conv: convectiveCoverage(cell.cape, cell.code)
      }
      const shown = this.displayed.get(key)
      if (shown == null) {
        this.displayed.set(key, target)
      } else {
        shown.low += (target.low - shown.low) * k
        shown.mid += (target.mid - shown.mid) * k
        shown.high += (target.high - shown.high) * k
        shown.conv += (target.conv - shown.conv) * k
      }
    }
    for (const key of this.displayed.keys()) {
      if (!grid.has(key)) this.displayed.delete(key)
    }

    if (!this.anchored || center.distanceTo(this.anchor) > RECENTER_DISTANCE) {
      const g = ecefToGeodetic(center.x, center.y, center.z)
      const basis = enuBasis(g.lat, g.lon)
      this.anchor.copy(center)
      this.east.set(basis.east.x, basis.east.y, basis.east.z)
      this.north.set(basis.north.x, basis.north.y, basis.north.z)
      this.anchored = true
    }
    this.rebuild()
    this.hasData = true
  }

  /** Known cell bounds (integer degrees), for extending edges outward. */
  private bounds = { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 }
  private mean: Cover = { low: 0, mid: 0, high: 0, conv: 0 }

  private updateBounds(): void {
    let minLat = Infinity
    let maxLat = -Infinity
    let minLon = Infinity
    let maxLon = -Infinity
    const mean = { low: 0, mid: 0, high: 0, conv: 0 }
    for (const [key, c] of this.displayed) {
      const [lat, lon] = key.split(',').map(Number) as [number, number]
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
      mean.low += c.low
      mean.mid += c.mid
      mean.high += c.high
      mean.conv += c.conv
    }
    const n = Math.max(1, this.displayed.size)
    this.mean = { low: mean.low / n, mid: mean.mid / n, high: mean.high / n, conv: mean.conv / n }
    this.bounds = { minLat, maxLat, minLon, maxLon }
  }

  /** A cell's cover; unknown cells take the nearest known cell (clamped to the grid). */
  private cover(lat: number, lon: number): Cover {
    const lonN = normalizeLongitude(lon)
    const exact = this.displayed.get(gridKey(lat, lonN))
    if (exact != null) return exact
    const b = this.bounds
    const clampedLat = Math.min(b.maxLat, Math.max(b.minLat, lat))
    const clampedLon = Math.min(b.maxLon, Math.max(b.minLon, lonN))
    return this.displayed.get(gridKey(clampedLat, clampedLon)) ?? this.mean
  }

  /**
   * Cover (0…1 per layer) at a point, bilinear between the four surrounding
   * cell centers; null before any grid data.
   */
  coverAt(lat: number, lon: number): Cover | null {
    if (this.displayed.size === 0) return null
    const lat0 = Math.floor(lat)
    const lon0 = Math.floor(lon)
    const fy = lat - lat0
    const fx = lon - lon0
    const c00 = this.cover(lat0, lon0)
    const c10 = this.cover(lat0, lon0 + 1)
    const c01 = this.cover(lat0 + 1, lon0)
    const c11 = this.cover(lat0 + 1, lon0 + 1)
    const mix = (a: number, b: number, c: number, d: number): number =>
      (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return {
      low: mix(c00.low, c10.low, c01.low, c11.low),
      mid: mix(c00.mid, c10.mid, c01.mid, c11.mid),
      high: mix(c00.high, c10.high, c01.high, c11.high),
      conv: mix(c00.conv, c10.conv, c01.conv, c11.conv)
    }
  }

  private rebuild(): void {
    this.updateBounds()
    const { data, point } = this
    for (let j = 0; j < SIZE; ++j) {
      const y = ((j + 0.5) / SIZE - 0.5) * 2 * REGION_RADIUS
      for (let i = 0; i < SIZE; ++i) {
        const x = ((i + 0.5) / SIZE - 0.5) * 2 * REGION_RADIUS
        point.copy(this.anchor).addScaledVector(this.east, x).addScaledVector(this.north, y)
        const g = ecefToGeodetic(point.x, point.y, point.z)
        const c = this.coverAt(g.lat, g.lon)!
        const o = (j * SIZE + i) * 4
        data[o] = Math.round(255 * c.low)
        data[o + 1] = Math.round(255 * c.mid)
        data[o + 2] = Math.round(255 * c.high)
        data[o + 3] = Math.round(255 * c.conv)
      }
    }
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
