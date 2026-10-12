import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { Matrix4, Uniform, Vector3, type Camera } from 'three'
import { ecefToGeodetic } from '@windowseat/shared'

import { cloudCoverStore } from '../clouds/cloudCoverStore'
import { cloudDepth } from '../clouds/cloudDepth'
import { nightEmission } from '../nightLights/nightLightsStore'
import { qualityStore } from '../state/quality'
import { nightState } from './nightLighting'
import { CITY_ATMOSPHERE_SHADER } from './cityAtmosphere'

const shader = /* glsl */ `
uniform mat4 cityInverseProjection;
uniform mat4 cityCameraWorld;
uniform sampler2D cityCloudDepth;
uniform float cityCloudsOn;
${CITY_ATMOSPHERE_SHADER}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (cityAtmosphereOn <= 0.0) { outputColor = inputColor; return; }
  vec4 view = cityInverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 direction = normalize(mat3(cityCameraWorld) * view.xyz);
  float distance = depth >= 0.9999999 ? 1e6 : length(view.xyz / view.w) * 0.001;
  if (cityCloudsOn > 0.0) {
    // City-lit cloud bases are already marched by nightClouds. Only add the
    // atmospheric glow between the camera and the first cloud here.
    float cloudDistance = texture(cityCloudDepth, uv).r * 0.001;
    if (cloudDistance > 0.0) distance = min(distance, cloudDistance);
  }
  outputColor = vec4(inputColor.rgb + cityAtmosphere(direction, distance), inputColor.a);
}
`

/** Separate pass: the atmosphere + semantic-water compositor uses all 16 samplers. */
export class CityAtmosphereEffect extends Effect {
  constructor(private camera: Camera) {
    super('CityAtmosphereEffect', shader, {
      blendFunction: BlendFunction.NORMAL,
      // CONVOLUTION enforces a separate EffectPass, avoiding the GPU sampler cap.
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ['cityEmissionMap', new Uniform(null)],
        ['cityAtmosphereOn', new Uniform(0)],
        ['cityAtmosphereSamples', new Uniform(5)],
        ['cityHaze', new Uniform(1)],
        ['cityPosition', new Uniform(new Vector3())],
        ['citySun', new Uniform(new Vector3())],
        ['cityRadius', new Uniform(6371)],
        ['cityInverseProjection', new Uniform(new Matrix4())],
        ['cityCameraWorld', new Uniform(new Matrix4())],
        ['cityCloudDepth', new Uniform(null)],
        ['cityCloudsOn', new Uniform(0)]
      ])
    })
  }

  override set mainCamera(camera: Camera) { this.camera = camera }

  setSun(direction: Vector3): void {
    this.uniforms.get('citySun')!.value.copy(direction)
  }

  override update(): void {
    const u = this.uniforms
    const camera = this.camera
    const altitude = ecefToGeodetic(camera.position.x, camera.position.y, camera.position.z).height
    const quality = qualityStore.get().settings
    const samples = quality.cityAtmosphereSamples
    const fade = Math.max(0, Math.min(1, (100_000 - altitude) / 60_000))
    u.get('cityAtmosphereOn')!.value = nightEmission.baseMap != null && samples > 0 ? nightState.night * fade * fade * (3 - 2 * fade) : 0
    u.get('cityEmissionMap')!.value = nightEmission.baseMap
    u.get('cityAtmosphereSamples')!.value = Math.max(1, samples)
    u.get('cityHaze')!.value = 0.8 + cloudCoverStore.get().low * 0.7
    u.get('cityPosition')!.value.copy(camera.position).multiplyScalar(0.001)
    u.get('cityRadius')!.value = (camera.position.length() - altitude) * 0.001
    u.get('cityInverseProjection')!.value.copy(camera.projectionMatrixInverse)
    u.get('cityCameraWorld')!.value.copy(camera.matrixWorld)
    u.get('cityCloudDepth')!.value = cloudDepth.texture
    u.get('cityCloudsOn')!.value = quality.clouds !== false && cloudDepth.texture != null ? cloudDepth.fade : 0
  }
}
