import type { AerialPerspectiveEffect } from '@takram/three-atmosphere'
import { ecefToGeodetic, geoidHeight } from '@windowseat/shared'
import {
  Uniform,
  Vector3,
  Vector4,
  type DataArrayTexture
} from 'three'

import {
  MAX_WINDOW,
  ROAD_LEVELS,
  ROAD_TILE_SIZE,
  type RoadLevelUniforms,
  type RoadLightTiles
} from '../nightLights/roadTiles'

const MARKER = '/* window-seat semantic water */'
const STRIDE = MAX_WINDOW * MAX_WINDOW
let reportedEnabled = false
const seaLevelAnchor = new Vector3()
let seaLevelInitialized = false

const uniforms = {
  waterMaterialEnabled: new Uniform(0),
  waterTime: new Uniform(0),
  /** Mean sea level above WGS84, in Takram atmosphere kilometres. */
  waterSeaLevel: new Uniform(0),
  waterNightAmbient: new Uniform(new Vector3()),
  waterTileMap: new Uniform<DataArrayTexture | null>(null),
  waterTileEnabled: new Uniform(new Float32Array(ROAD_LEVELS)),
  waterTileAnchor: new Uniform(
    Array.from({ length: ROAD_LEVELS }, () => new Vector3())
  ),
  waterTileEast: new Uniform(
    Array.from({ length: ROAD_LEVELS }, () => new Vector3())
  ),
  waterTileNorth: new Uniform(
    Array.from({ length: ROAD_LEVELS }, () => new Vector3())
  ),
  waterTileMercator: new Uniform(
    Array.from({ length: ROAD_LEVELS }, () => new Vector4())
  ),
  waterTileCurvature: new Uniform(new Float32Array(ROAD_LEVELS)),
  waterTileLayers: new Uniform(
    new Float32Array(ROAD_LEVELS * STRIDE).fill(-1)
  ),
  waterTileFade: new Uniform(new Float32Array(ROAD_LEVELS * STRIDE)),
  waterTileWindow: new Uniform(new Float32Array(ROAD_LEVELS))
}

const CHUNK = /* glsl */ `
${MARKER}
uniform float waterMaterialEnabled;
uniform float waterTime;
uniform float waterSeaLevel;
uniform vec3 waterNightAmbient;
uniform sampler2DArray waterTileMap;
uniform float waterTileEnabled[${ROAD_LEVELS}];
uniform vec3 waterTileAnchor[${ROAD_LEVELS}];
uniform vec3 waterTileEast[${ROAD_LEVELS}];
uniform vec3 waterTileNorth[${ROAD_LEVELS}];
uniform vec4 waterTileMercator[${ROAD_LEVELS}];
uniform float waterTileCurvature[${ROAD_LEVELS}];
uniform float waterTileLayers[${ROAD_LEVELS * STRIDE}];
uniform float waterTileFade[${ROAD_LEVELS * STRIDE}];
uniform float waterTileWindow[${ROAD_LEVELS}];

const int WATER_TILE_STRIDE = ${STRIDE};
const int WATER_TILE_SIZE = ${ROAD_TILE_SIZE};

vec2 waterTileLocal(const int level, const vec3 offset) {
  vec3 d = offset - waterTileAnchor[level];
  float east = dot(d, waterTileEast[level]);
  float north = dot(d, waterTileNorth[level]);
  float curvature = north * waterTileCurvature[level];
  vec4 mercator = waterTileMercator[level];
  return vec2(
    mercator.x + mercator.z * east * (1.0 + curvature),
    mercator.y - mercator.w * north * (1.0 + 0.5 * curvature)
  );
}

float waterTileLayer(const int level, const ivec2 cell) {
  int window = int(waterTileWindow[level]);
  if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(window)))) {
    return -1.0;
  }
  return waterTileLayers[level * WATER_TILE_STRIDE + cell.y * window + cell.x];
}

/** First camera-ray intersection with the local mean-sea-level ellipsoid. */
bool flatWaterSurface(out vec3 positionECEF, out vec3 normalECEF) {
  vec3 radii = sqrt(vEllipsoidRadiiSquared) + vec3(waterSeaLevel);
  vec3 inverseRadiiSquared = 1.0 / (radii * radii);
  vec3 direction = normalize(vRayDirection);
  float a = dot(direction * direction, inverseRadiiSquared);
  float b = 2.0 * dot(vCameraPosition * direction, inverseRadiiSquared);
  float c = dot(vCameraPosition * vCameraPosition, inverseRadiiSquared) - 1.0;
  float discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) return false;
  float root = sqrt(discriminant);
  float nearDistance = (-b - root) / (2.0 * a);
  float farDistance = (-b + root) / (2.0 * a);
  float distance = nearDistance > 0.0 ? nearDistance : farDistance;
  if (distance <= 0.0) return false;
  positionECEF = vCameraPosition + direction * distance;
  normalECEF = normalize(positionECEF * inverseRadiiSquared);
  return true;
}

/**
 * Preserve real structures over mapped water while flattening blue/neutral
 * photogrammetry tears. The color test is safe here because semantic map
 * data has already limited it to a water polygon.
 */
float photographedWaterShare(
  const vec3 actualPosition,
  const vec3 flatPosition,
  const vec3 flatNormal,
  const vec3 albedo
) {
  float aboveMeters = dot(actualPosition - flatPosition, flatNormal)
    / METER_TO_LENGTH_UNIT;
  float luminance = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  float chroma = max(albedo.r, max(albedo.g, albedo.b))
    - min(albedo.r, min(albedo.g, albedo.b));
  float blueWater = smoothstep(-0.015, 0.055, albedo.b - max(albedo.r, albedo.g));
  float neutralWater = (1.0 - smoothstep(0.2, 0.55, luminance))
    * (1.0 - smoothstep(0.04, 0.2, chroma));
  float looksLikeWater = max(blueWater, neutralWater);
  float raisedStructure = smoothstep(1.5, 7.0, aboveMeters)
    * (1.0 - looksLikeWater);
  return 1.0 - raisedStructure;
}

/**
 * Samples actual OSM water polygons/ways. A loaded fine tile owns its area
 * even when it says "land", so a coarser shoreline cannot leak through it.
 */
float semanticWaterCoverage(
  const vec3 positionECEF,
  const vec2 screenUv
) {
  if (waterMaterialEnabled < 0.5) return 0.0;
  #ifdef HAS_LIGHTING_MASK
  if (texture(lightingMaskBuffer, screenUv).LIGHTING_MASK_CHANNEL_ < 0.5) return 0.0;
  #endif
  // Takram's atmosphere coordinates are kilometres; the tile windows are
  // built in Three/geospatial world metres (the same space as road lights).
  vec3 offset = (positionECEF - vCameraPosition) / METER_TO_LENGTH_UNIT;
  float result = 0.0;
  float ownership = 0.0;
  for (int level = 0; level < ${ROAD_LEVELS}; ++level) {
    if (waterTileEnabled[level] < 0.5 || ownership > 0.999) continue;
    vec2 local = waterTileLocal(level, offset);
    float window = waterTileWindow[level];
    if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(window)))) continue;
    ivec2 cell = ivec2(floor(local));
    float layer = waterTileLayer(level, cell);
    if (layer < 0.0) continue;
    float edge = min(min(local.x, local.y), min(window - local.x, window - local.y));
    float fade = waterTileFade[level * WATER_TILE_STRIDE + cell.y * int(window) + cell.x]
      * smoothstep(0.0, 0.2, edge);
    float take = (1.0 - ownership) * fade;
    result += texture(waterTileMap, vec3(fract(local), layer)).r * take;
    ownership += take;
  }
  return smoothstep(0.12, 0.88, result);
}

/** Small animated waves in a globe-local tangent frame. */
vec3 waterWaveNormal(const vec3 positionECEF) {
  vec3 up = normalize(positionECEF);
  vec3 east = abs(up.z) < 0.999
    ? normalize(vec3(-up.y, up.x, 0.0))
    : vec3(0.0, 1.0, 0.0);
  vec3 north = normalize(cross(up, east));
  float latitude = asin(clamp(up.z, -1.0, 1.0));
  float longitude = atan(up.y, up.x);
  vec2 p = vec2(longitude * cos(latitude), latitude)
    * (bottomRadius / METER_TO_LENGTH_UNIT);

  vec2 d0 = normalize(vec2(1.0, 0.31));
  vec2 d1 = normalize(vec2(-0.24, 1.0));
  vec2 d2 = normalize(vec2(0.67, -0.74));
  vec2 slope = d0 * sin(dot(p, d0) * 0.035 + waterTime * 0.7) * 0.08;
  slope += d1 * sin(dot(p, d1) * 0.11 - waterTime * 1.15) * 0.045;
  slope += d2 * sin(dot(p, d2) * 0.31 + waterTime * 1.8) * 0.018;
  return normalize(up - east * slope.x - north * slope.y);
}

/** Diffuse subsurface color, sky reflection and a narrow solar glint. */
vec3 waterSurfaceRadiance(
  const vec3 positionECEF,
  const vec3 waterNormal,
  const float sunTransmittance
) {
  vec3 skyIrradiance;
  vec3 sunIrradiance = GetSunAndSkyIrradiance(
    positionECEF,
    waterNormal,
    sunDirection,
    skyIrradiance
  ) * sunTransmittance;
  vec3 viewDirection = normalize(vCameraPosition - positionECEF);
  float nDotV = max(0.0, dot(waterNormal, viewDirection));
  float fresnel = 0.02 + 0.98 * pow(1.0 - nDotV, 5.0);
  vec3 deepWater = vec3(0.006, 0.025, 0.035);
  vec3 radiance = deepWater * albedoScale * RECIPROCAL_PI
    * (skyIrradiance + sunIrradiance * 0.06);
  radiance += skyIrradiance * RECIPROCAL_PI * (0.018 + fresnel * 0.16);
  float sunUp = smoothstep(-0.02, 0.08, dot(normalize(positionECEF), sunDirection));
  float glint = pow(
    max(0.0, dot(reflect(-sunDirection, waterNormal), viewDirection)),
    700.0
  );
  radiance += sunIrradiance * glint * sunUp * (0.4 + fresnel * 2.4);
  radiance += deepWater * albedoScale * RECIPROCAL_PI * waterNightAmbient;
  return radiance;
}
`

function installUniforms(effect: AerialPerspectiveEffect): void {
  for (const [name, uniform] of Object.entries(uniforms)) {
    effect.uniforms.set(name, uniform)
  }
}

/** Adds semantic, procedural water to the terrain-lighting stage. */
export function patchWaterSurface(effect: AerialPerspectiveEffect): boolean {
  const source = effect.getFragmentShader()
  if (source == null) return false
  if (source.includes(MARKER)) {
    installUniforms(effect)
    return true
  }
  const lighting =
    'radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);'
  const skyComposite =
    '    #ifdef HAS_OVERLAY\n    outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;\n    #endif // HAS_OVERLAY\n    return;\n  }\n  depth = reverseLogDepth(depth, cameraNear, cameraFar);'
  if (
    !source.includes('void mainImage(') ||
    !source.includes(lighting) ||
    !source.includes(skyComposite)
  ) return false
  let shader = source
    .replace('void mainImage(', `${CHUNK}\nvoid mainImage(`)
    // A missing/torn photogrammetry surface reports sky depth. Fill it from
    // the same sea-level reconstruction before clouds are composited.
    .replace(
      skyComposite,
      `    vec3 skyWaterPosition;\n    vec3 skyWaterNormal;\n    if (flatWaterSurface(skyWaterPosition, skyWaterNormal)) {\n      float skyWater = semanticWaterCoverage(skyWaterPosition, uv);\n      if (skyWater > 0.0) {\n        vec3 skyWaterRadiance = waterSurfaceRadiance(\n          skyWaterPosition,\n          waterWaveNormal(skyWaterPosition),\n          1.0\n        );\n        #if defined(TRANSMITTANCE) || defined(INSCATTER)\n        applyTransmittanceInscatter(skyWaterPosition, shadowLength, skyWaterRadiance);\n        #endif\n        if (!any(isnan(skyWaterRadiance)) && !any(isinf(skyWaterRadiance))) {\n          outputColor.rgb = mix(outputColor.rgb, skyWaterRadiance, skyWater);\n        }\n      }\n    }\n\n${skyComposite}`
    )
    .replace(
      lighting,
      `${lighting}\n    vec3 flatWaterPosition;\n    vec3 flatWaterNormal;\n    float semanticWater = 0.0;\n    if (flatWaterSurface(flatWaterPosition, flatWaterNormal)) {\n      semanticWater = semanticWaterCoverage(flatWaterPosition, uv)\n        * photographedWaterShare(\n          positionECEF,\n          flatWaterPosition,\n          flatWaterNormal,\n          inputColor.rgb\n        );\n      if (semanticWater > 0.0) {\n        vec3 waterRadiance = waterSurfaceRadiance(\n          flatWaterPosition,\n          waterWaveNormal(flatWaterPosition),\n          sunTransmittance\n        );\n        if (!any(isnan(waterRadiance)) && !any(isinf(waterRadiance))) {\n          radiance = mix(radiance, waterRadiance, semanticWater);\n          // Atmospheric distance and haze now end at the flat water plane,\n          // not at the torn photogrammetry triangle that happened to win depth.\n          positionECEF = mix(positionECEF, flatWaterPosition, semanticWater);\n        }\n      }\n    }`
    )
  // patchNightLight runs first. Keep its ambient term, but do not reintroduce
  // the photographed tile color after semantic water replaced the surface.
  shader = shader.replace(
    'radiance += inputColor.rgb * albedoScale * RECIPROCAL_PI * nightAmbient;',
    'radiance += inputColor.rgb * albedoScale * RECIPROCAL_PI * nightAmbient * (1.0 - semanticWater);'
  )
  if (
    !shader.includes('float semanticWater =') ||
    !shader.includes('flatWaterSurface(') ||
    !shader.includes('skyWaterRadiance')
  ) {
    return false
  }
  installUniforms(effect)
  ;(effect as unknown as { setFragmentShader: (source: string) => void }).setFragmentShader(shader)
  return true
}

function updateLevels(levels: readonly RoadLevelUniforms[]): void {
  const enabled = uniforms.waterTileEnabled.value
  const layers = uniforms.waterTileLayers.value
  const fades = uniforms.waterTileFade.value
  enabled.fill(0)
  layers.fill(-1)
  fades.fill(0)
  levels.forEach((level, i) => {
    enabled[i] = level.enabled ? 1 : 0
    uniforms.waterTileAnchor.value[i]!.copy(level.anchor)
    uniforms.waterTileEast.value[i]!.copy(level.east)
    uniforms.waterTileNorth.value[i]!.copy(level.north)
    uniforms.waterTileMercator.value[i]!.set(...level.mercator)
    uniforms.waterTileCurvature.value[i] = level.curvature
    uniforms.waterTileWindow.value[i] = level.window
    layers.set(level.layers, i * STRIDE)
    fades.set(level.fade, i * STRIDE)
  })
}

/** Binds the currently streamed vector-tile window to the water shader. */
export function updateWaterSurface(
  roads: RoadLightTiles | null,
  enabled: boolean,
  delta: number,
  cameraPosition: Vector3,
  nightAmbient: Vector3
): void {
  uniforms.waterTime.value += Math.min(delta, 0.1)
  if (!seaLevelInitialized || seaLevelAnchor.distanceToSquared(cameraPosition) > 50_000 ** 2) {
    seaLevelInitialized = true
    seaLevelAnchor.copy(cameraPosition)
    const geodetic = ecefToGeodetic(cameraPosition.x, cameraPosition.y, cameraPosition.z)
    uniforms.waterSeaLevel.value = geoidHeight(geodetic.lat, geodetic.lon) / 1000
  }
  uniforms.waterNightAmbient.value.copy(nightAmbient)
  uniforms.waterTileMap.value = roads?.water ?? null
  uniforms.waterMaterialEnabled.value = enabled && roads?.available === true ? 1 : 0
  if (roads == null) updateLevels([])
  else updateLevels(roads.levels.map(level => level.uniforms))
  if (import.meta.env.DEV) {
    if (uniforms.waterMaterialEnabled.value === 1 && !reportedEnabled) {
      reportedEnabled = true
      console.info('[water] semantic material enabled on atmosphere pass')
    }
    ;(window as unknown as { __windowSeatWater?: unknown }).__windowSeatWater = {
      enabled: uniforms.waterMaterialEnabled.value === 1,
      available: roads?.available ?? false,
      loadedTiles:
        roads?.levels.map(level => level.slots.filter(slot => slot.loaded).length) ?? []
    }
  }
}
