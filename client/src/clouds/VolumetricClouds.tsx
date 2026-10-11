import { useFrame, useThree } from '@react-three/fiber'
import type { CloudsEffect } from '@takram/three-clouds'
import { Clouds } from '@takram/three-clouds/r3f'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import {
  cloudLayersFromWeather,
  ecefToGeodetic,
  geoidHeight,
  type CloudWeatherSpec
} from '@windowseat/shared'
import { useContext, useEffect, useMemo, useRef, type FC } from 'react'
import { Quaternion, Vector3, type ShaderMaterial, type Texture } from 'three'

import { lightAnchor } from '../aircraft/lightAnchor'
import { smoothingFactor } from '../aircraft/motion'
import { weatherStore } from '../data/weather'
import { nightEmission } from '../nightLights/nightLightsStore'
import { useStore } from '../state/createStore'
import { qualityStore } from '../state/quality'
import { settingsStore } from '../state/settings'
import { nightState } from '../scene/nightLighting'
import { cloudCoverStore } from './cloudCoverStore'
import { cloudDepth } from './cloudDepth'
import { CoverageTexture, FILTER_WIDTH, GLOBAL_COVERAGE } from './coverageTexture'
import { marchRefine, patchCloudsMarch } from './marchShader'
import { installNightClouds, patchNightClouds } from './nightClouds'
import { patchCloudsResolve, RegionalCoverageController } from './regionalShader'

/**
 * Volumetric clouds fade out between these camera altitudes and aren't
 * rendered above: they're built from a fine noise texture tiled over the
 * globe, which from high up reads as a uniform blanket of repeating blobs
 * (and takram's clouds don't support views from space).
 */
const FADE_START_ALTITUDE = 25_000
const FADE_END_ALTITUDE = 70_000
const SHADOW_MAX_FAR = 40_000
const SHAFT_STEPS = 120
const SHAFT_STEP_M = 150
/** Cloud resolution on dark nights, relative to the preset's. */
const NIGHT_RESOLUTION = 0.7
/** Moonlight (nightState.moon) above which night clouds keep full resolution. */
const MOONLIT = 0.003

/**
 * Drops the clouds' temporal history after a camera cut or a resolution
 * change: blending the stale history made the first moments after a cut a
 * smear of the previous view's clouds. A cut is a jump of over 2 km (search
 * jump) or a sudden turn of over 15° in one frame (window seat, switching
 * sides): the window cut only moves the camera ~100 m.
 */
const CUT_COS = Math.cos((15 * Math.PI) / 180)

class CloudHistoryReset {
  private readonly last = new Vector3()
  private readonly lastQuaternion = new Quaternion()
  private hasQuaternion = false
  private lastWidth = 0
  private framesLeft = 0
  private defaultAlpha: number | null = null

  update(effect: CloudsEffect, position: Vector3, quaternion: Quaternion): void {
    const pass = (effect as unknown as CloudsPassInternals).cloudsPass
    const alpha = pass?.resolveMaterial?.uniforms.temporalAlpha as { value: number } | undefined
    const width = pass?.currentRenderTarget?.width ?? 0
    if (alpha == null) return
    this.defaultAlpha ??= alpha.value
    // |q1·q2| = cos(θ/2) for a rotation θ between the orientations.
    const turned = this.hasQuaternion && Math.abs(quaternion.dot(this.lastQuaternion)) < Math.sqrt((1 + CUT_COS) / 2)
    const cut = (this.last.lengthSq() > 0 && position.distanceTo(this.last) > 2000) || turned
    this.lastQuaternion.copy(quaternion)
    this.hasQuaternion = true
    if (cut || width !== this.lastWidth) this.framesLeft = 8
    this.last.copy(position)
    this.lastWidth = width
    alpha.value = this.framesLeft > 0 ? 1 : this.defaultAlpha
    if (this.framesLeft > 0) --this.framesLeft
  }
}
/**
 * New weather blends in slowly, the way real cloud fields build and thin:
 * fast blends made clouds visibly pop in and dissolve whenever a new sample
 * arrived (e.g. while following an aircraft across weather cells). Layer
 * heights follow a little faster than cover.
 */
const COVER_TIME_CONSTANT = 30
const HEIGHT_TIME_CONSTANT = 60
/** After you pick a weather, it settles in a few seconds instead. */
const CHOSEN_TIME_CONSTANT = 1.5
const CHOSEN_DURATION = 8

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Manual mode: takram's default layer heights at the slider's coverage. */
/**
 * Chosen weather instead of the live forecast (0 clear … 1 overcast):
 * cumulus first, a mid-level deck building in past half cover, and some
 * cirrus that thickens with it.
 */
function manualSpec(coverage: number): CloudWeatherSpec {
  const c = Math.min(1, Math.max(0, coverage))
  const deck = smoothstep(0.55, 0.9, c)
  return {
    coverage: c,
    low: { altitude: 900, height: (1000 + 1200 * c) * (1 - deck) + 950 * deck, coverage: c },
    mid: { altitude: 3600, height: 1500, coverage: Math.max(0, (c - 0.45) * 1.6) },
    high: { altitude: 8000, height: 500, coverage: c === 0 ? 0 : 0.15 + 0.4 * c },
    convective: { altitude: 900, height: 0, coverage: 0 }
  }
}

/** Layer parameters the renderer blends toward. */
interface LayerTarget {
  altitude: number
  height: number
  /** 0 … 1, written into the coverage texture channel. */
  coverage: number
}

function layerTargets(spec: CloudWeatherSpec, geoid: number): LayerTarget[] {
  return [spec.low, spec.mid, spec.high, spec.convective].map(layer => ({
    altitude: layer.altitude + geoid,
    height: layer.height,
    coverage: layer.coverage
  }))
}

/** Per-layer density (takram defaults; cirrus thickens a little with cover). */
const LOW_MID_DENSITY = 0.2
const CIRRUS_DENSITY = 0.004
/** Towering cumulus / cumulonimbus: denser than fair-weather cumulus. */
const CONVECTIVE_DENSITY = 0.3
const CONVECTIVE_ENABLED = false

/**
 * Volumetric clouds (takram three-clouds), following its 3DTilesRenderer
 * story: placed in the EffectComposer before AerialPerspective, which
 * composites them (overlay), applies their shadows to the terrain and their
 * light shafts to the sky.
 *
 * Layer heights and amounts come from the current weather at the view
 * center (Open-Meteo via the server: low/mid/high cloud cover, cumulus base
 * from the temperature–dew point spread), blended smoothly as data or the
 * view changes. The cover of each layer is baked into a per-layer coverage
 * texture (see coverageTexture.ts). A dev toggle switches to manual
 * coverage.
 */
interface CloudsPassInternals {
  cloudsPass?: {
    currentRenderTarget?: { depthVelocity?: Texture | null; width?: number }
    currentMaterial?: ShaderMaterial
    resolveMaterial?: ShaderMaterial
  }
  shadowPass?: { currentMaterial?: ShaderMaterial }
}

export const VolumetricClouds: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const gl = useThree(({ gl }) => gl)
  const { transientStates } = useContext(AtmosphereContext)
  const preset = useStore(qualityStore, s => s.settings)
  const coverageTexture = useMemo(() => new CoverageTexture(), [])
  const regional = useMemo(() => new RegionalCoverageController(), [])
  const historyReset = useMemo(() => new CloudHistoryReset(), [])
  useEffect(
    () => () => {
      coverageTexture.dispose()
      regional.dispose()
    },
    [coverageTexture, regional]
  )

  const ref = useRef<CloudsEffect>(null)
  const initialized = useRef(false)
  const blended = useRef<[number, number, number, number]>([0, 0, 0, 0])
  // Our own blended layer heights (not read back from the effect, whose
  // layers <Clouds> may reset to defaults).
  const heights = useRef<Array<{ altitude: number; height: number }>>([])
  const sinceDisplay = useRef(0)
  // Weather choice last frame, and how long the quick blend still runs.
  const lastChoice = useRef('')
  const quickBlend = useRef(0)
  const dark = useRef(false)

  useFrame(({ gl }, delta) => {
    const effect = ref.current
    cloudDepth.texture =
      (effect as CloudsPassInternals | null)?.cloudsPass?.currentRenderTarget?.depthVelocity ?? null
    if (effect == null) {
      cloudDepth.baseAltitude = 0
      cloudDepth.slabs = []
      return
    }
    const altitude = ecefToGeodetic(camera.position.x, camera.position.y, camera.position.z).height
    const t = Math.min(1, Math.max(0, (altitude - FADE_START_ALTITUDE) / (FADE_END_ALTITUDE - FADE_START_ALTITUDE)))
    cloudDepth.fade = 1 - t * t * (3 - 2 * t)
    // Never skip rendering: toggling it adds/removes the clouds' shadow data,
    // which recompiles the atmosphere's effect pass (a ~90 ms hitch while
    // descending through ~70 km). Faded out, render at a tiny resolution
    // instead (invisible: overlay, shadows and shafts are multiplied by the
    // fade), which costs next to nothing.
    effect.skipRendering = false
    historyReset.update(effect, camera.position, camera.quaternion)
    // On dark nights the clouds only show as dim starlight and city glow:
    // render them coarser (hysteresis so dusk doesn't reallocate back and forth).
    if (!dark.current && nightState.night > 0.95) dark.current = true
    else if (dark.current && nightState.night < 0.75) dark.current = false
    // Moonlit clouds show their shape and edges again: full resolution.
    const coarse = dark.current && nightState.moon < MOONLIT
    // A fraction of CSS pixels, whatever the device pixel ratio.
    const resolution = Math.min(1, (qualityStore.get().settings.cloudResolution * (coarse ? NIGHT_RESOLUTION : 1)) / gl.getPixelRatio())
    const scale = cloudDepth.fade > 0 ? resolution : 0.1
    if (effect.resolutionScale !== scale) effect.resolutionScale = scale

    const settings = settingsStore.get()
    const sample = weatherStore.get().sample
    const live = settings.cloudSource === 'weather' && sample != null
    const spec = live ? cloudLayersFromWeather(sample) : manualSpec(settings.cloudCoverage)
    // Cover at the view center comes from the blended grid when there is
    // one (the same field the shader uses everywhere), not the single
    // nearest reading, which jumps between cells.
    const gridCover = live ? regional.coverAtPoint(lightAnchor) : null
    if (gridCover != null) {
      spec.low = { ...spec.low, coverage: gridCover.low }
      spec.mid = { ...spec.mid, coverage: gridCover.mid }
      spec.high = { ...spec.high, coverage: gridCover.high }
      spec.convective = { ...spec.convective, coverage: gridCover.conv }
    }
    const geoid = live ? geoidHeight(sample.lat, sample.lon) : 0
    const targets = layerTargets(spec, geoid)

    // Blend toward the target (snap on the first frame).
    const dt = Math.min(delta, 0.1)
    const first = !initialized.current
    initialized.current = true
    const choice = `${settings.cloudSource}:${settings.cloudCoverage}`
    if (choice !== lastChoice.current) {
      if (lastChoice.current !== '') quickBlend.current = CHOSEN_DURATION
      lastChoice.current = choice
    }
    quickBlend.current = Math.max(0, quickBlend.current - dt)
    const quick = quickBlend.current > 0
    const kCover = first ? 1 : smoothingFactor(dt, quick ? CHOSEN_TIME_CONSTANT : COVER_TIME_CONSTANT)
    const kHeight = first ? 1 : smoothingFactor(dt, quick ? CHOSEN_TIME_CONSTANT : HEIGHT_TIME_CONSTANT)
    effect.coverage = GLOBAL_COVERAGE
    const layers = effect.cloudLayers
    const cover = blended.current
    const maxCover = live ? regional.maxCover() : null
    for (let i = 0; i < 4; ++i) {
      const t = targets[i]!
      const h = (heights.current[i] ??= { altitude: t.altitude, height: t.height })
      h.altitude += (t.altitude - h.altitude) * kHeight
      h.height += (t.height - h.height) * kHeight
      cover[i] = cover[i]! + (t.coverage - cover[i]!) * kCover
      const layer = layers[i]
      if (layer == null) continue
      layer.altitude = h.altitude
      // An empty layer (no towers forecast) costs no ray marching.
      // Convective towers are disabled until their shapes are finished
      // (work in progress on branch wip-storm-clouds).
      // Nor does a layer with no cloud anywhere: clear sky marched every
      // ray through the empty shell (~10 ms, more than a cloudy sky, whose
      // rays stop early in cloud).
      const most = i === 3 ? (maxCover?.conv ?? cover[3]!) : (maxCover?.[(['low', 'mid', 'high'] as const)[i]!] ?? cover[i]!)
      const empty = Math.max(most, cover[i]!) < 0.005
      layer.height = empty || (i === 3 && !CONVECTIVE_ENABLED) ? 0 : h.height
    }
    // Lowest layer with cloud: where city light meets the cloud base
    // (night lights' cloud underglow).
    const base = [0, 1].find(i => cover[i]! > 0.02 && (layers[i]?.height ?? 0) > 0)
    cloudDepth.baseAltitude = base == null ? 0 : heights.current[base]!.altitude
    cloudDepth.slabs = [0, 1, 2]
      .filter(i => cover[i]! > 0.02 && (layers[i]?.height ?? 0) > 0)
      .map(i => ({
        bottom: heights.current[i]!.altitude,
        top: heights.current[i]!.altitude + heights.current[i]!.height,
        opacity: cover[i]!,
        layer: i
      }))
    cloudDepth.coverAt = live
      ? point => {
          const c = regional.coverAtPoint(point)
          return c == null ? null : [c.low, c.mid, c.high]
        }
      : null
    // Static shape parameters are re-applied every frame: <Clouds> resets
    // its layers to takram's defaults after mount.
    const shadows = qualityStore.get().settings.cloudShadows
    for (let i = 0; i < 4; ++i) {
      const layer = layers[i]
      if (layer == null) continue
      layer.weatherExponent = 1
      layer.coverageFilterWidth = FILTER_WIDTH
      // Keep the cloud profile independent of camera location. The shader
      // uses each sample's local weather coverage to flatten dense low-cloud
      // regions into a connected deck while preserving billows in broken areas.
      const deck = i === 0
        ? smoothstep(0.38, 0.72, cover[i]!)
        : i === 1
          ? smoothstep(0.4, 0.78, cover[i]!)
          : 0
      layer.shapeAlteringBias = i === 3 ? 0.6 : 0.35
      layer.densityScale =
        i === 2 ? CIRRUS_DENSITY * (0.6 + cover[2]!) : i === 3 ? CONVECTIVE_DENSITY : LOW_MID_DENSITY
      layer.shapeAmount = i === 2 ? 0.4 : 1
      layer.shapeDetailAmount = i === 2 ? 0 : i === 0 ? 0.25 : 1
      layer.densityProfile.set(0, 0, 0.75, 0.25)
      // Dense mid-level decks were producing a hard blue self-shadow rim.
      // Keep their shadows while broken, but let a near-overcast deck scatter
      // light without feeding its own coarse shadow map back into the edges.
      layer.shadow = shadows && (i === 0 || (i === 1 && deck < 0.6))
    }
    // Widen the low-frequency Perlin-Worley body scale (one repeat per 20 km)
    // so high-coverage low decks form broad masses instead of many equal puffs.
    // The separate detail texture still breaks up their low-density edges.
    effect.shapeRepeat.setScalar(0.00005)
    // Light shafts: fewer, longer steps (120 × 150 m+, growing) than
    // takram's 500 × 50 m. The shafts' march was ~15% of the frame at High
    // for rays that only show near sunrise and sunset.
    effect.clouds.maxShadowLengthIterationCount = SHAFT_STEPS
    effect.clouds.minShadowLengthStepSize = SHAFT_STEP_M
    // Cover per layer: from the regional grid at each sample's position
    // when there is weather data (patched shader), else the blended
    // view-center / manual cover everywhere.
    regional.update(dt, live, lightAnchor, weatherStore.get().grid, [cover[0]!, cover[1]!, cover[2]!, cover[3]!])
    sinceDisplay.current += dt
    if (sinceDisplay.current > 0.5) {
      sinceDisplay.current = 0
      cloudCoverStore.set({ low: cover[0]!, mid: cover[1]!, high: cover[2]!, conv: cover[3]!, regional: gridCover != null })
    }
  })

  if (preset.clouds === false) return null
  return (
    <Clouds
      ref={effect => {
        ref.current = effect
        if (effect == null) {
          initialized.current = false
          return
        }
        // Slow drift of the coverage pattern (wind).
        effect.localWeatherVelocity.set(0.00002, 0.000005)
        // The library's default powder term darkens very thin cloud samples
        // strongly. At sunset this reads as a blue shadow around sunlit wisps.
        effect.powderScale = 0.28
        effect.powderExponent = 100
        // Cloud shadow cascades span 40 km, not the whole view (180 km+):
        // spread over the far plane, the far cascades were ~200 m per texel
        // and painted blocky smudges over distant terrain and aircraft.
        effect.shadow.maxFar = SHADOW_MAX_FAR
        effect.shadow.splitLambda = 0.8
        if (qualityStore.get().settings.clouds === 'high') {
          effect.shadow.mapSize.set(1024, 1024)
        }
        const passes = effect as unknown as CloudsPassInternals
        for (const material of [passes.cloudsPass?.currentMaterial, passes.shadowPass?.currentMaterial]) {
          if (material != null && !regional.patch(material)) {
            console.warn('[clouds] regional coverage patch did not apply')
          }
        }
        const march = passes.cloudsPass?.currentMaterial
        if (march != null && !patchCloudsMarch(march)) {
          console.warn('[clouds] march refinement patch did not apply')
        }
        if (march != null && !patchNightClouds(march)) {
          console.warn('[clouds] night light patch did not apply')
        }
        installNightClouds(effect, camera, () => transientStates?.moonDirection ?? null, () => nightEmission.baseMap)
        if (import.meta.env.DEV) (window as { __cloudMarchRefine?: typeof marchRefine }).__cloudMarchRefine = marchRefine
        const resolve = passes.cloudsPass?.resolveMaterial
        if (resolve != null && !patchCloudsResolve(resolve)) {
          console.warn('[clouds] NaN guard patch did not apply')
        }
      }}
      qualityPreset={preset.clouds}
      // No temporal upscaling. It marches 1 pixel in 16 per frame and
      // rebuilds the rest from history: cloud edges never settle (jitter in
      // motion), and the clouds' depth buffer that keeps cloud off aircraft
      // in front of it only updates per 4x4 block, striping aircraft seen
      // against cloud. Half resolution, plain temporal accumulation: stable,
      // ~2.7 ms more. (patchCloudsResolve still fixes the upscaled path.)
      temporalUpscale={false}
      resolutionScale={Math.min(1, preset.cloudResolution / gl.getPixelRatio())}
      lightShafts={preset.lightShafts}
      localWeatherTexture={coverageTexture.texture}
      // Self-hosted copies of takram's textures (MIT); the STBN noise still
      // comes from takram's default URL.
      shapeTexture='/clouds/shape.bin'
      shapeDetailTexture='/clouds/shape_detail.bin'
      turbulenceTexture='/clouds/turbulence.png'
    />
  )
}
