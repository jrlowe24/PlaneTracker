# Window Seat

A live 3D flight tracker with a passenger's-eye view: every aircraft in the
air on a photorealistic globe (Google Photorealistic 3D Tiles), with physically
based atmosphere, real sun position and, later, volumetric clouds. Pick a
plane, follow it, then look out of its window.

> Status: **milestone 1** (scaffold + globe). Flight data, motion, window view
> and clouds come in later milestones.

## Repository layout

```
client/   Vite + React + TypeScript + React Three Fiber app
server/   Node + TypeScript WebSocket server for flight data (stub for now)
shared/   Types and unit conversions shared by client and server
```

pnpm workspaces; Node ≥ 22, pnpm 10.

## Quick start

```sh
pnpm install
cp client/.env.example client/.env   # then add your key, see below
pnpm dev                             # client on :5173, server on :8787
```

Other scripts (from the repo root): `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm build`, `pnpm dev:client`, `pnpm dev:server`.

### Flags (client/.env)

| Variable                   | Meaning                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `VITE_GOOGLE_MAPS_API_KEY` | Google Maps Platform key (Map Tiles API). Without it the app falls back to the plain ellipsoid.     |
| `VITE_DISABLE_TILES=1`     | Use a plain WGS84 ellipsoid instead of Google tiles. No Google requests are made. Use it for non-visual work. |

`client/.env` is gitignored. Never commit keys; only `.env.example` is
tracked.

### Dev controls and URL parameters

In dev builds a panel (toggle with <kbd>`</kbd>) offers a **time offset**
slider (±12 h from the real UTC clock) for testing day and night, an
exposure slider, and the number of Google root sessions this page created.

- `?t=-6`: start with a time offset in hours.
- `?view=lat,lon,heading,pitch,distance`: initial camera (degrees / meters),
  e.g. `?view=40,-100,0,-90,1.6e7` for a whole-Earth view.

## Google Cloud setup

1. Create (or pick) a Google Cloud project with billing enabled.
2. **Enable the Map Tiles API**: *APIs & Services → Library → "Map Tiles
   API" → Enable*.
3. **Create an API key**: *APIs & Services → Credentials → Create
   credentials → API key*.
4. **Restrict the key** (*Edit API key*):
   - *Application restrictions → Websites (HTTP referrers)*: add your dev and
     production origins, e.g. `http://localhost:5173/*`,
     `http://127.0.0.1:5173/*`, `https://your-domain.example/*`.
   - *API restrictions → Restrict key → Map Tiles API* only.
   A browser key is always visible to users (it ships in the JS bundle), so
   these restrictions are what actually protect it.
5. **Cap the daily quota**: *APIs & Services → Map Tiles API → Quotas &
   System Limits*. Lower the per-day request limits, especially the 3D Tiles
   root/session requests, which are the billed unit, to what you are happy
   to pay for. Also add a billing budget alert.
6. Put the key in `client/.env` as `VITE_GOOGLE_MAPS_API_KEY=...`.

### Cost hygiene

Photorealistic 3D Tiles are billed per **root tileset request**. A root
request starts a session that covers roughly 3 hours of tile fetches. The
client is built to make exactly one per page load:

- The `TilesRenderer` is created once per page, outside React's lifecycle
  (`client/src/globe/googleTiles.ts`), and stashed on `globalThis`. React
  re-renders, StrictMode double effects and Vite HMR reuse it.
- Vite pre-bundles all dependencies (`optimizeDeps` in `vite.config.ts`).
  Lazy dependency discovery would otherwise force a page reload, which means
  a second session.
- The auth plugin's "refresh session on any 4xx" behavior is limited to
  sessions older than 30 minutes, so a missing tile can't trigger repeated
  billable root requests.
- `VITE_DISABLE_TILES=1` avoids Google entirely.
- Tiles go straight from the browser to Google. They are never proxied or
  cached by our server, and the browser honors Google's cache headers.

The dev panel and the console (`[tiles] root tileset loaded (sessions this
page: N)`) show how many sessions the page has created.

## Data attribution

- **Google**: the Google logo and the copyright strings of all visible tiles
  (from each tile's `asset.copyright`, aggregated and sorted by frequency)
  are shown at the bottom left at all times, per the
  [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies).
  The logo (`client/public/attribution/google.png`) is shown unmodified at
  18 px height (the guidelines require 16–19 px). It comes from the
  3DTilesRendererJS examples. Swap in the official asset from Google's
  attribution asset bundle if you prefer.
- **adsb.lol** (milestone 2): flight data from [adsb.lol](https://adsb.lol),
  ODbL-licensed. It will be credited on screen.
- **Stars**: `client/public/atmosphere/stars.bin` comes from takram's
  three-geospatial (MIT).

## Architecture (so far)

- **Rendering** (`client/src/scene`): `@takram/three-atmosphere` in
  *post-process lighting* mode. Google tiles are unlit (albedo).
  `AerialPerspective` lights them using a half-float normal buffer and adds
  sun/sky irradiance, transmittance and inscatter. Then come `LensFlare`,
  AgX tone mapping, SMAA and dithering. `Sky` and `Stars` render the
  background. The sun and moon come from `getSimulatedDate()` (real UTC plus
  the dev offset) every frame.
- **Tiles** (`client/src/globe`): `3d-tiles-renderer` with
  `GoogleCloudAuthPlugin`, `GLTFExtensionsPlugin` (Draco), `TileNormalsPlugin`
  (ours: creased normals computed in a worker pool, because Google tiles have
  no normals; plus anisotropic filtering), `TileCompressionPlugin` (mipmaps
  kept for grazing views), `UpdateOnChangePlugin` and `TilesFadePlugin`.
- **Controls**: `GlobeControls` raycasts only against the ground object
  (tiles or ellipsoid), so aircraft never steal camera input.
- **Frame order**: controls (`useFrame` priority −1), then tiles update (0),
  then the effect composer render (1).

### Pinned versions

The takram packages are beta and 3d-tiles-renderer moves fast, so versions
are pinned exactly. The set matches the one takram's own repo is built and
tested against (three 0.184.0, R3F 9.6.1, drei 10.7.7,
@react-three/postprocessing 3.0.4, postprocessing 6.39.1, React 19.2.6).
`.npmrc` sets `strict-peer-dependencies=true`, so peer conflicts fail the
install instead of being forced.

| Package                    | Version |
| -------------------------- | ------- |
| `@takram/three-atmosphere` | 0.19.1  |
| `@takram/three-clouds`     | 0.7.6   |
| `@takram/three-geospatial` | 0.9.1   |
| `3d-tiles-renderer`        | 0.5.3   |
| `three`                    | 0.184.0 |

takram's storybook still pins `3d-tiles-renderer` 0.4.24. We use 0.5.3 for
its traversal and fade fixes. Its published packages don't import
3d-tiles-renderer, so the two are decoupled. Google tiles with the atmosphere
were verified in a browser with 0.5.3.

## Known limitations

- Night side: Google tiles carry daytime imagery only, so at night the ground
  is dark. Night lights (NASA Black Marble) are planned as an emissive layer.
- The atmosphere's aerial perspective has a known faint horizon line artifact
  at some angles (documented upstream in takram's README).
- `3d-tiles-renderer`'s r3f `GlobeControls` typings declare `ellipsoidFrame`
  as a `Matrix4`, but at runtime it expects an `Object3D`. We pass neither and
  rely on the WGS84 / identity-frame defaults.
