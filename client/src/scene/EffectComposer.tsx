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
import { HalfFloatType, type Object3D, type WebGLRenderTarget } from 'three'

import { normalPassExclusions } from './normalPassExclusions'

/**
 * EffectComposer with a half-float normal buffer. The default 8-bit normal
 * target quantizes normals visibly under the atmosphere's sun/sky lighting.
 * Ported from takram's three-geospatial storybook helper. Decals listed in
 * normalPassExclusions are left out of the normal buffer.
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
      const render = normalPass.render.bind(normalPass)
      normalPass.render = (...args) => {
        const hidden: Object3D[] = []
        for (const object of normalPassExclusions) {
          if (!object.visible) continue
          object.visible = false
          hidden.push(object)
        }
        try {
          render(...args)
        } finally {
          for (const object of hidden) object.visible = true
        }
      }
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
