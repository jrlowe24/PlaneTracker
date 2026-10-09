import { useFrame, useThree } from '@react-three/fiber'
import { SMAA, ToneMapping } from '@react-three/postprocessing'
import type { AerialPerspectiveEffect, LightingMaskPass } from '@takram/three-atmosphere'
import {
  AerialPerspective,
  AtmosphereContext,
  LightingMask
} from '@takram/three-atmosphere/r3f'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import {
  EffectMaterial,
  ToneMappingMode,
  type EffectComposer as EffectComposerImpl
} from 'postprocessing'
import { useContext, useEffect, useRef, useState, type FC } from 'react'
import { Uniform, Vector3 } from 'three'

import { AIRCRAFT_LAYER } from '../aircraft/layers'
import { VolumetricClouds } from '../clouds/VolumetricClouds'
import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'
import { settingsStore } from '../state/settings'
import { EffectComposer } from './EffectComposer'
import { nightState, updateNightLighting } from './nightLighting'

/**
 * Adds night light to takram's AerialPerspective: ambient irradiance
 * (moonlight + starlight) on lit surfaces and a faint glow behind the
 * stars. Patched into its shader once; values come from nightState.
 */
function patchNightLight(effect: AerialPerspectiveEffect): void {
  const marker = '/* window-seat night light */'
  const source = effect.getFragmentShader()
  if (source == null || source.includes(marker)) return
  const shader = source
    .replace(
      'void mainImage(',
      `${marker}\nuniform vec3 nightAmbient;\nuniform vec3 nightSky;\nvoid mainImage(`
    )
    .replace(
      'radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);',
      'radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);\n    radiance += inputColor.rgb * albedoScale * RECIPROCAL_PI * nightAmbient;'
    )
    .replace(
      '#else // SKY\n    outputColor = inputColor;',
      '#else // SKY\n    outputColor = inputColor;\n    outputColor.rgb += nightSky;'
    )
  if ((shader.match(/nightAmbient|nightSky/g) ?? []).length < 4) {
    // takram's shader changed: night light only partly applied.
    console.warn('[night] AerialPerspective shader patch did not fully apply')
  }
  effect.uniforms.set('nightAmbient', new Uniform(nightState.ambient))
  effect.uniforms.set('nightSky', new Uniform(nightState.sky))
  ;(effect as unknown as { setFragmentShader: (s: string) => void }).setFragmentShader(shader)
}

const up = new Vector3()

export const PostEffects: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const { transientStates } = useContext(AtmosphereContext)
  const cloudsEnabled = useStore(qualityStore, s => QUALITY_PRESETS[s.level].clouds !== false)
  const lensFlare = useStore(qualityStore, s => QUALITY_PRESETS[s.level].lensFlare)
  // With clouds, the sky is drawn in post while the sun is up so cloud light
  // shafts reach it; at night the scene Sky + Stars are kept (sky-in-post
  // would replace the stars, and there are no light shafts at night).
  const [sunUp, setSunUp] = useState(true)
  const composerRef = useRef<EffectComposerImpl>(null)
  const lightingMaskRef = useRef<LightingMaskPass>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as { __windowSeatComposer?: EffectComposerImpl | null }
    w.__windowSeatComposer = composerRef.current
    return () => {
      delete w.__windowSeatComposer
    }
  }, [])

  // GlobeControls changes near/far every frame; effects reconstructing
  // positions from depth must use the same values.
  useFrame(({ gl }, delta) => {
    if (transientStates != null) {
      updateNightLighting(
        camera.position,
        transientStates.sunDirection,
        transientStates.moonDirection,
        Math.min(delta, 0.1)
      )
    }
    // Eye adaptation: the exposure setting is the daylight value.
    gl.toneMappingExposure = settingsStore.get().exposure * nightState.exposureGain
    const composer = composerRef.current
    if (composer == null) return
    for (const pass of composer.passes) {
      if (pass.fullscreenMaterial instanceof EffectMaterial) {
        pass.fullscreenMaterial.adoptCameraSettings(camera)
      }
    }
    // The lighting mask compares linearized depths; its material copies the
    // camera's near/far only when the camera is assigned.
    if (lightingMaskRef.current != null) {
      lightingMaskRef.current.mainCamera = camera
    }
    if (transientStates != null) {
      up.copy(camera.position).normalize()
      const nextSunUp = transientStates.sunDirection.dot(up) > -0.05
      if (nextSunUp !== sunUp) setSunUp(nextSunUp)
    }
  })

  return (
    <EffectComposer ref={composerRef} multisampling={0} enableNormalPass>
      {/*
        Mixed lighting: tiles are unlit albedo, lit in post (sunLight/skyLight
        below). Aircraft on AIRCRAFT_LAYER are lit by SunLight/SkyLight light
        sources instead, so they can have specular highlights and emissive
        night markers; the mask keeps post lighting off their pixels. Aerial
        perspective (transmittance + inscatter) still applies to both.
      */}
      <LightingMask ref={lightingMaskRef} selectionLayer={AIRCRAFT_LAYER} />
      <VolumetricClouds />
      <AerialPerspective
        ref={effect => {
          if (effect != null) patchNightLight(effect)
        }}
        sky={cloudsEnabled && sunUp}
        sunLight
        skyLight
        correctGeometricError
        albedoScale={2 / Math.PI}
      />
      <>{lensFlare ? <LensFlare /> : null}</>
      <ToneMapping mode={ToneMappingMode.AGX} />
      <SMAA />
      <Dithering />
    </EffectComposer>
  )
}
