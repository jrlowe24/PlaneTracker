import { BlendFunction, Effect } from 'postprocessing'
import { Uniform, type Texture } from 'three'

const fragmentShader = /* glsl */ `
uniform sampler2D glowBuffer;
uniform float strength;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb + texture(glowBuffer, uv).rgb * strength, inputColor.a);
}
`

/**
 * Glow around night lights: the blurred night light buffer (NightLightsPass)
 * added to the scene before tone mapping, like the halo lights form in the
 * eye and through the air. Only the lights glow: a bloom over the whole
 * scene buffer washed everything white (stray huge values in it).
 */
export class NightGlowEffect extends Effect {
  constructor() {
    super('NightGlowEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['glowBuffer', new Uniform(null)],
        ['strength', new Uniform(0)]
      ])
    })
  }

  setGlow(texture: Texture | null, strength: number): void {
    ;(this.uniforms.get('glowBuffer') as Uniform<Texture | null>).value = texture
    ;(this.uniforms.get('strength') as Uniform<number>).value = texture == null ? 0 : strength
  }
}
