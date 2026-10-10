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
  const shapeRemap = 'density = remapClamped(density, vec4(1.0 - shape) * shapeAmounts, vec4(1.0));'
  const source = material.fragmentShader
  if (
    !source.includes(signature) ||
    !source.includes(apply) ||
    !source.includes(WEATHER_SAMPLE) ||
    !source.includes(mediaSample) ||
    !source.includes(shapeRemap)
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
      `${mediaSample}\n  ${LOCAL_MORPH_MARKER}\n  vec4 localShapeAmounts = shapeAmounts;\n  vec4 localShapeDetailAmounts = shapeDetailAmounts;\n  float localDeck = smoothstep(0.3, 0.6, weather.localCoverage);\n  float lowStratus = smoothstep(0.42, 0.58, weather.localCoverage);\n  // Coverage-driven morphology: retain billows in broken weather; flatten\n  // dense low-cloud regions so cellular detail merges into a deck.\n  localShapeAmounts.x = mix(shapeAmounts.x, mix(0.95, 0.22, lowStratus), localDeck);\n  localShapeDetailAmounts.x = mix(shapeDetailAmounts.x, mix(0.55, 0.08, lowStratus), localDeck);`
    )
    .replace(shapeRemap, 'density = remapClamped(density, vec4(1.0 - shape) * localShapeAmounts, vec4(1.0));')
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
  const history = '  vec4 historyColor = texture(colorHistoryBuffer, prevUv);'
  const blend = '  outputColor = mix(clippedColor, currentColor, temporalAlpha);'
  const source = material.fragmentShader
  const anchor = 'void temporalUpscale('
  if (!source.includes(current) || !source.includes(history) || !source.includes(blend) || !source.includes(anchor)) {
    return false
  }
  // After the raw shader's own precision/defines header.
  material.fragmentShader = source
    .replace(anchor, `${RESOLVE_MARKER}\nbool badColor(const vec4 c) { return any(isnan(c)) || any(isinf(c)); }\n\n${anchor}`)
    .replace(current, `${current}\n  if (badColor(currentColor)) currentColor = vec4(0.0);`)
    .replaceAll(history, `${history}\n  if (badColor(historyColor)) historyColor = currentColor;`)
    .replace(blend, `${blend}\n  if (badColor(outputColor)) outputColor = currentColor;`)
  material.needsUpdate = true
  return true
}
