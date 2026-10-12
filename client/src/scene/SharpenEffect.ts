import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { Uniform } from 'three'

const shader = /* glsl */ `
uniform float sharpenAmount;

float sharpenLuma(const vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 north = texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb;
  vec3 south = texture2D(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb;
  vec3 east = texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb;
  vec3 west = texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb;

  vec3 localMean = (north + south + east + west) * 0.25;
  vec3 detail = inputColor.rgb - localMean;

  float centerLuma = sharpenLuma(inputColor.rgb);
  float minLuma = min(centerLuma, min(min(sharpenLuma(north), sharpenLuma(south)), min(sharpenLuma(east), sharpenLuma(west))));
  float maxLuma = max(centerLuma, max(max(sharpenLuma(north), sharpenLuma(south)), max(sharpenLuma(east), sharpenLuma(west))));
  float contrast = maxLuma - minLuma;

  // Leave smooth sky, atmosphere and dark water alone. Ease back on already
  // hard silhouettes and clipped lights, where unsharp masking makes halos.
  float textureGate = smoothstep(0.006, 0.055, contrast);
  float hardEdge = smoothstep(0.18, 0.5, contrast);
  float highlight = smoothstep(0.72, 1.0, centerLuma);
  float amount = sharpenAmount * textureGate * (1.0 - 0.4 * hardEdge) * (1.0 - 0.25 * highlight);

  vec3 sharpened = inputColor.rgb + detail * amount;
  vec3 localMin = min(inputColor.rgb, min(min(north, south), min(east, west)));
  vec3 localMax = max(inputColor.rgb, max(max(north, south), max(east, west)));
  vec3 span = localMax - localMin;
  // A small permitted overshoot restores sparkle; the local clamp prevents
  // visible light/dark ringing around building and shoreline silhouettes.
  sharpened = clamp(sharpened, localMin - span * 0.08, localMax + span * 0.08);
  outputColor = vec4(sharpened, inputColor.a);
}
`

/** Contrast-adaptive final-stage sharpening for the desktop renderer. */
export class SharpenEffect extends Effect {
  constructor(amount = 0.55) {
    super('SharpenEffect', shader, {
      blendFunction: BlendFunction.NORMAL,
      // Neighbor samples must see SMAA's completed output, not a merged pass.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([['sharpenAmount', new Uniform(amount)]])
    })
  }

  setAmount(value: number): void {
    this.uniforms.get('sharpenAmount')!.value = value
  }
}
