import type { TilesRenderer } from '3d-tiles-renderer'
import { Sphere, Vector3, type Camera } from 'three'

/**
 * Tile download and parse order. The library's default loads the tile with
 * the highest screen-space error first, wherever it is: consecutive tiles
 * land all over the screen and the view sharpens in a scattered ping-pong.
 * Like Cesium's progressive and foveated loading, this orders by:
 *
 * 1. in use and in view first (as the library);
 * 2. refinement step: how many levels below what's displayed there the tile
 *    is, so every displayed tile's next level comes before any finer one —
 *    the whole view sharpens evenly, a level at a time (sorting by depth
 *    alone held near tiles behind every coarse one on screen, and by
 *    distance alone fetched deep tiles that can't show until their parents
 *    arrive);
 * 3. within a step, nearest the screen center and the camera first, so
 *    detail spreads out from where you look.
 */

interface TileLike {
  priority?: number
  parent?: TileLike | null
  internal?: { depth: number }
  traversal?: { used: boolean; inFrustum: boolean; distanceFromCamera: number }
  engineData?: {
    scene?: unknown
    boundingVolume?: { getSphere: (target: Sphere) => Sphere }
  }
}

/** Weight of the angle off the view direction against distance. */
const FOVEATION = 3

const view = { position: new Vector3(), direction: new Vector3(0, 0, -1), frame: 0 }
const sphere = new Sphere()
const toTile = new Vector3()
const scores = new WeakMap<TileLike, { frame: number; step: number; score: number }>()

/** Levels between this tile and its nearest ancestor with content shown (0 for the root). */
function refinementStep(tile: TileLike): number {
  let step = 0
  let parent = tile.parent
  while (parent != null) {
    step += 1
    if (parent.engineData?.scene != null) return step
    parent = parent.parent
  }
  return step
}

function scoreOf(tile: TileLike): { step: number; score: number } {
  const cached = scores.get(tile)
  if (cached != null && cached.frame === view.frame) return cached
  let score = tile.traversal?.distanceFromCamera ?? Infinity
  const volume = tile.engineData?.boundingVolume
  if (volume != null) {
    volume.getSphere(sphere)
    toTile.subVectors(sphere.center, view.position)
    const distance = Math.max(0, toTile.length() - sphere.radius)
    const off = toTile.lengthSq() > 0 ? 1 - toTile.normalize().dot(view.direction) : 0
    score = distance * (1 + FOVEATION * Math.max(0, off))
  }
  const entry = { frame: view.frame, step: refinementStep(tile), score }
  scores.set(tile, entry)
  return entry
}

/** Returning 1 means "a" loads first (the library's convention). */
function priority(a: TileLike, b: TileLike): number {
  const ap = a.priority ?? 0
  const bp = b.priority ?? 0
  if (ap !== bp) return ap > bp ? 1 : -1
  const at = a.traversal
  const bt = b.traversal
  if (at == null || bt == null) return 0
  if (at.used !== bt.used) return at.used ? 1 : -1
  if (at.inFrustum !== bt.inFrustum) return at.inFrustum ? 1 : -1
  const as = scoreOf(a)
  const bs = scoreOf(b)
  if (as.step !== bs.step) return as.step < bs.step ? 1 : -1
  if (as.score !== bs.score) return as.score < bs.score ? 1 : -1
  return 0
}

type Queues = {
  downloadQueue: { priorityCallback: typeof priority }
  parseQueue: { priorityCallback: typeof priority }
}
let libraryOrder: { download: typeof priority; parse: typeof priority } | null = null

/** Installs the load order on the renderer's queues (false: the library's own). */
export function setLoadOrder(tiles: TilesRenderer, enabled: boolean): void {
  const queues = tiles as unknown as Queues
  libraryOrder ??= { download: queues.downloadQueue.priorityCallback, parse: queues.parseQueue.priorityCallback }
  queues.downloadQueue.priorityCallback = enabled ? priority : libraryOrder.download
  queues.parseQueue.priorityCallback = enabled ? priority : libraryOrder.parse
}

/** The main view's camera, for the order (call every frame). */
export function updateLoadOrderView(camera: Camera): void {
  camera.getWorldPosition(view.position)
  camera.getWorldDirection(view.direction)
  view.frame += 1
}
