import type { ShaderMaterial } from 'three'

const MARKER = '/* window-seat dithered empty-space steps */'

/** Breaks the coherent cloud bands caused by takram's fixed empty-space skips. */
export function patchCloudSkipBanding(material: ShaderMaterial): boolean {
  const source = material.fragmentShader
  if (source.includes(MARKER)) return true

  const skip = `      // TODO: This produces banding artifacts.
      // Possible improvement: Binary search refinement
      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));`
  if (!source.includes(skip)) return false

  material.fragmentShader = source.replace(
    skip,
    `      ${MARKER}
      stepSize *= perspectiveStepScale;
      // A fixed maximum skip imprints concentric rings on distant cloud
      // layers. Dither the empty-space stride with the existing blue-noise
      // ray jitter so neighboring pixels do not share a skip boundary.
      float emptySpaceStep = mix(stepSize, maxStepSize, min(1.0, mipLevel));
      rayDistance += emptySpaceStep * mix(0.8, 1.2, jitter);`
  )
  material.needsUpdate = true
  return true
}
