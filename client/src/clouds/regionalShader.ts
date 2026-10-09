import { ecefToGeodetic, type WeatherGridCell } from '@windowseat/shared'
import { Uniform, Vector3, type ShaderMaterial, type Texture } from 'three'

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

const CHUNK = /* glsl */ `
${MARKER}
uniform sampler2D regionalCoverage;
uniform vec3 regionalAnchor;
uniform vec3 regionalEast;
uniform vec3 regionalNorth;
uniform float regionalRadius;
uniform float regionalEnabled;
uniform vec3 coverageFallback;

vec4 applyRegionalCoverage(vec4 weather, const vec3 position) {
  vec3 cover = coverageFallback;
  if (regionalEnabled > 0.5) {
    // Positions here are globe-centered (ECEF plus a small, mostly radial
    // altitude correction), so the east/north projection is unaffected.
    vec3 d = position - regionalAnchor;
    vec2 st = vec2(dot(d, regionalEast), dot(d, regionalNorth)) / (2.0 * regionalRadius) + 0.5;
    float edge = min(min(st.x, st.y), min(1.0 - st.x, 1.0 - st.y));
    vec3 regional = texture(regionalCoverage, clamp(st, 0.0, 1.0)).rgb;
    cover = mix(coverageFallback, regional, smoothstep(0.0, 0.08, edge));
  }
  weather.rgb = clamp(weather.rgb + (${COVERAGE_THRESHOLD.toFixed(6)} - (1.0 - cover)), 0.0, 1.0);
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
  coverageFallback: Uniform<Vector3>
}

export function createRegionalUniforms(regional: RegionalCoverage): RegionalUniforms {
  return {
    regionalCoverage: new Uniform(regional.texture),
    regionalAnchor: new Uniform(regional.anchor),
    regionalEast: new Uniform(regional.east),
    regionalNorth: new Uniform(regional.north),
    regionalRadius: new Uniform(REGION_RADIUS),
    regionalEnabled: new Uniform(0),
    coverageFallback: new Uniform(new Vector3())
  }
}

/** Patches a clouds/shadow material once; false if takram's shader changed. */
export function patchCloudsMaterial(material: ShaderMaterial, uniforms: RegionalUniforms): boolean {
  if (material.fragmentShader.includes(MARKER)) return true
  const signature =
    'WeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel) {'
  const apply = '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;'
  const source = material.fragmentShader
  if (!source.includes(signature) || !source.includes(apply)) return false
  material.fragmentShader = source
    .replace(
      signature,
      `${CHUNK}\nWeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel, const vec3 weatherPosition) {`
    )
    .replace(apply, `  localWeather = applyRegionalCoverage(localWeather, weatherPosition);\n${apply}`)
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
    fallback: [number, number, number]
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
