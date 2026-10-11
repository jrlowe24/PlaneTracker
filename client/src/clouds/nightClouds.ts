import type { CloudsEffect } from '@takram/three-clouds'
import { Uniform, Vector3, type Camera, type ShaderMaterial, type Texture } from 'three'

import { MOON_TINT, nightState, STAR_TINT, STARLIGHT } from '../scene/nightLighting'

/**
 * Night light for the clouds, inside takram's march rather than painted on
 * the composited overlay. Lit by opacity alone (as before), a cloud was the
 * same flat tone on every side: no lit tops, no shadowed bases, no depth.
 *
 * - Moonlight: past dusk the march's light is the moon. Its direction
 *   replaces the sun's for the clouds (self-shadowing, shadow maps and the
 *   phase function: silver linings near the moon) and every irradiance the
 *   march reads is scaled from sunlight down to moonlight. The atmosphere
 *   in front of the clouds keeps the real sun.
 * - City glow: city light from NASA's night map lights each cloud sample
 *   from below, fading with its depth above the layer base. Bases glow
 *   over cities, tops stay dark, thin cloud and edges catch the light.
 */

const MARKER = '/* window-seat night clouds */'

/** Sun irradiance in the renderer's units (see nightLighting.ts). */
const SUN_IRRADIANCE = 1.5
/**
 * Perceptual gain on moonlight in cloud: clouds (albedo ~0.9) should read
 * clearly brighter than moonlit ground, as they do to dark-adapted eyes.
 */
const MOON_GAIN = 0.4
/**
 * Starlight and airglow come from the whole sky; in cloud they're marched
 * as light from the zenith (tops brighter than bases), weighted against
 * the moon in the light's direction, so clouds keep their shape on
 * moonless nights.
 */
const STAR_WEIGHT = 0.5
/** Below this night level the sun lights the clouds; above it, the moon. */
const SWITCH = 0.7
/** City glow at full NASA radiance (radiance units, as the ground's). */
const CITY_GLOW = new Vector3(0.0032, 0.0019, 0.001)
/** City glow falls off with height above ground (meters, e-folding). */
const CITY_GLOW_HEIGHT = 3000
/**
 * How far city glow reaches up into cloud from its base (meters,
 * e-folding). A fixed depth rather than each sample's own extinction,
 * which varies with the detail noise and speckled the lit base.
 */
const GLOW_DEPTH = 180

export const nightCloudUniforms = {
  cloudLightScale: new Uniform(new Vector3(1, 1, 1)),
  cityGlow: new Uniform(new Vector3()),
  cityGlowMap: new Uniform<Texture | null>(null),
  realSunDirection: new Uniform(new Vector3(0, 0, 1))
}

const UNIFORMS = `
${MARKER}
uniform vec3 cloudLightScale;
uniform vec3 cityGlow;
uniform sampler2D cityGlowMap;
uniform vec3 realSunDirection;
`

const CHUNK = /* glsl */ `
vec3 cityGlowRadiance(const vec3 position, const float height, const MediaSample media) {
  float lon = atan(position.y, position.x);
  float lat = atan(position.z, length(position.xy) * (1.0 - 0.00669438));
  vec2 deg = vec2(degrees(lon) + 180.0, 90.0 - degrees(lat));
  float value = texture(cityGlowMap, deg / vec2(360.0, 180.0)).r;
  if (value <= 0.0) return vec3(0.0);
  float weightSum = max(dot(media.weight, vec4(1.0)), 1e-4);
  float aboveBase = dot(media.weight, max(vec4(0.0), height - minLayerHeights)) / weightSum;
  // Light from the ground spreads out with height: cirrus barely sees it.
  float spread = exp(-height / ${CITY_GLOW_HEIGHT.toFixed(1)});
  return cityGlow * (value * value) * spread * exp(-aboveBase / ${GLOW_DEPTH.toFixed(1)});
}
`

const CLOUD_IRRADIANCE = '      vec3 sunIrradiance = getCloudsSunSkyIrradiance(position, height, skyIrradiance);'
const GROUND_IRRADIANCE = '  vec3 sunIrradiance = getGroundSunSkyIrradiance(position, surfaceNormal, height, skyIrradiance);'
const HAZE_SKY = '  vec3 skyIrradiance = vGroundIrradiance.sky;\n  vec3 sunIrradiance = vGroundIrradiance.sun;'
const SKY_GRADIENT = '      // Crude approximation of sky gradient. Better than none in the shadows.'
const ANCHOR = 'vec4 marchClouds('
/** The atmosphere between the camera and the clouds keeps the real sun. */
const AERIAL = '    shadowLength * METER_TO_LENGTH_UNIT,\n    sunDirection,\n    transmittance\n  );'
const UNIFORM_ANCHOR = 'uniform float perspectiveStepScale;'

export function patchNightClouds(material: ShaderMaterial): boolean {
  const source = material.fragmentShader
  if (source.includes(MARKER)) return true
  if (![CLOUD_IRRADIANCE, SKY_GRADIENT, ANCHOR, UNIFORM_ANCHOR, AERIAL].every(s => source.includes(s))) return false
  material.fragmentShader = source
    .replace(UNIFORM_ANCHOR, `${UNIFORM_ANCHOR}\n${UNIFORMS}`)
    .replace(ANCHOR, `${CHUNK}\n${ANCHOR}`)
    .replace(AERIAL, AERIAL.replace('sunDirection', 'realSunDirection'))
    .replace(CLOUD_IRRADIANCE, `${CLOUD_IRRADIANCE}\n      sunIrradiance *= cloudLightScale;\n      skyIrradiance *= cloudLightScale;`)
    .replace(GROUND_IRRADIANCE, `${GROUND_IRRADIANCE}\n  sunIrradiance *= cloudLightScale;\n  skyIrradiance *= cloudLightScale;`)
    .replace(HAZE_SKY, `  vec3 skyIrradiance = vGroundIrradiance.sky * cloudLightScale;\n  vec3 sunIrradiance = vGroundIrradiance.sun * cloudLightScale;`)
    .replace(SKY_GRADIENT, `      if (cityGlow.r > 0.0) radiance += cityGlowRadiance(position, height, media);\n\n${SKY_GRADIENT}`)
  Object.assign(material.uniforms, nightCloudUniforms)
  material.needsUpdate = true
  return true
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Sets the night light for this frame. Runs inside the effect's update,
 * after <Clouds> copied the sun direction in, so the moon can take its
 * place for the shadow maps and the march.
 */
export function installNightClouds(
  effect: CloudsEffect,
  camera: Camera,
  moonDirection: () => Vector3 | null,
  cityMap: () => Texture | null
): void {
  const patched = effect as CloudsEffect & { __nightClouds?: boolean }
  if (patched.__nightClouds === true) return
  patched.__nightClouds = true
  const update = effect.update.bind(effect)
  const { cloudLightScale, cityGlow, cityGlowMap, realSunDirection } = nightCloudUniforms
  effect.update = (...args: Parameters<CloudsEffect['update']>) => {
    realSunDirection.value.copy(effect.sunDirection)
    const night = nightState.night
    const moonDir = moonDirection()
    if (night > SWITCH && moonDir != null) {
      const moon = devMoon() ?? nightState.moon
      const stars = STARLIGHT * night
      // Zenith over the camera, in ECEF like the moon direction.
      zenith.copy(camera.position).applyMatrix4(effect.worldToECEFMatrix).normalize()
      const light = devMoon() != null ? devMoonDirection(zenith) : moonDir
      effect.sunDirection.copy(light).multiplyScalar(moon).addScaledVector(zenith, stars * STAR_WEIGHT).normalize()
      const k = (MOON_GAIN / SUN_IRRADIANCE) * smoothstep(SWITCH, SWITCH + 0.15, night)
      cloudLightScale.value.copy(MOON_TINT).multiplyScalar(moon * k).addScaledVector(STAR_TINT, stars * k)
    } else {
      // Dusk: the last sky light fades before the night light takes over.
      cloudLightScale.value.setScalar(1 - smoothstep(SWITCH - 0.2, SWITCH, night))
    }
    const map = cityMap()
    cityGlowMap.value = map
    cityGlow.value.copy(CITY_GLOW).multiplyScalar(map != null ? smoothstep(0.3, 0.8, night) : 0)
    update(...args)
  }
}

const zenith = new Vector3()
const devDirection = new Vector3()

/** Dev only: a moon 37° up, for testing on moonless dates. */
function devMoonDirection(zenith: Vector3): Vector3 {
  devDirection.set(0, 0, 1).cross(zenith).normalize()
  return devDirection.multiplyScalar(0.8).addScaledVector(zenith, 0.6)
}

/** Dev only: window.__nightCloudsMoon overrides the moonlight (testing on moonless dates). */
function devMoon(): number | null {
  if (!import.meta.env.DEV) return null
  const value = (window as { __nightCloudsMoon?: number }).__nightCloudsMoon
  return typeof value === 'number' ? value : null
}
