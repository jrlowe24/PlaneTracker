import { Uniform, Vector4, type ShaderMaterial } from 'three'

/**
 * Clouds seen from far above, in takram's clouds pass. The volumetric
 * march used to fade out between 25 and 70 km camera altitude: on the way
 * the clouds turned into a translucent veil (distant samples read blurred
 * noise) and then the weather vanished altogether.
 *
 * From high up the clouds are now one sample per layer instead of a
 * march: where the view ray crosses each layer (cirrus, mid, low) near the
 * base, where its clouds are widest, the same weather, coverage and shape
 * as the march (regionalShader.ts) give the cloud there, the layer's depth
 * its opacity, and takram's sun and sky irradiance (and our night light)
 * its color; the ground in view gets the clouds' shadows. It writes the
 * march's outputs (color and front depth), so compositing, aerial
 * perspective, aircraft occlusion and night lights through cloud work as
 * before, at a small fraction of the cost. Between FAR_START and FAR_END
 * altitude (VolumetricClouds.tsx) the two cross-fade.
 */

const MARKER = '/* window-seat far clouds */'

/** 0: volumetric march only … 1: far layer only. */
export const farCloudMix = new Uniform(0)
/**
 * x: optical depth to the sun at the cloud top; y: radiance gain;
 * z: opacity per unit of the layer's extinction × depth (takram's cloud
 * is opaque within tens of meters; the column through a whole layer would
 * be solid to its faintest edge);
 * w: sample height within the layer (0 base … 1 top): near the base,
 * where cumulus are widest (as they look from above).
 */
export const farCloudTune = new Uniform(new Vector4(1.2, 1, 0.015, 0.12))

const MARCH_CALL = `    float marchedFrontDepth;
    ivec3 sampleCount = ivec3(0);
    color = marchClouds(
      rayOrigin,
      rayDirection,
      rayNearFar,
      cosTheta,
      stbn,
      pow(2.0, mipLevel),
      marchedFrontDepth,
      sampleCount
    );
`

const MAIN = 'void main() {'

function chunk(night: boolean): string {
  return /* glsl */ `
${MARKER}
uniform float farCloudMix;
uniform vec4 farCloudTune;
const float CIRRUS_OPACITY = 30.0;

/**
 * At map distance the 20 km repeating 3D shape texture is visible as rows.
 * Keep only the layer density shaped by the mesoscale weather texture; the
 * full march brings the 3D erosion back as the camera descends.
 */
MediaSample farCloudMedia(const WeatherSample weather, const vec4 layerMask) {
  vec4 density = saturate(
    weather.density * densityScales * getLayerDensity(weather.heightFraction)
  ) * layerMask;
  float densitySum = density.x + density.y + density.z + density.w;
  MediaSample media;
  media.weight = densitySum > 1e-6 ? density / densitySum : vec4(0.0);
  media.scattering = densitySum * scatteringCoefficient;
  media.extinction = densitySum * absorptionCoefficient + media.scattering;
  return media;
}

void farCloudLayer(
  const float bottom,
  const float top,
  const vec4 layerMask,
  const float sampleHeight,
  const float opacityScale,
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const float maxDistance,
  const float cosTheta,
  const float mipLevel,
  inout vec4 color,
  inout float frontDepth
) {
  if (top - bottom < 1.0) return;
  float height = mix(bottom, top, sampleHeight);
  float radius = bottomRadius + height;
  float b = dot(cameraPosition, rayDirection);
  float c = dot(cameraPosition, cameraPosition) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return;
  // First crossing from above the layer, the way out from below it.
  float t = c > 0.0 ? -b - sqrt(disc) : -b + sqrt(disc);
  if (t <= 0.0 || t > maxDistance) return;

  vec3 position = cameraPosition + t * rayDirection;
  vec2 uv = getGlobeUv(position);
  WeatherSample weather = sampleWeather(uv, height, mipLevel, position);
  if (dot(weather.density, layerMask) <= minDensity) return;
  MediaSample media = farCloudMedia(weather, layerMask);
  float opticalDepth = media.extinction * (top - bottom) * farCloudTune.z * opacityScale;
  float alpha = 1.0 - exp(-opticalDepth);
  if (alpha < 1e-3) return;

  vec3 skyIrradiance;
  vec3 sunIrradiance = getCloudsSunSkyIrradiance(position, height, skyIrradiance);
  ${night ? 'sunIrradiance *= cloudLightScale;\n  skyIrradiance *= cloudLightScale;' : ''}
  // Tops face the light; a low sun reaches them through more cloud, and
  // thin cloud is lit all the way through.
  float mu = dot(normalize(position), sunDirection);
  float sunDepth = min(opticalDepth, farCloudTune.x / max(0.15, mu + 0.15));
  vec3 radiance = sunIrradiance * approximateMultipleScattering(sunDepth, cosTheta);
  radiance += skyIrradiance * RECIPROCAL_PI4 * skyLightScale * 0.75;
  ${night ? 'if (cityGlow.r > 0.0) radiance += cityGlowRadiance(position, height, media);' : ''}
  radiance *= farCloudTune.y;

  if (frontDepth < 0.0) frontDepth = t;
  color.rgb += (1.0 - color.a) * alpha * radiance;
  color.a += (1.0 - color.a) * alpha;
}

/** Opacity of a layer where the ray from a ground point toward the sun crosses it. */
float farCloudShadowLayer(
  const float bottom,
  const float top,
  const vec4 layerMask,
  const float sampleHeight,
  const float opacityScale,
  const vec3 ground,
  const vec3 toSun,
  const float mipLevel
) {
  if (top - bottom < 1.0) return 0.0;
  float height = mix(bottom, top, sampleHeight);
  float radius = bottomRadius + height;
  float b = dot(ground, toSun);
  float c = dot(ground, ground) - radius * radius;
  if (c > 0.0) return 0.0; // Ground above the layer.
  vec3 position = ground + (-b + sqrt(b * b - c)) * toSun;
  vec2 uv = getGlobeUv(position);
  WeatherSample weather = sampleWeather(uv, height, mipLevel, position);
  if (dot(weather.density, layerMask) <= minDensity) return 0.0;
  MediaSample media = farCloudMedia(weather, layerMask);
  return 1.0 - exp(-media.extinction * (top - bottom) * farCloudTune.z * opacityScale);
}

/**
 * Cloud shadow on the ground at a far view (the volumetric shadow maps
 * reach only ~40 km): darkens the ground by the sunlight the clouds block,
 * as a dark overlay (the share of the ground's light that is direct sun).
 */
float farCloudShadow(const vec3 ground, const float mipLevel) {
  vec3 toSun = ${night ? 'realSunDirection' : 'sunDirection'};
  float sunUp = smoothstep(0.0, 0.1, dot(normalize(ground), toSun));
  if (sunUp <= 0.0) return 0.0;
  float low = farCloudShadowLayer(minLayerHeights.x, maxLayerHeights.x, vec4(1.0, 0.0, 0.0, 0.0), farCloudTune.w, 1.0, ground, toSun, mipLevel);
  float mid = farCloudShadowLayer(minLayerHeights.y, maxLayerHeights.y, vec4(0.0, 1.0, 0.0, 0.0), farCloudTune.w, 1.0, ground, toSun, mipLevel);
  return (1.0 - (1.0 - low) * (1.0 - mid)) * sunUp * 0.4;
}

vec4 farClouds(
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float cosTheta,
  const float mipLevel,
  out float frontDepth
) {
  vec4 color = vec4(0.0);
  frontDepth = -1.0;
  // Seen from above: cirrus, the mid layer, then low.
  farCloudLayer(minLayerHeights.z, maxLayerHeights.z, vec4(0.0, 0.0, 1.0, 0.0), farCloudTune.w, CIRRUS_OPACITY, cameraPosition, rayDirection, rayNearFar.y, cosTheta, mipLevel, color, frontDepth);
  farCloudLayer(minLayerHeights.y, maxLayerHeights.y, vec4(0.0, 1.0, 0.0, 0.0), farCloudTune.w, 1.0, cameraPosition, rayDirection, rayNearFar.y, cosTheta, mipLevel, color, frontDepth);
  farCloudLayer(minLayerHeights.x, maxLayerHeights.x, vec4(1.0, 0.0, 0.0, 0.0), farCloudTune.w, 1.0, cameraPosition, rayDirection, rayNearFar.y, cosTheta, mipLevel, color, frontDepth);
  return color;
}
`
}

const FAR_CALL = `    float marchedFrontDepth = -1.0;
    ivec3 sampleCount = ivec3(0);
    if (farCloudMix < 0.999) {
      color = marchClouds(
        rayOrigin,
        rayDirection,
        rayNearFar,
        cosTheta,
        stbn,
        pow(2.0, mipLevel),
        marchedFrontDepth,
        sampleCount
      );
    }
    if (farCloudMix > 0.001) {
      float farDepth;
      vec4 far = farClouds(cameraPosition, rayDirection, rayNearFar, cosTheta, mipLevel, farDepth);
      // Cloud shadows on the ground in view (where the far clouds leave it
      // visible).
      if (rayDistanceToScene > 0.0 && far.a < 0.99) {
        float shadow = farCloudShadow(cameraPosition + rayDistanceToScene * rayDirection, mipLevel);
        far.a += (1.0 - far.a) * shadow;
      }
      color = mix(color, far, farCloudMix);
      if (farDepth >= 0.0 && (marchedFrontDepth < 0.0 || farCloudMix > 0.5)) {
        marchedFrontDepth = max(0.0, farDepth - rayNearFar.x);
      }
    }
`

/**
 * Patches the clouds material once (after the regional and night patches,
 * whose functions and uniforms it uses); false if takram's shader changed.
 */
export function patchFarClouds(material: ShaderMaterial): boolean {
  const source = material.fragmentShader
  if (source.includes(MARKER)) return true
  if (!source.includes(MARCH_CALL) || source.split(MAIN).length !== 2 || !source.includes('float localCoverage;')) {
    return false
  }
  const night = source.includes('uniform vec3 cloudLightScale;') && source.includes('vec3 cityGlowRadiance(')
  material.fragmentShader = source.replace(MAIN, `${chunk(night)}\n${MAIN}`).replace(MARCH_CALL, FAR_CALL)
  Object.assign(material.uniforms, { farCloudMix, farCloudTune })
  material.needsUpdate = true
  return true
}
