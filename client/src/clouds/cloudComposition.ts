import type { CloudsEffect } from '@takram/three-clouds'
import { EffectAttribute } from 'postprocessing'

/**
 * Keep the cloud compositor out of AerialPerspective's effect shader.
 * AerialPerspective uses the complete 16-sampler WebGL2 budget after the
 * lighting-mask, cloud-depth, night-emission and semantic-water extensions.
 * Merging CloudsEffect adds a seventeenth sampler; switching cloud quality
 * recompiles that invalid shader and leaves the 3D canvas black.
 */
export function isolateCloudComposition(effect: CloudsEffect): void {
  // postprocessing marks this public runtime API protected in its typings.
  const attributes = effect as unknown as {
    getAttributes: () => EffectAttribute
    setAttributes: (value: EffectAttribute) => void
  }
  attributes.setAttributes(attributes.getAttributes() | EffectAttribute.CONVOLUTION)
}
