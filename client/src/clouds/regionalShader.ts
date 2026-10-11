import { ecefToGeodetic, type WeatherGridCell } from '@windowseat/shared'
import type { Vector3} from 'three';
import { Uniform, Vector4, type ShaderMaterial, type Texture } from 'three'

import { COVERAGE_THRESHOLD } from './coverageTexture'
import { REGION_RADIUS, RegionalCoverage, type Cover } from './regionalCoverage'

/**
 * Patches takram's cloud shaders (the clouds pass and the cloud shadow
 * pass) so each weather sample's coverage comes from where it is: the
 * coverage texture holds plain uniform noise, and the shader thresholds it
 * by the regional cover at the sample's position (RegionalCoverage), or by
 * the fallback cover (view-center weather / manual slider) without data.
 * Exactly a fraction c of the noise exceeds the threshold for cover c (see
 * coverageTexture.ts).
 */

const MARKER = '/* window-seat regional coverage */'
const LOCAL_MORPH_MARKER = '/* window-seat local cloud morphology */'
const WEATHER_SAMPLE = `struct WeatherSample {
  vec4 heightFraction; // Normalized height of each layer
  vec4 density;
};`

const CHUNK = /* glsl */ `
${MARKER}
uniform sampler2D regionalCoverage;
uniform vec3 regionalAnchor;
uniform vec3 regionalEast;
uniform vec3 regionalNorth;
uniform float regionalRadius;
uniform float regionalEnabled;
uniform vec4 coverageFallback;
// ~37° about a skewed axis (detail noise de-tiling).
const mat3 DETAIL_ROTATION = mat3(
  0.8168, -0.4581, 0.3506,
  0.5187, 0.8492, -0.0990,
  -0.2524, 0.2628, 0.9313
);
// Shape noise position with C1 (smoothstep) interpolation between texels:
// stretched to 20 km a texel spans ~160 m, and trilinear filtering's kinks
// showed as flat facets and straight edges on clouds.
vec3 smoothTexelPosition(const vec3 position, const vec3 size) {
  vec3 texel = position * size + 0.5;
  vec3 corner = floor(texel);
  vec3 f = texel - corner;
  return (corner + f * f * (3.0 - 2.0 * f) - 0.5) / size;
}

vec4 applyRegionalCoverage(vec4 weather, const vec3 position, const float mipLevel, out vec4 localCover) {
  vec4 cover = coverageFallback;
  if (regionalEnabled > 0.5) {
    // Positions here are globe-centered (ECEF plus a small, mostly radial
    // altitude correction), so the east/north projection is unaffected.
    vec3 d = position - regionalAnchor;
    vec2 st = vec2(dot(d, regionalEast), dot(d, regionalNorth)) / (2.0 * regionalRadius) + 0.5;
    float edge = min(min(st.x, st.y), min(1.0 - st.x, 1.0 - st.y));
    vec4 regional = texture(regionalCoverage, clamp(st, 0.0, 1.0));
    cover = mix(coverageFallback, regional, smoothstep(0.0, 0.08, edge));
  }
  vec4 offset = clamp(${COVERAGE_THRESHOLD.toFixed(6)} - (1.0 - cover), -1.0, 1.0);
  vec4 direct = clamp(weather + offset, 0.0, 1.0);
  // Distant samples read blurred mips of the noise (all ~0.5), and
  // thresholding a blurred value turns far clouds into a uniform translucent
  // wall. Use the expected value of clamp(u + offset) over the uniform noise
  // instead, which is what blurring the thresholded field would give.
  vec4 expected = mix(
    0.5 * (1.0 + offset) * (1.0 + offset),
    1.0 - 0.5 * (1.0 - offset) * (1.0 - offset),
    step(0.0, offset)
  );
  weather = mix(direct, expected, smoothstep(0.5, 3.0, mipLevel));
  localCover = cover;
  return weather;
}
`

export interface RegionalUniforms {
  regionalCoverage: Uniform<Texture | null>
  regionalAnchor: Uniform<Vector3>
  regionalEast: Uniform<Vector3>
  regionalNorth: Uniform<Vector3>
  regionalRadius: Uniform<number>
  regionalEnabled: Uniform<number>
  coverageFallback: Uniform<Vector4>
}

export function createRegionalUniforms(regional: RegionalCoverage): RegionalUniforms {
  return {
    regionalCoverage: new Uniform(regional.texture),
    regionalAnchor: new Uniform(regional.anchor),
    regionalEast: new Uniform(regional.east),
    regionalNorth: new Uniform(regional.north),
    regionalRadius: new Uniform(REGION_RADIUS),
    regionalEnabled: new Uniform(0),
    coverageFallback: new Uniform(new Vector4())
  }
}

/** Patches a clouds/shadow material once; false if takram's shader changed. */
export function patchCloudsMaterial(material: ShaderMaterial, uniforms: RegionalUniforms): boolean {
  if (material.fragmentShader.includes(MARKER) && material.fragmentShader.includes(LOCAL_MORPH_MARKER)) return true
  const signature =
    'WeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel) {'
  const apply = '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;'
  const mediaSample = '  vec4 density = weather.density;'
  const detailBranch = '  if (mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {'
  const detailFetch = '    float detail = texture(shapeDetailTexture, detailPosition).r;'
  const shapeFetch = '  float shape = texture(shapeTexture, shapePosition).r;'
  const shapeRemap = 'density = remapClamped(density, vec4(1.0 - shape) * shapeAmounts, vec4(1.0));'
  const source = material.fragmentShader
  if (
    !source.includes(signature) ||
    !source.includes(apply) ||
    !source.includes(WEATHER_SAMPLE) ||
    !source.includes(mediaSample) ||
    !source.includes(shapeRemap) ||
    !source.includes(shapeFetch) ||
    !source.includes(detailFetch) ||
    !source.includes(detailBranch)
  ) return false
  material.fragmentShader = source
    .replace(
      signature,
      `${CHUNK}\nWeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel, const vec3 weatherPosition) {`
    )
    .replace(WEATHER_SAMPLE, `struct WeatherSample {\n  vec4 heightFraction; // Normalized height of each layer\n  vec4 density;\n  float localCoverage;\n};`)
    .replace(
      apply,
      `  vec4 localCover;\n  localWeather = applyRegionalCoverage(localWeather, weatherPosition, mipLevel, localCover);\n  weather.localCoverage = localCover.x;\n${apply}`
    )
    .replace(
      '  vec4 heightScale = shapeAlteringFunction(weather.heightFraction, shapeAlteringBiases);',
      `  vec4 localShapeBiases = shapeAlteringBiases;\n  float lowStratus = smoothstep(0.42, 0.58, weather.localCoverage);\n  localShapeBiases.x = mix(shapeAlteringBiases.x, mix(0.32, 0.12, lowStratus), 1.0);\n  vec4 heightScale = shapeAlteringFunction(weather.heightFraction, localShapeBiases);`
    )
    .replace(
      mediaSample,
      `${mediaSample}\n  ${LOCAL_MORPH_MARKER}\n  vec4 localShapeAmounts = shapeAmounts;\n  vec4 localShapeDetailAmounts = shapeDetailAmounts;\n  float localDeck = smoothstep(0.3, 0.6, weather.localCoverage);\n  float lowStratus = smoothstep(0.42, 0.58, weather.localCoverage);\n  // Coverage-driven morphology: retain billows in broken weather; flatten\n  // dense low-cloud regions so cellular detail merges into a deck.\n  localShapeAmounts.x = mix(shapeAmounts.x, mix(0.95, 0.22, lowStratus), localDeck);\n  localShapeDetailAmounts.x = mix(shapeDetailAmounts.x, mix(0.55, 0.08, lowStratus), localDeck);\n  // Deck edges: where the cover thins out, the shape and billows break the\n  // edge into ragged lumps, and the thinning is steeper. A deck used to\n  // fade over a wide band of thin cloud, which the march's jitter\n  // rendered as sand-like grain.\n  float deckEdge = lowStratus * (1.0 - smoothstep(0.35, 0.95, density.x));\n  localShapeAmounts.x = mix(localShapeAmounts.x, 1.0, deckEdge);\n  localShapeDetailAmounts.x = mix(localShapeDetailAmounts.x, 0.6, deckEdge);\n  density.x = mix(density.x, smoothstep(0.0, 1.0, density.x), 0.5 * lowStratus);`
    )
    .replace(shapeFetch, '  float shape = texture(shapeTexture, smoothTexelPosition(shapePosition, vec3(textureSize(shapeTexture, 0)))).r;')
    .replace(shapeRemap, 'density = remapClamped(density, vec4(1.0 - shape) * localShapeAmounts, vec4(1.0));')
    // No detail reads where the shape left no cloud.
    .replace(detailBranch, '  if (mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5 && any(greaterThan(density, vec4(0.0)))) {')
    // The detail noise repeats every ~170 m (32³ texels), which showed as
    // rows of identical dimples in thin cloud. Two copies at unrelated
    // scales and orientations never line up the same way twice; their
    // average is rescaled to keep the billows' contrast.
    .replace(detailFetch, `    float detailA = texture(shapeDetailTexture, detailPosition).r;
    float detailB = texture(shapeDetailTexture, DETAIL_ROTATION * detailPosition * 0.618 + vec3(0.29, 0.53, 0.17)).r;
    float detail = saturate((detailA + detailB) * 0.5 * 1.45 - 0.72 * 0.45);`)
    .replace('modifier = mix(vec4(0.0), modifier, shapeDetailAmounts);', 'modifier = mix(vec4(0.0), modifier, localShapeDetailAmounts);')
    .replaceAll('sampleWeather(uv, height, mipLevel)', 'sampleWeather(uv, height, mipLevel, position)')
  Object.assign(material.uniforms, uniforms)
  material.needsUpdate = true
  return true
}

/** Owns the regional coverage and its shader uniforms (updated per frame). */
export class RegionalCoverageController {
  readonly coverage = new RegionalCoverage()
  readonly uniforms = createRegionalUniforms(this.coverage)

  /**
   * `fallback` is the cover used where there's no grid data (view-center
   * weather or the manual slider); `live` says whether weather drives
   * the clouds at all.
   */
  update(
    dt: number,
    live: boolean,
    center: Vector3,
    grid: ReadonlyMap<string, WeatherGridCell>,
    fallback: [number, number, number, number]
  ): void {
    this.uniforms.coverageFallback.value.set(...fallback)
    if (live) this.coverage.update(dt, center, grid)
    this.uniforms.regionalEnabled.value = live && this.coverage.hasData ? 1 : 0
  }

  /** Most cover of each layer anywhere in the region, or null without grid data. */
  maxCover(): Cover | null {
    return this.coverage.hasData ? this.coverage.max : null
  }

  /** Blended grid cover at an ECEF point, or null without grid data. */
  coverAtPoint(point: Vector3): Cover | null {
    const g = ecefToGeodetic(point.x, point.y, point.z)
    return this.coverage.coverAt(g.lat, g.lon)
  }

  patch(material: ShaderMaterial): boolean {
    return patchCloudsMaterial(material, this.uniforms)
  }

  dispose(): void {
    this.coverage.dispose()
  }
}

const RESOLVE_MARKER = '/* window-seat nan guard */'

/**
 * Keeps NaN/Inf out of the clouds' temporal history. One bad pixel (some
 * GPUs produce NaN in edge cases of the cloud march) was blended into the
 * history each frame and spread through the neighbourhood clamp, growing
 * into black blocks across the sky. Bad current samples become empty sky,
 * bad history falls back to the current sample.
 */
export function patchCloudsResolve(material: ShaderMaterial): boolean {
  if (material.fragmentShader.includes(RESOLVE_MARKER)) return true
  const current = '  vec4 currentColor = texelFetch(colorBuffer, coord, 0);'
  const lowResCurrent = '  vec4 currentColor = texelFetch(colorBuffer, lowResCoord, 0);'
  const history = '  vec4 historyColor = texture(colorHistoryBuffer, prevUv);'
  const blend = '  outputColor = mix(clippedColor, currentColor, temporalAlpha);'
  const fresh = '    // Use the texel just rendered without any accumulation.\n    outputColor = currentColor;'
  const source = material.fragmentShader
  const anchor = 'void temporalUpscale('
  if (
    !source.includes(current) ||
    !source.includes(lowResCurrent) ||
    !source.includes(history) ||
    !source.includes(blend) ||
    !source.includes(fresh) ||
    !source.includes(anchor)
  ) {
    return false
  }
  // After the raw shader's own precision/defines header.
  material.fragmentShader = source
    .replace(anchor, `${RESOLVE_MARKER}\nbool badColor(const vec4 c) { return any(isnan(c)) || any(isinf(c)); }\n\n${anchor}`)
    .replace(current, `${current}\n  if (badColor(currentColor)) currentColor = vec4(0.0);`)
    .replace(lowResCurrent, `${lowResCurrent}\n  if (badColor(currentColor)) currentColor = vec4(0.0);`)
    .replaceAll(history, `${history}\n  if (badColor(historyColor)) historyColor = currentColor;`)
    .replace(blend, `${blend}\n  if (badColor(outputColor)) outputColor = currentColor;`)
    .replace(fresh, FRESH_SAMPLE)
  material.needsUpdate = true
  return true
}

/**
 * Temporal upscaling marches one pixel in 16 per frame and, as shipped,
 * shows that fresh sample as is: the march's jitter noise (largest in thin
 * cloud) then sits on screen untouched, refreshed every 16 frames, which
 * read as static along every cloud edge. Blend it with its (clipped)
 * history like the plain temporal path does; a cut (temporalAlpha 1)
 * still takes the fresh sample alone.
 */
const FRESH_ALPHA = 0.3
const FRESH_SAMPLE = `    outputColor = currentColor;
    if (temporalAlpha < 1.0) {
      vec2 freshPrevUv = vUv - getClosestFragment(lowResCoord).gb;
      if (all(greaterThanEqual(freshPrevUv, vec2(0.0))) && all(lessThanEqual(freshPrevUv, vec2(1.0)))) {
        vec4 freshHistory = texture(colorHistoryBuffer, freshPrevUv);
        if (!badColor(freshHistory)) {
          vec4 clipped = varianceClipping(colorBuffer, vUv, currentColor, freshHistory, varianceGamma);
          outputColor = mix(clipped, currentColor, ${FRESH_ALPHA.toFixed(2)});
        }
      }
    }`
