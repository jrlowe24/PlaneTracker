import { TilesRenderer } from '3d-tiles-renderer'
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins'
import {
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

import { TileNormalsPlugin } from './TileNormalsPlugin'
import { tileStatusStore } from './tileStatus'

/**
 * Google Maps Platform bills Photorealistic 3D Tiles per *root tileset
 * request* (one session, valid for ~3 hours of tile fetches). We therefore
 * create exactly one TilesRenderer per page load and keep it out of React's
 * lifecycle entirely:
 *
 * - React re-renders / StrictMode double effects: the instance lives at
 *   module scope, components only attach/detach it.
 * - Vite HMR: modules may be re-executed, so the instance is stashed on
 *   `globalThis`, which survives hot updates but not a full page reload.
 *
 * `window.__windowSeatTileSessions` counts root sessions created in this page
 * so it can be checked from the console.
 */

const GLOBAL_KEY = Symbol.for('window-seat.google-tiles')

interface TilesGlobal {
  [GLOBAL_KEY]?: TilesRenderer
  __windowSeatTileSessions?: number
}

export interface GoogleTilesOptions {
  apiKey: string
}

export function getGoogleTiles(options: GoogleTilesOptions): TilesRenderer {
  const g = globalThis as TilesGlobal
  const existing = g[GLOBAL_KEY]
  if (existing != null) {
    return existing
  }

  const tiles = new TilesRenderer()
  const auth = new GoogleCloudAuthPlugin({
    apiToken: options.apiKey,
    // Sessions expire after a few hours; the plugin then re-requests the root
    // tileset (one more billable session). See limitSessionRefresh().
    // The Google logo is rendered by our own attribution overlay.
    autoRefreshToken: true
  })
  limitSessionRefresh(auth, tiles)
  tiles.registerPlugin(auth)

  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath(
    'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'
  )
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }))
  // Anisotropy is set from the renderer's capabilities when the tiles are
  // attached to a canvas (see GoogleTilesGlobe), before any tile loads.
  tiles.registerPlugin(new TileNormalsPlugin())
  // Keep mipmaps: they matter for the grazing angles of a window-seat view.
  tiles.registerPlugin(new TileCompressionPlugin({ disableMipmaps: false }))
  tiles.registerPlugin(new UpdateOnChangePlugin())
  // A longer cross-fade turns coarse-to-fine swaps into a blend, not a pop.
  tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 600, maximumFadeOutTiles: 120 }))

  tiles.addEventListener('load-root-tileset', () => {
    const rootLoads = tileStatusStore.get().rootLoads + 1
    g.__windowSeatTileSessions = rootLoads
    tileStatusStore.set({ rootLoads, error: null })
    console.info(`[tiles] root tileset loaded (sessions this page: ${rootLoads})`)
  })
  tiles.addEventListener('load-error', event => {
    const { tile, error, url } = event as unknown as {
      tile: unknown
      error: unknown
      url: unknown
    }
    const message = error instanceof Error ? error.message : String(error)
    // Root failures usually mean a bad / restricted key; keep the first one.
    if (tile == null || tileStatusStore.get().error == null) {
      tileStatusStore.set({ error: message })
    }
    const safeUrl = String(url ?? '').replace(/key=[^&]+/, 'key=…')
    console.error('[tiles] load error', safeUrl, error)
  })

  tuneTileLoading(tiles)

  g[GLOBAL_KEY] = tiles
  if (import.meta.env.DEV) {
    // Handy for debugging from the console: __windowSeatTiles.stats
    ;(globalThis as Record<string, unknown>).__windowSeatTiles = tiles
  }
  return tiles
}

/**
 * Tile loading tuned for what's on screen:
 * - Off-screen siblings are not loaded. The library loads them by default so
 *   panning shows detail sooner, but they compete with (and delay) the
 *   ground in view, and every tile fetched is billed.
 * - Bigger cache: the default (~430 MB) fills on a single low-altitude city
 *   view; once full, refinement stops (tiles in use can't be evicted).
 * The download order itself stays the library's: screen-space error first,
 * which already favors nearby ground. Sorting by distance instead was
 * measured to be worse (it fetched deep tiles that can't show until their
 * ancestors and siblings arrive: ~1.1 GB before anything sharpened).
 */
const TILE_CACHE_BYTES = 800e6

/**
 * Tiles parsed at once. Mesh preparation (de-indexing, normals, skirts) runs
 * in workers, so a parse slot mostly waits; more slots fill a new view
 * faster without loading the main thread.
 */
const PARSE_JOBS = 6

function tuneTileLoading(tiles: TilesRenderer): void {
  tiles.lruCache.maxBytesSize = TILE_CACHE_BYTES
  const queues = tiles as unknown as { parseQueue: { maxJobs: number }; downloadQueue: { maxJobsPerOrigin: number } }
  queues.parseQueue.maxJobs = PARSE_JOBS
  // HTTP/2 to one origin: more concurrent tile requests keep the pipe full.
  queues.downloadQueue.maxJobsPerOrigin = 48
  ;(tiles as unknown as { loadSiblings: boolean }).loadSiblings = false
}

/**
 * GoogleCloudAuth refreshes the session (i.e. re-fetches root.json) after
 * *any* 4xx tile response, including e.g. a 404 for a single tile. A fresh
 * session can't fix those, and each refresh is billed, so only allow a
 * refresh when there is no session yet or the current one is old enough
 * that it may really have expired.
 */
const MIN_SESSION_AGE_BEFORE_REFRESH_MS = 30 * 60 * 1000

function limitSessionRefresh(
  plugin: GoogleCloudAuthPlugin,
  tiles: TilesRenderer
): void {
  const auth = (
    plugin as unknown as {
      auth: {
        sessionToken: string | null
        refreshToken: (options?: RequestInit) => Promise<unknown>
      }
    }
  ).auth
  const refresh = auth.refreshToken.bind(auth)
  let sessionStartedAt = performance.now()
  // The first session comes from the initial root request, not a refresh.
  tiles.addEventListener('load-root-tileset', () => {
    sessionStartedAt = performance.now()
  })

  auth.refreshToken = (requestOptions?: RequestInit) => {
    const now = performance.now()
    if (
      auth.sessionToken != null &&
      now - sessionStartedAt < MIN_SESSION_AGE_BEFORE_REFRESH_MS
    ) {
      return Promise.resolve(null)
    }
    sessionStartedAt = now
    tileStatusStore.set(s => ({ rootLoads: s.rootLoads + 1 }))
    console.info('[tiles] refreshing Google session (new root request)')
    return refresh(requestOptions)
  }
}

/** Returns the instance if it was already created, without creating one. */
export function peekGoogleTiles(): TilesRenderer | undefined {
  return (globalThis as TilesGlobal)[GLOBAL_KEY]
}
