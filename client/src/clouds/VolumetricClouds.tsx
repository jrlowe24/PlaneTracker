import { useFrame, useThree } from '@react-three/fiber'
import type { CloudsEffect } from '@takram/three-clouds'
import { Clouds } from '@takram/three-clouds/r3f'
import {
  cloudLayersFromWeather,
  geoidHeight,
  WGS84_A,
  type CloudWeatherSpec
} from '@windowseat/shared'
import { useEffect, useMemo, useRef, type FC } from 'react'
import type { ShaderMaterial, Texture } from 'three'

import { detailedHexes } from '../aircraft/detailState'
import { lightAnchor } from '../aircraft/lightAnchor'
import { smoothingFactor } from '../aircraft/motion'
import { weatherStore } from '../data/weather'
import { cameraModeStore } from '../state/cameraMode'
import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'
import { settingsStore } from '../state/settings'
import { cloudDepth } from './cloudDepth'
import { CoverageTexture, FILTER_WIDTH, GLOBAL_COVERAGE } from './coverageTexture'
import { RegionalCoverageController } from './regionalShader'

/**
 * Above this camera altitude the clouds are skipped: takram's clouds don't
 * support views from space yet (no global coverage), and from orbit they'd
 * only cost frame time.
 */
const MAX_CAMERA_ALTITUDE = 120_000
/**
 * New weather blends in slowly, the way real cloud fields build and thin:
 * fast blends made clouds visibly pop in and dissolve whenever a new sample
 * arrived (e.g. while following an aircraft across weather cells). Layer
 * heights follow a little faster than cover.
 */
const COVER_TIME_CONSTANT = 30
const HEIGHT_TIME_CONSTANT = 60

/** Manual mode: takram's default layer heights at the slider's coverage. */
function manualSpec(coverage: number): CloudWeatherSpec {
  return {
    coverage,
    low: { altitude: 750, height: 650, coverage },
    mid: { altitude: 1000, height: 1200, coverage },
    high: { altitude: 7500, height: 500, coverage: 0.5 }
  }
}

/** Layer parameters the renderer blends toward. */
interface LayerTarget {
  altitude: number
  height: number
  /** 0 … 1, written into the coverage texture channel. */
  coverage: number
}

function layerTargets(spec: CloudWeatherSpec, geoid: number): [LayerTarget, LayerTarget, LayerTarget] {
  return [spec.low, spec.mid, spec.high].map(layer => ({
    altitude: layer.altitude + geoid,
    height: layer.height,
    coverage: layer.coverage
  })) as [LayerTarget, LayerTarget, LayerTarget]
}

/** Per-layer density (takram defaults; cirrus thickens a little with cover). */
const LOW_MID_DENSITY = 0.2
const CIRRUS_DENSITY = 0.004

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
    currentRenderTarget?: { depthVelocity?: Texture | null }
    currentMaterial?: ShaderMaterial
  }
  shadowPass?: { currentMaterial?: ShaderMaterial }
}

export const VolumetricClouds: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const level = useStore(qualityStore, s => s.level)
  const preset = QUALITY_PRESETS[level]
  const coverageTexture = useMemo(() => new CoverageTexture(), [])
  const regional = useMemo(() => new RegionalCoverageController(), [])
  useEffect(
    () => () => {
      coverageTexture.dispose()
      regional.dispose()
    },
    [coverageTexture, regional]
  )

  const ref = useRef<CloudsEffect>(null)
  const initialized = useRef(false)
  const blended = useRef<[number, number, number]>([0, 0, 0])
  // Our own blended layer heights (not read back from the effect, whose
  // layers <Clouds> may reset to defaults).
  const heights = useRef<Array<{ altitude: number; height: number }>>([])

  useFrame((_, delta) => {
    const effect = ref.current
    cloudDepth.texture =
      (effect as CloudsPassInternals | null)?.cloudsPass?.currentRenderTarget?.depthVelocity ?? null
    if (effect == null) return
    effect.skipRendering = camera.position.length() - WGS84_A > MAX_CAMERA_ALTITUDE

    // Temporal upscaling reprojects cloud history from previous frames. An
    // aircraft moving relative to the clouds (followed, taxiing, passing
    // close by) breaks that history at its edges: halos and interlaced
    // stripes across the plane. Whenever an aircraft is on screen at full
    // detail, render clouds without it at half resolution (clean, similar
    // cost); otherwise aircraft are a few pixels and upscaling is kept.
    const closeUp = cameraModeStore.get().mode !== 'globe' || detailedHexes.size > 0
    if (effect.temporalUpscale === closeUp) {
      effect.temporalUpscale = !closeUp
      effect.resolutionScale = closeUp ? 0.5 : 1
    }

    const settings = settingsStore.get()
    const sample = weatherStore.get().sample
    const live = settings.cloudSource === 'weather' && sample != null
    const spec = live ? cloudLayersFromWeather(sample) : manualSpec(settings.cloudCoverage)
    const geoid = live ? geoidHeight(sample.lat, sample.lon) : 0
    const targets = layerTargets(spec, geoid)

    // Blend toward the target (snap on the first frame).
    const dt = Math.min(delta, 0.1)
    const first = !initialized.current
    initialized.current = true
    const kCover = first ? 1 : smoothingFactor(dt, COVER_TIME_CONSTANT)
    const kHeight = first ? 1 : smoothingFactor(dt, HEIGHT_TIME_CONSTANT)
    effect.coverage = GLOBAL_COVERAGE
    const layers = effect.cloudLayers
    const cover = blended.current
    for (let i = 0; i < 3; ++i) {
      const t = targets[i]!
      const h = (heights.current[i] ??= { altitude: t.altitude, height: t.height })
      h.altitude += (t.altitude - h.altitude) * kHeight
      h.height += (t.height - h.height) * kHeight
      cover[i] = cover[i]! + (t.coverage - cover[i]!) * kCover
      const layer = layers[i]
      if (layer == null) continue
      layer.altitude = h.altitude
      layer.height = h.height
    }
    // Static shape parameters are re-applied every frame: <Clouds> resets
    // its layers to takram's defaults after mount.
    for (let i = 0; i < 3; ++i) {
      const layer = layers[i]
      if (layer == null) continue
      layer.weatherExponent = 1
      layer.coverageFilterWidth = FILTER_WIDTH
      layer.shapeAlteringBias = 0.35
      layer.densityScale = i === 2 ? CIRRUS_DENSITY * (0.6 + cover[2]!) : LOW_MID_DENSITY
      layer.shapeAmount = i === 2 ? 0.4 : 1
      layer.shapeDetailAmount = i === 2 ? 0 : 1
      layer.shadow = i < 2 && QUALITY_PRESETS[qualityStore.get().level].cloudShadows
    }
    // Cover per layer: from the regional grid at each sample's position
    // when there is weather data (patched shader), else the blended
    // view-center / manual cover everywhere.
    regional.update(dt, live, lightAnchor, weatherStore.get().grid, [cover[0]!, cover[1]!, cover[2]!])
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
        const passes = effect as unknown as CloudsPassInternals
        for (const material of [passes.cloudsPass?.currentMaterial, passes.shadowPass?.currentMaterial]) {
          if (material != null && !regional.patch(material)) {
            console.warn('[clouds] regional coverage patch did not apply')
          }
        }
      }}
      qualityPreset={preset.clouds}
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
