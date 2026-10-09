import { useFrame, useThree } from '@react-three/fiber'
import type { CloudsEffect } from '@takram/three-clouds'
import { CloudLayer, Clouds } from '@takram/three-clouds/r3f'
import { WGS84_A } from '@windowseat/shared'
import { useEffect, useMemo, useRef, type FC } from 'react'

import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'
import { settingsStore } from '../state/settings'
import { createProceduralWeather } from './weather'

/**
 * Above this camera altitude the clouds are skipped: takram's clouds don't
 * support views from space yet (no global coverage), and from orbit they'd
 * only cost frame time.
 */
const MAX_CAMERA_ALTITUDE = 120_000

/**
 * Volumetric clouds (takram three-clouds), following its 3DTilesRenderer
 * story: placed in the EffectComposer before AerialPerspective, which
 * composites them (overlay), applies their shadows to the terrain and their
 * light shafts to the sky. Coverage comes from a CloudWeather provider.
 */
export const VolumetricClouds: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const level = useStore(qualityStore, s => s.level)
  const coverage = useStore(settingsStore, s => s.cloudCoverage)
  const preset = QUALITY_PRESETS[level]
  const weather = useMemo(() => createProceduralWeather(), [])
  useEffect(
    () => () => {
      weather.dispose()
    },
    [weather]
  )

  const ref = useRef<CloudsEffect>(null)
  useEffect(() => {
    ref.current?.localWeatherVelocity.set(weather.velocity[0], weather.velocity[1])
  }, [weather])

  useFrame(() => {
    const effect = ref.current
    if (effect == null) return
    effect.skipRendering = camera.position.length() - WGS84_A > MAX_CAMERA_ALTITUDE
  })

  if (preset.clouds === false) return null
  return (
    <Clouds
      ref={effect => {
        ref.current = effect
      }}
      qualityPreset={preset.clouds}
      coverage={coverage}
      lightShafts={preset.lightShafts}
      localWeatherTexture={weather.localWeatherTexture}
      // Self-hosted copies of takram's textures (MIT); the STBN noise still
      // comes from takram's default URL.
      shapeTexture='/clouds/shape.bin'
      shapeDetailTexture='/clouds/shape_detail.bin'
      turbulenceTexture='/clouds/turbulence.png'
      disableDefaultLayers
    >
      {/* takram's default layers, with shadows controlled by the preset. */}
      <CloudLayer
        channel='r'
        altitude={750}
        height={650}
        densityScale={0.2}
        shapeAmount={1}
        shapeDetailAmount={1}
        weatherExponent={1}
        shapeAlteringBias={0.35}
        coverageFilterWidth={0.6}
        shadow={preset.cloudShadows}
      />
      <CloudLayer
        channel='g'
        altitude={1000}
        height={1200}
        densityScale={0.2}
        shapeAmount={1}
        shapeDetailAmount={1}
        weatherExponent={1}
        shapeAlteringBias={0.35}
        coverageFilterWidth={0.6}
        shadow={preset.cloudShadows}
      />
      <CloudLayer
        channel='b'
        altitude={7500}
        height={500}
        densityScale={0.003}
        shapeAmount={0.4}
        shapeDetailAmount={0}
        coverageFilterWidth={0.5}
      />
    </Clouds>
  )
}
