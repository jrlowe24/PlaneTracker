import { Uniform, type ShaderMaterial } from 'three'

/**
 * Refines where cloud rays enter cloud. takram's march strides through
 * empty space (and the gaps between layers) in long steps, up to 1 km when
 * the camera is far, and starts shading wherever the first step that lands
 * in cloud happens to be. The cloud's near surface is then quantized to
 * that stride: tops and edges show rings at fixed distances from the
 * camera, which sweep across the deck as the camera moves, and edges
 * flicker by up to a stride per frame as the jitter changes (worst zoomed
 * out). Here a long stride that lands in cloud steps back to the last
 * empty sample and walks in at the fine step instead.
 */

const MARKER = '/* window-seat refined cloud entry */'

const START = '  float rayDistance = stepSize * jitter * 2.0;\n'
const SKIP = `      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;`
const EMPTY_TEST = '    if (!any(greaterThan(weather.density, vec4(minDensity)))) {'
const MEDIA = '    // Sample detailed participating media.\n    MediaSample media = sampleMedia('

export const marchRefine = new Uniform(1)

export function patchCloudsMarch(material: ShaderMaterial): boolean {
  const source = material.fragmentShader
  if (source.includes(MARKER)) return true
  if (!source.includes(START) || source.split(SKIP).length !== 3 || !source.includes(EMPTY_TEST) || !source.includes(MEDIA)) {
    return false
  }
  material.fragmentShader = source
    .replace('vec4 marchClouds(', `${MARKER}\nuniform float marchRefine;\n\nvec4 marchClouds(`)
    .replace(START, `${START}  float lastSkip = 0.0;\n  float fineUntil = -1.0;\n`)
    .replaceAll(
      SKIP,
      `      stepSize *= perspectiveStepScale;
      lastSkip = rayDistance < fineUntil ? stepSize : mix(stepSize, maxStepSize, min(1.0, mipLevel));
      rayDistance += lastSkip;
      continue;`
    )
    .replace(
      MEDIA,
      `    // A long stride landed in cloud: back to the last empty sample, then
    // walk in at the fine step up to here.
    if (marchRefine > 0.5 && lastSkip > stepSize * 1.5) {
      rayDistance -= lastSkip;
      fineUntil = rayDistance + lastSkip;
      lastSkip = 0.0;
      rayDistance += stepSize;
      continue;
    }
    lastSkip = 0.0;

${MEDIA}`
    )
  material.uniforms.marchRefine = marchRefine
  material.needsUpdate = true
  return true
}
