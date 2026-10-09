import { useFrame, useThree } from '@react-three/fiber'
import { SMAA, ToneMapping } from '@react-three/postprocessing'
import { AerialPerspective } from '@takram/three-atmosphere/r3f'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import {
  EffectMaterial,
  ToneMappingMode,
  type EffectComposer as EffectComposerImpl
} from 'postprocessing'
import { useRef, type FC } from 'react'

import { settingsStore } from '../state/settings'
import { EffectComposer } from './EffectComposer'

export const PostEffects: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const composerRef = useRef<EffectComposerImpl>(null)

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
  })

  return (
    <EffectComposer ref={composerRef} multisampling={0} enableNormalPass>
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
