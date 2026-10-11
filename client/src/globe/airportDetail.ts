import type { TilesRenderer } from '3d-tiles-renderer'
import { ecefToGeodetic } from '@windowseat/shared'
import { Sphere } from 'three'

import { loadRunwayCatalog, runwayEndsNear } from '../data/runwayCatalog'

/**
 * Airports keep their terrain detail at night. The night coarsens all
 * tiles (QualityApplier: the ground is barely visible), but runways and
 * taxiways are where you look at night, lit and with aircraft on them:
 * tiles near a runway get their screen-space error scaled back up by
 * `boost`, so they refine as by day.
 */

/** Tiles wider than this (bounding radius, m) aren't "airport" tiles. */
const MAX_TILE_RADIUS = 3000
/** Reach beyond a runway's ends and sides, meters. */
const MARGIN = 1200

const state = { boost: 1, ready: false }
const nearRunway = new WeakMap<object, boolean>()
const sphere = new Sphere()

void loadRunwayCatalog().then(() => {
  state.ready = true
})

export function setAirportDetailBoost(boost: number): void {
  state.boost = boost
}

interface TileLike {
  engineData?: { boundingVolume?: { getSphere: (target: Sphere) => Sphere } }
}

function isNearRunway(tile: TileLike): boolean {
  const cached = nearRunway.get(tile)
  if (cached != null) return cached
  const volume = tile.engineData?.boundingVolume
  if (volume == null || !state.ready) return false
  volume.getSphere(sphere)
  let near = false
  if (sphere.radius <= MAX_TILE_RADIUS) {
    const c = sphere.center
    const g = ecefToGeodetic(c.x, c.y, c.z)
    const mEast = 111_320 * Math.cos((g.lat * Math.PI) / 180)
    for (const end of runwayEndsNear(g.lat, g.lon)) {
      const dn = (g.lat - end.lat) * 111_320
      const de = (g.lon - end.lon) * mEast
      // Distance to the runway's half from this end (both ends are listed).
      const b = (end.bearing * Math.PI) / 180
      const along = dn * Math.cos(b) + de * Math.sin(b)
      const cross = Math.abs(-dn * Math.sin(b) + de * Math.cos(b))
      const outside = Math.max(0, -along, along - end.length / 2)
      if (Math.hypot(outside, cross) < MARGIN + sphere.radius) {
        near = true
        break
      }
    }
  }
  nearRunway.set(tile, near)
  return near
}

export function installAirportDetail(tiles: TilesRenderer): void {
  const target = tiles as unknown as {
    calculateTileViewError: (tile: TileLike, out: { error: number }) => void
    __airportDetail?: boolean
  }
  if (target.__airportDetail === true) return
  target.__airportDetail = true
  const calculate = target.calculateTileViewError.bind(tiles)
  target.calculateTileViewError = (tile, out) => {
    calculate(tile, out)
    if (state.boost !== 1 && isNearRunway(tile)) out.error *= state.boost
  }
}
