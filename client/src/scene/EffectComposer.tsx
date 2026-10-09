import {
  EffectComposer as WrappedEffectComposer,
  type EffectComposerProps
} from '@react-three/postprocessing'
import {
  NormalPass,
  type EffectComposer as EffectComposerImpl
} from 'postprocessing'
import { useLayoutEffect, useRef, type FC, type RefAttributes } from 'react'
import { mergeRefs } from 'react-merge-refs'
import { HalfFloatType, type WebGLRenderTarget } from 'three'

/**
 * EffectComposer with a half-float normal buffer. The default 8-bit normal
 * target quantizes normals visibly under the atmosphere's sun/sky lighting.
 * Ported from takram's three-geospatial storybook helper.
 */
export const EffectComposer: FC<
  EffectComposerProps & RefAttributes<EffectComposerImpl>
> = ({ ref: forwardedRef, enableNormalPass = true, ...props }) => {
  const ref = useRef<EffectComposerImpl>(null)
  useLayoutEffect(() => {
    const normalPass = ref.current?.passes.find(
      (pass): pass is NormalPass => pass instanceof NormalPass
    ) as (NormalPass & { renderTarget: WebGLRenderTarget }) | undefined
    if (normalPass != null) {
      normalPass.renderTarget.texture.type = HalfFloatType
    }
  }, [])

  return (
    <WrappedEffectComposer
      ref={mergeRefs([ref, forwardedRef])}
      {...props}
      enableNormalPass={enableNormalPass}
    />
  )
}
