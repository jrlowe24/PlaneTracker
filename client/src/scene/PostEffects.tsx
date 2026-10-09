import { useFrame, useThree } from '@react-three/fiber'
import { SMAA, ToneMapping } from '@react-three/postprocessing'
import type { LightingMaskPass } from '@takram/three-atmosphere'
import { AerialPerspective, LightingMask } from '@takram/three-atmosphere/r3f'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import {
  EffectMaterial,
  ToneMappingMode,
  type EffectComposer as EffectComposerImpl
} from 'postprocessing'
import { useEffect, useRef, type FC } from 'react'

import { AIRCRAFT_LAYER } from '../aircraft/layers'
import { settingsStore } from '../state/settings'
import { EffectComposer } from './EffectComposer'

export const PostEffects: FC = () => {
  const camera = useThree(({ camera }) => camera)
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
  useFrame(({ gl }) => {
    gl.toneMappingExposure = settingsStore.get().exposure
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
      <AerialPerspective
        sunLight
        skyLight
        correctGeometricError
        albedoScale={2 / Math.PI}
      />
      <LensFlare />
      <ToneMapping mode={ToneMappingMode.AGX} />
      <SMAA />
      <Dithering />
    </EffectComposer>
  )
}
