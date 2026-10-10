import { ecefToGeodetic, type WeatherGridCell } from '@windowseat/shared'
import type { Vector3} from 'three';
import { Uniform, Vector4, type ShaderMaterial, type Texture } from 'three'

import { CONVECTIVE_FILTER_WIDTH, COVERAGE_THRESHOLD, coverageThreshold } from './coverageTexture'
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

const CHUNK = /* glsl */ `
${MARKER}
uniform sampler2D regionalCoverage;
uniform vec3 regionalAnchor;
uniform vec3 regionalEast;
uniform vec3 regionalNorth;
uniform float regionalRadius;
uniform float regionalEnabled;
uniform vec4 coverageFallback;

/**
 * Cumulonimbus vertical profile for the convective layer (w): a narrower
 * column through the middle that spreads into a wide, flat-topped anvil
 * near the top (where rising air hits the tropopause), instead of the
 * rounded dome shape of fair-weather cumulus. Multiplies the convective
 * coverage at each height, so widths stay relative to how many storms
 * there are (the library's own height profile shifts area by a fixed
 * amount, which erased sparse columns).
 */
float convectiveProfile(const float h) {
  // Widening tower, flaring gradually into the anvil; the top thins out
  // (the noise decides where it ends) instead of a flat cut.
  float column = mix(0.75, 1.25, smoothstep(0.0, 0.75, h));
  float anvil = smoothstep(0.66, 0.9, h);
  float top = 1.0 - 0.85 * smoothstep(0.88, 1.0, h);
  return mix(column, 2.4, anvil) * top;
}

/**
 * Detail erosion varies: by region (some areas of a deck are smooth, others
 * lumpy; a uniform "cauliflower" texture everywhere read as fake), and
 * toward cloud-field edges (thin weather density), which erode harder into
 * ragged, wispy margins instead of rounded walls.
 */
float detailVariation(const vec3 position, const float weatherDensity) {
  float region = texture(shapeTexture, position * shapeRepeat * 0.11 + vec3(0.37, 0.71, 0.13)).r;
  float edge = 1.0 + 0.9 * (1.0 - smoothstep(0.0, 0.55, weatherDensity));
  return mix(0.35, 1.35, smoothstep(0.25, 0.75, region)) * edge;
}

vec4 applyRegionalCoverage(vec4 weather, const vec3 position, const float mipLevel, const float convectiveHeight) {
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
  cover.w = min(cover.w * convectiveProfile(convectiveHeight), 1.0);
  const vec4 thresholds = vec4(vec3(${COVERAGE_THRESHOLD.toFixed(6)}), ${coverageThreshold(CONVECTIVE_FILTER_WIDTH).toFixed(6)});
  vec4 offset = clamp(thresholds - (1.0 - cover), -1.0, 1.0);
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
  if (material.fragmentShader.includes(MARKER)) return true
  const signature =
    'WeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel) {'
  const apply = '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;'
  const heightScaleLine = '  vec4 heightScale = shapeAlteringFunction(weather.heightFraction, shapeAlteringBiases);'
  const detailLine = '    modifier = mix(vec4(0.0), modifier, shapeDetailAmounts);'
  const source = material.fragmentShader
  if (!source.includes(signature) || !source.includes(apply) || !source.includes(heightScaleLine)) return false
  material.fragmentShader = source
    .replace(
      signature,
      `${CHUNK}\nWeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel, const vec3 weatherPosition) {`
    )
    .replace(apply, `  localWeather = applyRegionalCoverage(localWeather, weatherPosition, mipLevel, weather.heightFraction.w);\n${apply}`)
    .replace(heightScaleLine, `${heightScaleLine}\n  heightScale.w = smoothstep(0.0, 0.05, weather.heightFraction.w);`)
    // The shadow pass has no detail noise; only patch where present.
    .replace(detailLine, `${detailLine}\n    modifier.w *= 1.0 - 0.85 * smoothstep(0.72, 0.84, weather.heightFraction.w);\n    modifier *= detailVariation(position, dot(weather.density, vec4(0.25)) * 4.0 / max(1.0, dot(step(vec4(0.001), weather.density), vec4(1.0))));`)
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
