# Window Seat

A live 3D flight tracker with a passenger's-eye view: every aircraft in the
air on a photorealistic globe (Google Photorealistic 3D Tiles), with physically
based atmosphere and real sun position. Pick a plane, follow it, then look
out of its window.

> Status: milestones 1–5 done (globe, data pipeline, motion + chase cam,
> window view + models, volumetric clouds + quality presets). Night city
> lights are proposed below, not built yet.

## Repository layout

```
client/   Vite + React + TypeScript + React Three Fiber app
server/   Node + TypeScript WebSocket server: one upstream poller, replay
shared/   Types, wire protocol, units, geodesy, geoid shared by both
```

pnpm workspaces; Node ≥ 22, pnpm 10.

## Quick start

```sh
pnpm install
cp client/.env.example client/.env   # then add your key, see below
pnpm dev:replay                      # recorded SEA traffic (no adsb.lol calls)
pnpm dev                             # live adsb.lol data
```

The client runs on http://localhost:5173 and proxies `/ws` to the server on
:8787.

| Script                 | What it does                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`             | Client + server, live data from adsb.lol                               |
| `pnpm dev:replay`      | Client + server replaying `server/fixtures/sea.ndjson.gz` on a loop    |
| `pnpm dev:synth`       | Client + server with 12,000 synthetic aircraft worldwide (`SYNTH=n`)   |
| `pnpm record --preset sea` | Record 10 min of live data into a replay fixture (see below)       |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` | Checks and production build |

Use replay (or synth) while developing so we don't hammer adsb.lol.

### Flags

| Variable (file)                         | Meaning                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `VITE_GOOGLE_MAPS_API_KEY` (client/.env) | Google Maps Platform key (Map Tiles API). Without it the app uses the plain ellipsoid.  |
| `VITE_DISABLE_TILES=1` (client/.env)    | Plain WGS84 ellipsoid instead of Google tiles; no Google requests. For non-visual work. |
| `REPLAY=1`, `REPLAY_FILE=fixtures/x.ndjson.gz` (server env) | Replay a recorded fixture in real time, looping.     |
| `SYNTH=<count>` (server env)            | Synthetic worldwide traffic for stress tests.                                            |
| `PORT` (server env)                     | Server port (default 8787).                                                              |
| `ALLOWED_ORIGINS` (server env)           | Comma-separated browser origins allowed to use HTTP/WebSocket APIs; set this in production. |

`client/.env` is gitignored. Never commit keys; only `.env.example` is
tracked.

### Using it

- **Nearby aircraft** (top left): the 40 aircraft closest to what you're
  looking at (or to the plane you're following), with route (e.g.
  `SEA → ATL`), altitude and distance, refreshed every second. Type to search
  callsign, airport (code or city), registration, type or ICAO hex; <kbd>Enter</kbd> follows the first match. Click a row to fly to
  that aircraft and follow it (also works while following another one).
- **Near you**: with location permission (asked once, browser
  geolocation), the list is sorted by distance from you rather than from
  the view, and the server keeps traffic within 100 nm of you live
  wherever the camera is. Without it, the list uses the view center (or
  the followed aircraft).
- **Worldwide search**: the view only receives traffic around the camera,
  so searches also run on the server against the whole world: callsign
  (ICAO form, e.g. `UAE1`, `ASA1`), registration or hex via adsb.fi, and
  ICAO type (`A388`, `B738`) via adsb.lol. Results appear under
  *Worldwide*; clicking one jumps the camera there and follows the
  aircraft as soon as its data arrives (up to 45 s). With nothing in view,
  the list offers busy airports (SEA, LAX, LHR, DXB, …) to jump to.
- Click an aircraft to select it; the panel shows callsign, registration,
  type, altitude (barometric and GNSS), ground speed, vertical rate, track,
  squawk and data age.
- **Follow** (<kbd>F</kbd>): fly to a chase camera behind the aircraft. Drag
  to orbit, scroll/pinch to zoom.
- **Window seat** (<kbd>W</kbd>): sit by a window over the wing; drag for
  limited head movement; <kbd>S</kbd> switches the left/right side.
- <kbd>Esc</kbd> flies back out to the globe (or clears the selection). In
  free look, drag to move across the globe, right-drag or shift-drag to orbit
  and tilt, and use the wheel to zoom. On touch, use two fingers to orbit.

### Dev controls and URL parameters

In dev builds a panel (toggle with <kbd>`</kbd>) offers a **time offset**
slider (±12 h from the real UTC clock) for testing day and night, exposure,
the **interpolation delay**, the flight source/aircraft count and the number
of Google root sessions this page created.

- `?t=-6`: start with a time offset in hours.
- `?weather=clear|fair|overcast`: open a repeatable rendering preset
  (also selectable in Dev controls).
- `?view=lat,lon,heading,pitch,distance[,height]`: initial camera (degrees /
  meters; `height` = target height above the ellipsoid, e.g. ~100 at SEA),
  e.g. `?view=40,-100,0,-90,1.6e7` for a whole-Earth view.
- Console helpers (dev): `__windowSeatBench(frames)` renders frames
  synchronously with a GPU sync and reports ms/frame (works even when the tab
  is throttled); `__windowSeatView(lat, lon, heading, pitch, distance,
  height)` moves the camera without a reload (a reload is a new billable
  tiles session); `__windowSeatFlights`, `__windowSeatStores`,
  `__windowSeatTiles`.

## Flight data

### Source: adsb.lol

Findings (checked October 2026 against the API's OpenAPI spec, its source in
adsblol/api, and live requests) that shape the poller:

- `GET /v2/point/{lat}/{lon}/{radius}`: radius in whole nautical miles,
  **max 250 nm**. Responses are readsb JSON: `alt_baro` (feet or the string
  `"ground"`), `alt_geom` (feet, WGS84 ellipsoid), `gs`, `track`,
  `true_heading`, `baro_rate`/`geom_rate`, `seen_pos`, `t` (type), `r`
  (registration), `flight` (callsign), `category`, `squawk`.
- Responses are cached server-side for 5 s, so polling faster is pointless.
- Rate limits are "dynamic" and unpublished. Measured from one IP: an nginx
  limiter allows a burst of ~2 requests, then about one every 5–10 s.
  Faster requests get `429`.
- A generic `User-Agent` gets `403 "User-Agent too generic; include valid
  contact info"`. We send `window-seat/0.1 (+repo URL)`.
- Data is ODbL; the attribution is shown on screen.

### Server pipeline

```
clients ──viewport──▶ Hub ──merged regions──▶ FlightSource ──▶ AircraftCache
   ▲                   │                        (adsb.lol / replay / synth)
   └──── 1 Hz deltas ◀─┘
```

- Clients send their viewport (center + radius) over the WebSocket.
- `regions.ts` merges all viewports into a few query circles: each viewport
  is snapped to a 0.25° / 25 nm grid (so small camera moves keep the same
  regions), large views become a 7-circle hex cover (max 450 nm radius),
  contained circles are dropped and nearby circles merged when one ≤ 250 nm
  query covers both without fetching much more area.
- `RegionPoller` (the only thing that talks to adsb.lol) keeps one request in
  flight, ≥ 5.5 s apart, adapting the interval upward on 429 (AIMD) and
  backing off exponentially on errors (honoring `Retry-After`). Each region
  is refreshed at most every 5 s; with N regions about every N × interval.
  At most 8 regions are polled.
- `AircraftCache` keeps the latest state per ICAO hex (never replacing a
  newer position with an older one) and drops aircraft unseen for 60 s.
- The `Hub` pushes each client, at 1 Hz, only the aircraft in its own
  viewport that changed since its last push, plus removals.
- Sources implement `FlightSource` (`server/src/sources/types.ts`), so
  OpenSky, airplanes.live (same readsb format; `normalizeReadsb` can be
  reused) or a paid feed can be swapped in. Everything is normalized into
  `AircraftState`; units stay as on the wire (ft, kt, ft/min, degrees) and
  are converted only in `shared/src/units.ts`.

### Worldwide search (`GET /api/search?q=`)

`server/src/search.ts`. Upstream lookups share the existing rate-limited
slots instead of adding traffic: adsb.fi callsign/registration/hex
lookups go first in the follow feed's 1.1 s slot, and adsb.lol type
lookups share the region poller's slots without taking two consecutive
requests while a live region is due. Results also include a
substring match over everything the server already tracks, are cached for
20 s per query, and found aircraft are fed into the cache so they show up
immediately when the camera arrives.

### Followed aircraft: adsb.fi at ~1 Hz

While a client follows an aircraft (chase or window view), the server
polls that aircraft from adsb.fi's open data API
(`opendata.adsb.fi/api/v2/hex/{hex}`, readsb format), one request at a time
≥ 1.1 s apart, round-robin over all followed aircraft
(`server/src/sources/followFeed.ts`). adsb.lol's hex endpoint shares its
per-IP limit, so it can't do this. Measured: new positions every ~1.6 s for
the followed plane vs. 6–10 s from region polling. Everything else stays on
adsb.lol. Only with live data (not replay/synth); `FOLLOW_FEED=0` disables
it. adsb.fi is credited on screen while following. Terms (via a third-party
summary; adsb.fi's own docs weren't reachable): personal, non-commercial
use with attribution and a link.

On the client, each aircraft's interpolation delay adapts to its update
rate (`adaptiveDelayMs`: ~2 update intervals + 2 s, between 2.5 s and the
12 s setting), eased over a few seconds, so a followed aircraft is drawn
~4–5 s behind real time instead of 12 s.

### Routes (origin → destination)

ADS-B carries no origin or destination. The server looks up the scheduled
route for airline-style callsigns (`ASA1305` → LAX–SEA) in vradarserver's
standing data (CC0), as static per-callsign JSON files mirrored by adsb.lol
(`vrs-standing-data.adsb.lol/routes/AS/ASA1305.json`). adsb.lol's batch
`POST /api/0/routeset` returns an empty 201 to anonymous clients (October
2026), so it isn't used. `server/src/routes.ts`: one request at a time
(400 ms apart), cached in memory and in `server/.cache/routes.json` (12 h,
misses 6 h); each client receives a route once per callsign in its view.
Routes are schedules, so the client picks the leg the aircraft is actually
flying from its position and track (`shared/src/routes.ts`; out-and-back
routes like SEA–BLI–SEA resolve by direction) and marks routes whose
position doesn't fit as unverified (`?`). Disable with `ROUTES=0`.

### Replay mode

`pnpm record --preset sea` (or `--preset london`, or `--lat --lon --radius
--minutes --interval`) polls one region for 10 min and writes
`server/fixtures/<name>.ndjson.gz` (gzipped NDJSON: a header line, then one
line per snapshot of wire tuples with original timestamps). `REPLAY=1`
plays it back in real time on a loop, shifting timestamps to "now"; each loop
starts with a reset so clients don't interpolate from the end back to the
start. The committed `sea` fixture covers ~10 min of SEA/BFI/PAE traffic
(58 snapshots; gaps where adsb.lol rate-limited the recording).

### Wire protocol

`shared/src/protocol.ts`: client → `{type:'viewport', viewport}`; server →
`hello` (source + attribution) and `aircraft` messages with `upserts`
(positional tuples, ~3× smaller than objects) and `removals`.

## Rendering aircraft

- **Instancing**: one `InstancedMesh` per airframe class (narrowbody,
  widebody, regional, turboprop, bizjet, helicopter, light, generic), with
  procedural low-poly placeholders. 12,000 synthetic aircraft render at
  ~12–13 ms/frame including tiles and the full post chain (M3 Pro,
  GPU-synchronized benchmark).
- **Precision**: instance matrices are computed in float64 relative to the
  camera; the meshes sit at the camera position, so float32 matrices keep
  millimeter precision up close at ECEF scale (~6.4e6 m). Detailed models use
  three's float64 model-view composition.
- **Icons vs. true size**: aircraft are drawn at their real size up close and
  never smaller than ~18 px (5 px from orbit), so they stay findable.
- **Picking**: aircraft are a few pixels wide, so a click picks the nearest
  projected aircraft within 22 px (32 px touch), skipping aircraft behind the
  Earth. `GlobeControls` raycasts only the ground, never aircraft.
- **Lighting (deliberate choice: mixed lighting)**: tiles are unlit albedo
  lit in post (`AerialPerspective` sunLight/skyLight). Aircraft are lit by
  real light sources (`SunLight` + `SkyLight` placed above the view center or
  the followed aircraft) and masked out of post lighting with
  `LightingMask`; aerial perspective (haze) still applies. This gives
  aircraft specular highlights and lets distant icons glow at night. Because
  three.js lights don't know the Earth's shadow, each aircraft gets a
  sun-visibility factor (terminator + horizon dip at altitude) and a sky-light
  scale, so night-side aircraft are dark except for their marker glow.

## Motion

- **Interpolation buffer**: aircraft are drawn 12 s (dev slider) behind the
  newest data. Between samples a cubic Hermite in a local tangent frame uses
  each sample's reported velocity, so positions and velocities are
  continuous. Past the newest sample: linear extrapolation (vertical only
  4 s), then hold and fade out after 20 s (parked ground traffic holds
  instead). Before the first sample: back-fill along the velocity, so new
  aircraft are already moving. Implausible jumps (>450 m/s) aren't
  interpolated across.
- **Error smoothing**: when late data contradicts the extrapolated path, the
  jump is absorbed into an offset that decays over ~1 s (netcode-style)
  instead of snapping.
- **Attitude from kinematics**: heading = track of the interpolated velocity
  (smoothed); bank = atan(V·ω/g) from the turn rate along the trajectory,
  clamped to ±30°; pitch = flight-path angle + 2.5° angle of attack (faded in
  with speed; 0 on the ground). All smoothed with frame-rate-independent
  time constants.
- **Altitude datum**: Google tiles use WGS84 ellipsoid heights. `alt_geom`
  (readsb: WGS84 ellipsoid) is preferred; baro-only states use the
  aircraft's learned geom−baro offset, else pressure altitude + the EGM96
  geoid (`shared/src/geoid.ts`, 1° grid generated from NGA EGM96 via
  `egm96-universal`, within ~2 m of the full model). On-ground aircraft (and
  low aircraft near the camera) are raycast down onto the tiles; the
  fuselage sits on per-class gear height, blended over touchdown. Verified
  at SEA: an A321neo on final tracks the runway 34L centerline over the
  threshold and settles onto the runway; parked aircraft sit on the ramp.
- **Frame order** (`aircraft/framePriority.ts`): aircraft poses (−3) →
  follow/window camera (−2) → `GlobeControls` (−1) → detailed models (−0.5)
  → tiles + instance matrices (0) → composer (1). The camera always uses the
  pose of the same frame, so there's no jitter.

## Cameras

- **Chase**: orbits the followed aircraft in its heading frame (level, so it
  doesn't roll with the bank). Clip planes follow GlobeControls' scheme.
- **Fly-to**: entering/leaving follow interpolates around the moving target
  (direction slerp + log-distance zoom, easing), turning to face it early.
  Leaving hands the camera back to `GlobeControls` from 12 km out.
- **Window**: rigidly attached to the aircraft body frame (pitches and banks
  with it) at a seat over the wing, looking ~80° off the nose and slightly
  down, ±35°/±20° mouse-look, FOV 60°. A CSS overlay draws the cabin wall,
  the rounded window, an inner shadow and a faint reflection.

## Clouds

- Volumetric clouds from `@takram/three-clouds`, following its
  3DTilesRenderer story: `<Clouds>` sits in the EffectComposer before
  `AerialPerspective`, which composites them (overlay), applies their Beer
  shadow maps to the terrain and their light shafts to the sky
  (`client/src/clouds/VolumetricClouds.tsx`). Layers are takram's defaults
  (cumulus at 750 m and 1,000 m, cirrus at 7,500 m).
- **Live weather** (Open-Meteo, free, no key, CC BY 4.0): the server
  fetches current low/mid/high cloud cover, 2 m temperature and dew point,
  freezing level and ground elevation for the view center (0.25° cells,
  cached 15 min; `server/src/weather.ts`, `WEATHER=0` disables) and sends
  it to the client. `shared/src/weather.ts` maps it to layers: cumulus base
  at the lifting condensation level (125 m per °C of temperature–dew point
  spread above ground; Open-Meteo's `cloud_base` is null), thicker with more
  cover; mid layer from ~3 km above the low tops; cirrus at freezing level
  + 4.5 km (7–11 km). Layer heights blend over about a minute.
- **Geographic cover**: cover varies across the map instead of the whole
  sky following one reading. The server also sends a 7×7 grid of 1° cells
  (~±350 km) of low/mid/high cover around the view (one Open-Meteo
  multi-location request for missing cells, cached 30 min; resent after
  80 km of movement). The client interpolates it into a 64×64 texture over
  ±600 km in a local east/north plane (`client/src/clouds/regionalCoverage.ts`),
  with each cell easing toward new forecasts over ~90 s, and patches
  takram's clouds and cloud-shadow shaders to look up the cover at each
  sample's position (`regionalShader.ts`). Flying from an overcast area
  into a clear one passes through the edge of the cloud field. Without grid
  data (or in manual mode) the view-center / slider cover applies everywhere.
- **Per-layer coverage**: takram has one global coverage for all layers, so
  our coverage texture (`client/src/clouds/coverageTexture.ts`) holds one
  tileable fBm channel per layer (cumulus blobs, broad mid sheets, streaky
  cirrus), rank-transformed to a uniform distribution; the patched shader
  offsets it so exactly the local cover fraction crosses the cloud
  threshold at a fixed global coverage. Layer shapes stay takram's defaults
  (re-applied per frame because `<Clouds>` resets layers after mount).
- The dev panel shows the current cover and can switch to a manual coverage
  slider.
- **Sky vs. stars**: the clouds story draws the sky in post
  (`AerialPerspective sky`) so light shafts reach it, but that replaces the
  `Stars`. We keep `<Sky/>` + `<Stars/>` in the scene and switch
  `AerialPerspective sky` on only while the sun is up (stars aren't visible
  then and there are no light shafts at night).
- Volumetric clouds fade out between 25 and 70 km camera altitude and
  aren't rendered above: they're built from fine noise tiled over the globe,
  which from high up reads as a uniform blanket. Their overlay, shadows and
  light shafts fade with them (skipped rendering otherwise left stale
  buffers composited). The globe view is cloud-free.
- Shape, shape-detail and turbulence textures are self-hosted copies of
  takram's (MIT) in `client/public/clouds/`; the blue-noise (STBN) texture is
  still fetched from takram's GitHub media at runtime.

## Quality presets

`client/src/state/quality.ts`, picker at the bottom right (top right on
phones), `?quality=low|medium|high`, remembered in localStorage.

| Preset | Clouds | Cloud shadows | Light shafts | Lens flare | Tile error target | Max DPR |
| ------ | ------ | ------------- | ------------ | ---------- | ----------------- | ------- |
| Low    | off    | –             | –            | off        | 20 px             | 1       |
| Medium | medium | on            | off          | off        | 12 px             | 1.5     |
| High   | high   | on            | on           | on         | 6 px              | 2       |

**Auto** picks Low on phones/tablets (coarse pointer + small screen; clouds
off), High on Apple silicon and discrete GPUs, Medium otherwise, Low on
software renderers.

### Performance (Apple M3 Pro, Chrome, 1280×800 CSS px window, replay data)

Measured with requestAnimationFrame in headless Chrome on the real GPU
(capped at 60 by vsync):

| View                       | Low | Medium | High  |
| -------------------------- | --- | ------ | ----- |
| Seattle overview, clouds   | 60  | 60     | 47–50 |
| Chase cam through clouds   | –   | –      | 49    |
| Window view                | 60  | **60** | 52    |
| Phone (390×844, auto=Low)  | 60  | –      | –     |

12,000 synthetic aircraft + tiles + post: ~12.7 ms/frame (GPU-synced
benchmark). Profiling at High (2560×1600 px, GPU-synced, by subtraction):
tiles ~5.5 ms, lens flare ~2 ms; the clouds cost is mostly hidden by their
temporal upscaling (turning upscaling off drops Medium window view from 60 to
34 fps, so it stays on). Fixes applied: lens flare only on High, DPR caps and
coarser tile error targets per preset, all deep imports pre-bundled.

## Aircraft models

- `client/src/aircraft/typeClasses.ts` maps ICAO type designators to a class
  (falls back to the ADS-B emitter category, then generic).
- `client/src/aircraft/airframes.ts` builds procedural placeholders per class
  in code (fuselage lathe, swept/tapered/dihedral wings, tail, fin,
  engines/props/rotor, landing gear), in glTF axes: +Z forward, +Y up, +X
  left wing, meters. Distant aircraft use 6-segment versions; the followed
  aircraft and aircraft within 1.5 km use detailed versions with gear (shown
  on the ground and below ~1,500 ft AGL).
- `client/public/models/manifest.json` maps type designators to glTF/GLB
  files in that folder:

  ```json
  { "version": 1, "models": { "A320": { "url": "a320.glb", "scale": 1, "rotationDeg": [0, 0, 0], "offset": [0, 0, 0], "license": "CC-BY-4.0, Author" } } }
  ```

  `classes` adds a fallback model per aircraft class, and `fit`
  (`[length, span]` in meters, as transformed) stretches a model to each
  aircraft's real type dimensions, so one model can cover a family or a
  class. Types with neither use their class placeholder. Loaded models get
  the same lighting patch as the placeholders.

  `liveries` maps an airline's ICAO code (callsign prefix, e.g. `DAL`) to
  a model and wins over type and class models for airliners.

  Currently configured (user-provided Meshy AI Boeing 737-800s, ~1.2 MB
  GLBs, kept out of git): Delta livery for DAL and Endeavor (EDV), Alaska
  livery for ASA and Horizon (QXE) and as the default for all other
  narrowbody, widebody and regional jets, fitted to each type's dimensions.
  Distant aircraft use the same models (instanced), so an airliner is the
  same model however far away it is; placeholders remain only for classes
  without a model.

  **Gap**: every airliner is a 737 in Alaska or Delta livery. Missing:
  other airlines' liveries (shown in Alaska's), widebody and regional jet
  models (a 737 stretched to the type's size), turboprops, business jets,
  general aviation and helicopters (procedural placeholders).

**Model licensing**: only add models you may redistribute (they're served
to every visitor). Check the license (CC-BY needs visible credit; CC-BY-NC
forbids commercial use; many "free" store models forbid redistribution in
apps), keep the license and author in the manifest's `license` field, and add
on-screen or about-page credit where required. Airline liveries and
manufacturer marks can carry trademark restrictions. Placeholders are
generated in code and carry no third-party rights.

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
- Vite pre-bundles all dependencies (`optimizeDeps` in `vite.config.ts`),
  including every deep `three/addons/...` import. Lazy dependency discovery
  would otherwise force a page reload, which means a second session. **When
  adding a deep import, add it to `optimizeDeps.include`.**
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
  18 px height (the guidelines require 16–19 px).
- **adsb.lol**: "Flight data © adsb.lol contributors (ODbL)" with a link is
  shown at all times while adsb.lol (or a replay of it) is the source.
- **adsb.fi**: fast updates for followed aircraft, credited while
  following.
- **Open-Meteo**: weather for the clouds ("Weather: Open-Meteo.com (CC BY
  4.0)" shown while clouds use live weather).
- **Routes**: vradarserver standing data (CC0), served by adsb.lol.
- **EGM96**: geoid data from NGA (public domain), sampled via
  `egm96-universal` (MIT).
- **Stars**: `client/public/atmosphere/stars.bin` comes from takram's
  three-geospatial (MIT).

## Architecture (rendering)

- **Atmosphere** (`client/src/scene`): `@takram/three-atmosphere`.
  `AerialPerspective` lights the tiles using a half-float normal buffer and
  adds sun/sky irradiance, transmittance and inscatter; then `LensFlare`,
  AgX tone mapping, SMAA and dithering. `Sky` and `Stars` render the
  background. The sun and moon follow `getSimulatedDate()` (real UTC plus
  the dev offset).
- **Tiles** (`client/src/globe`): `3d-tiles-renderer` with
  `GoogleCloudAuthPlugin`, `GLTFExtensionsPlugin` (Draco), `TileNormalsPlugin`
  (ours: creased normals computed in a worker pool, because Google tiles have
  no normals; plus anisotropic filtering), `TileCompressionPlugin` (mipmaps
  kept for grazing views), `UpdateOnChangePlugin` and `TilesFadePlugin`.

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
3d-tiles-renderer, so the two are decoupled.

## Night city lights

Google's imagery is daytime only, so city lights come from NASA Black
Marble 2016 (grayscale, 500 m; public domain, credited on screen as
"Night lights: NASA Earth Observatory" whenever it's night in view).

Build the data once (downloads ~150 MB of NASA source tiles into
`client/.night-lights-src/`, writes ~23 MB to `client/public/night-lights/`;
both gitignored). Without it the app runs normally with no city lights:

```bash
pnpm --filter @windowseat/client night-lights
```

Resolution follows distance:

- **Global base** (8192×4096, ~5 km/px) everywhere: what you see from orbit.
- **Detail window** (~610 m/px): 512² tiles of 2.8125° (2,634 non-empty
  worldwide) streamed into a 4096² texture covering ~1,500 km around the
  view whenever the camera is below 600 km (not on Low quality); it
  recenters as you travel, nearest tiles first.
- **Shaped by the imagery** up close: the 600 m map is a soft blob at
  street level, so the effect runs before AerialPerspective on the unlit
  photo texture and classifies each pixel by color: grey mid-dark asphalt
  next to contrasting surfaces (streets) glows, brighter grey (roofs, lots)
  barely, water (dark, bluish) and vegetation (green) never. Brightness
  follows the map (steep curve), varied per ~250 m district. Within
  ~15 m/pixel, street lamps (world-fixed 32 m grid, only on street-like
  surfaces with real texture structure) line the roads; within ~2 m/pixel,
  building facades (normal from depth derivatives) show lit windows on a
  3.2 m grid. Grids are indexed with integer cells anchored on the CPU in
  double precision, so there's no float jitter at ECEF scale.
- From far away (ground pixels of hundreds of meters, coarse tiles) the
  map alone drives the glow, still kept off water.

The emission is handed to AerialPerspective in the alpha channel
(1 − emission/0.1; effect passes clamp alpha to [0, 1]), which adds it to
post-lit terrain only (not aircraft) before atmospheric transmittance and
the cloud overlay, so lights dim through haze and hide behind clouds. Night
exposure adapts up to 4× (moonlight/starlight floor in
`client/src/scene/nightLighting.ts`); stars are drawn brighter than
takram's default. Measured: 60 fps at 1920×1200 (Medium) over Seattle at
night from 2 km.

## Known limitations

- **Coverage**: adsb.lol's free API is per-region (≤ 250 nm) and tightly
  rate-limited, so live data covers what you look at, up to ~450 nm across,
  refreshed every ~6–45 s depending on how many regions are in view. Zoomed
  out to the whole globe you only get the center region. A global feed
  (OpenSky `states/all` with an account, or a paid feed) can be added as a
  `FlightSource`. The 10,000+ aircraft path is exercised with `SYNTH`.
- **Night side**: Google tiles carry daytime imagery only, so at night the
  ground is dark (see the night lights proposal).
- Clouds: takram's temporal upscaling ghosts slightly on moving aircraft;
  the cloud base sits at fixed ellipsoid altitudes (so clouds look low over
  high terrain); no clouds from space; local weather tiling has seams
  (all documented upstream).
- From orbit the sky shows a bluish haze over part of the black space
  background (atmosphere sky rendering; not the lens flare).
- Window view: procedural placeholders have no cabin interior or window
  geometry; the CSS frame hides that. Detailed glTF models with seat
  positions per type would improve it.
- The aerial perspective has a known faint horizon line artifact at some
  angles (documented upstream in takram's README).
- Coarse tiles can be tens of meters off in height until finer tiles load;
  ground raycasts are redone every few seconds, so parked aircraft can settle
  briefly after the camera moves close.
- Parked aircraft without `track`/`true_heading` keep their last heading
  (or north if they never moved).
- `3d-tiles-renderer`'s r3f `GlobeControls` typings declare `ellipsoidFrame`
  as a `Matrix4`, but at runtime it expects an `Object3D`. We pass neither and
  rely on the WGS84 / identity-frame defaults.
