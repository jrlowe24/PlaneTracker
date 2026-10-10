import { Pass } from 'postprocessing'
import {
  GLSL3,
  HalfFloatType,
  Matrix4,
  PerspectiveCamera,
  ShaderMaterial,
  Uniform,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type DataArrayTexture,
  type Texture,
  type WebGLRenderer
} from 'three'

import { WINDOW_TILES } from './nightLightTiles'
import { ROAD_LEVELS, ROAD_TILE_SIZE, WINDOW, type RoadLevelUniforms } from './roadTiles'

const drawingBuffer = new Vector2()

const vertexShader = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D inputBuffer;
uniform sampler2D depthBuffer;
uniform vec2 texelSize;
uniform sampler2D baseMap;
uniform sampler2D detailMap;
uniform float detailLoaded[${WINDOW_TILES * WINDOW_TILES}];
uniform vec2 detailOrigin;
uniform float tileDegrees;
uniform float columns;
uniform float detailEnabled;
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
uniform vec3 cameraPositionECEF;
uniform vec3 sunDirection;
uniform float roadGain;
uniform float pixelAngle;

// Street / airport light rasters (RoadLightTiles), one window per level.
uniform sampler2DArray roadLights;
uniform highp sampler2DArray roadLamps;
uniform float lampGain;
uniform float roadTexelMeters[${ROAD_LEVELS}];
uniform vec2 roadOrigin[${ROAD_LEVELS}];
uniform float roadEnabled[${ROAD_LEVELS}];
uniform vec3 roadAnchor[${ROAD_LEVELS}];
uniform vec3 roadEast[${ROAD_LEVELS}];
uniform vec3 roadNorth[${ROAD_LEVELS}];
uniform vec4 roadMercator[${ROAD_LEVELS}];
uniform float roadCurvature[${ROAD_LEVELS}];
uniform float roadLayers[${ROAD_LEVELS * WINDOW * WINDOW}];

const float DETAIL_WINDOW = ${WINDOW_TILES.toFixed(1)};
const float ROAD_WINDOW = ${WINDOW.toFixed(1)};
const int TILE = ${ROAD_TILE_SIZE};
// Same table as LAMP_COLORS in roadRaster.worker.ts.
const vec3 LAMP_COLORS[9] = vec3[9](
  vec3(0.0), vec3(1.0, 0.42, 0.1), vec3(1.0, 0.68, 0.36), vec3(0.95, 0.85, 0.7),
  vec3(0.92, 0.94, 1.0), vec3(0.15, 1.0, 0.35), vec3(0.2, 0.35, 1.0), vec3(1.0, 0.08, 0.05),
  vec3(1.0, 0.96, 0.86));
/** Palette entries from here on are airfield lights. */
const int AIRFIELD = 5;

vec3 offsetFromDepth(const vec2 uv, const float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = inverseProjection * ndc;
  view /= view.w;
  return mat3(cameraWorld) * view.xyz;
}

/** NASA Black Marble brightness (display-encoded gray, 0…1). */
float lightMap(const vec3 p) {
  float lon = atan(p.y, p.x);
  float lat = atan(p.z, length(p.xy) * (1.0 - 0.00669438));
  vec2 deg = vec2(degrees(lon) + 180.0, 90.0 - degrees(lat));
  float value = texture(baseMap, deg / vec2(360.0, 180.0)).r;
  if (detailEnabled > 0.5) {
    vec2 t = deg / tileDegrees - detailOrigin;
    t.x = mod(t.x, columns);
    if (t.x >= 0.0 && t.y >= 0.0 && t.x < DETAIL_WINDOW && t.y < DETAIL_WINDOW) {
      ivec2 cell = ivec2(floor(t));
      float loaded = detailLoaded[cell.y * int(DETAIL_WINDOW) + cell.x];
      float edge = min(min(t.x, t.y), min(DETAIL_WINDOW - t.x, DETAIL_WINDOW - t.y));
      value = mix(value, texture(detailMap, t / DETAIL_WINDOW).r, loaded * smoothstep(0.0, 0.75, edge));
    }
  }
  return value;
}

float lightLuminance(const vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float waterScore(const vec3 albedo) {
  return smoothstep(-0.005, 0.02, albedo.b - albedo.r) * smoothstep(0.1, 0.03, lightLuminance(albedo));
}



/** Window tile coordinates of a camera-relative point (local Mercator). */
vec2 roadLocal(const int level, const vec3 offset) {
  vec3 d = offset - roadAnchor[level];
  float e = dot(d, roadEast[level]);
  float n = dot(d, roadNorth[level]);
  float t = n * roadCurvature[level];
  vec4 m = roadMercator[level];
  return vec2(m.x + m.z * e * (1.0 + t), m.y - m.w * n * (1.0 + 0.5 * t));
}

float roadLayer(const int level, const ivec2 cell) {
  if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(int(ROAD_WINDOW))))) return -1.0;
  return roadLayers[level * int(ROAD_WINDOW * ROAD_WINDOW) + cell.y * int(ROAD_WINDOW) + cell.x];
}

/**
 * A lamp is ~0.7 m. Farther away it's drawn at least about a pixel wide,
 * and dimmed as it grows, a little slower than its true share of the pixel
 * so distant cities still read as fields of lights (as they do to the eye,
 * through glare) rather than a lattice of full-brightness dots.
 */
float lampFade(const float radius) {
  return min(1.0, pow(0.5 / radius, 0.9));
}

/**
 * Lamps near this pixel drawn exactly: each texel cell holds at most one
 * lamp's precise position, so they're sharp points of a physical size
 * (~0.7 m, at least ~1.5 px) at any zoom, with a faint glow around them.
 */
vec3 nearLamps(const int level, const vec2 local, const float footprint, const vec3 dX, const vec3 dY) {
  float meters = roadTexelMeters[level];
  vec2 texel = local * float(TILE);
  ivec2 base = ivec2(floor(texel));
  // Screen pixels per texel offset: lamps are round on screen (they're
  // lights, not discs on the ground, which grazing views squash into
  // ovals) and sized in pixels.
  vec4 m = roadMercator[level];
  mat2 toTexel = float(TILE) * mat2(
    m.z * dot(dX, roadEast[level]), -m.w * dot(dX, roadNorth[level]),
    m.z * dot(dY, roadEast[level]), -m.w * dot(dY, roadNorth[level]));
  if (abs(determinant(toTexel)) < 1e-8) return vec3(0.0);
  mat2 toPixel = inverse(toTexel);
  // Fixture ~0.7 m; drawn at least ~1 px, dimmed as that outgrows it.
  float physical = 0.35 / max(footprint, 1e-3);
  float core = max(0.8, physical);
  float fade = min(1.0, pow(physical / 0.8, 0.9));
  // The 3x3 cell search reaches about a texel from this pixel in every
  // direction: radii (pixels) beyond that would be clipped into dashes
  // where a pixel spans a lot of ground (grazing views).
  float reach = max(0.6, meters / max(length(dX), length(dY)));
  vec3 sum = vec3(0.0);
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 c = base + ivec2(dx, dy);
      ivec2 cell = ivec2(floor(vec2(c) / float(TILE)));
      float layer = roadLayer(level, cell);
      if (layer < 0.0) continue;
      vec4 lamp = texelFetch(roadLamps, ivec3(c - cell * TILE, int(layer)), 0);
      int index = int(lamp.b * 255.0 + 0.5);
      if (index == 0) continue;
      vec2 position = vec2(c) + lamp.rg * (255.0 / 256.0) + 0.5 / 256.0;
      float d = length(toPixel * (position - texel));
      // Airfield lights are high-intensity, focused toward approaching
      // aircraft: much brighter, with a few pixels of glare, and they carry
      // farther.
      bool airfield = index >= AIRFIELD;
      float r = min(airfield ? max(0.8, physical * 0.6) : core, reach);
      float glare = min(r + 2.0, reach);
      float k = airfield ? sqrt(fade) : fade;
      float light = exp(-d * d / (r * r)) * (airfield ? 3.0 : 1.0) + exp(-d * d / (glare * glare)) * (airfield ? 0.3 : 0.06);
      sum += LAMP_COLORS[index] * lamp.a * k * light;
    }
  }
  return sum;
}

uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v;
}

/**
 * Residential streets where the street data has none (the coarse level
 * only carries main roads): one candidate lamp per texel cell of that
 * level (world-fixed cells), lit with a probability following how bright
 * NASA's map says the area is.
 */
vec3 carpet(const int level, const vec2 local, const float footprint, const float density) {
  float meters = roadTexelMeters[level];
  vec2 texel = local * float(TILE);
  ivec2 base = ivec2(floor(texel));
  ivec2 origin = ivec2(roadOrigin[level]) * TILE;
  float radius = max(0.35, 0.6 * footprint);
  float fade = lampFade(radius);
  vec3 sum = vec3(0.0);
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 c = base + ivec2(dx, dy);
      uvec2 h = pcg2d(uvec2(origin + c));
      vec2 r = vec2(h & 0xffffu) / 65535.0;
      if (r.x >= density) continue;
      vec2 position = vec2(c) + 0.15 + 0.7 * vec2(fract(r.y * 7.13), fract(r.y * 13.7));
      float d = length(texel - position) * meters;
      float i = 0.45 + 0.75 * fract(r.y * 31.1);
      vec3 color = fract(r.y * 3.7) < 0.55 ? LAMP_COLORS[1] : LAMP_COLORS[2];
      sum += color * i * fade * exp(-d * d / (radius * radius));
    }
  }
  return sum;
}

/**
 * One street level at this pixel: pools (rgb) and coverage (a: inside the
 * window and loaded, fading out over its outer quarter tile), and its
 * lamps, drawn as points.
 */
vec4 roadLevel(const int level, const vec3 offset, const float footprint, const vec3 dX, const vec3 dY, out vec3 lamps) {
  lamps = vec3(0.0);
  if (roadEnabled[level] < 0.5) return vec4(0.0);
  vec2 local = roadLocal(level, offset);
  if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(ROAD_WINDOW)))) return vec4(0.0);
  float layer = roadLayer(level, ivec2(floor(local)));
  if (layer < 0.0) return vec4(0.0);
  vec3 pools = texture(roadLights, vec3(fract(local), layer)).rgb;
  lamps = nearLamps(level, local, footprint, dX, dY);
  float edge = min(min(local.x, local.y), min(ROAD_WINDOW - local.x, ROAD_WINDOW - local.y));
  return vec4(pools, smoothstep(0.0, 0.25, edge));
}

void main() {
  outColor = vec4(0.0, 0.0, 0.0, 1.0);
  float depth = texture(depthBuffer, vUv).r;
  if (depth >= 0.9999999) return;
  vec4 albedo = texture(inputBuffer, vUv);
  vec3 offset = offsetFromDepth(vUv, depth);
  vec3 p = cameraPositionECEF + offset;
  vec3 up = normalize(p);
  float night = smoothstep(0.06, -0.08, dot(up, sunDirection));
  if (night <= 0.0) return;
  float value = lightMap(p);
  // Kept where the satellite map says the area is actually lit: rural
  // roads and farm tracks stay dark (MSFS lights them like suburbs).
  float urban = smoothstep(0.08, 0.4, value);
  if (urban <= 0.0) return;
  float footprint = length(offset) * pixelAngle;
  vec3 dX = dFdx(offset);
  vec3 dY = dFdy(offset);

  // Street levels by on-screen size: each 4x coarser than the previous,
  // used where its texels are about a pixel (no mipmaps needed), blending
  // into the next; a level that doesn't cover the pixel hands its share to
  // the next coarser one. At most two levels are sampled.
  float lod = clamp(log2(max(footprint, 1e-3) / (roadTexelMeters[0] * 1.5)) * 0.5, 0.0, float(${ROAD_LEVELS - 1}));
  int first = int(floor(lod));
  float remaining = 1.0;
  vec3 pools = vec3(0.0);
  vec3 lamps = vec3(0.0);
  float coarse = 0.0;
  for (int level = 0; level < ${ROAD_LEVELS}; ++level) {
    if (level < first || remaining <= 0.001) continue;
    float want = level == first ? 1.0 - fract(lod) : 1.0;
    vec3 levelLamps;
    vec4 s = roadLevel(level, offset, footprint, dX, dY, levelLamps);
    float w = min(remaining, want) * s.a;
    pools += s.rgb * w;
    lamps += levelLamps * w;
    if (level == ${ROAD_LEVELS - 1}) coarse = w;
    remaining -= w;
  }

  // Street light lands on the ground, not on walls: only on surfaces that
  // face up (normal from depth derivatives).
  vec3 normal = normalize(cross(dX, dY));
  float upness = abs(dot(normal, up));
  // Lamps are light sources; their pools light the surface, so they show
  // its own color (dark asphalt, markings, sidewalks) rather than glowing.
  vec3 lit = pools * roadGain * albedo.rgb + lamps * lampGain;

  // Residential carpet where only the coarse level's main roads are drawn,
  // and a faint glow beyond every window.
  float density = smoothstep(0.1, 0.6, value) * 0.6;
  float land = 1.0 - waterScore(albedo.rgb);
  if (coarse > 0.0) lit += carpet(${ROAD_LEVELS - 1}, roadLocal(${ROAD_LEVELS - 1}, offset), footprint, density) * lampGain * coarse * land;
  lit += vec3(1.0, 0.6, 0.25) * density * 0.04 * lampGain * remaining * land;

  outColor = vec4(lit * urban * smoothstep(0.35, 0.85, upness) * night, 1.0);
}
`

/**
 * Night light emission (linear RGB) into its own render target, read by
 * AerialPerspective (patched), which adds it to terrain radiance before
 * atmospheric transmittance and the cloud overlay, so lights dim through
 * haze and hide behind clouds. Sources:
 *
 * - streets, commercial areas and airports from OpenStreetMap
 *   (RoadLightTiles), lamp by lamp near the view;
 * - NASA Black Marble beyond them, and as the "is it lit" mask.
 */
export class NightLightsPass extends Pass {
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
  private readonly material: ShaderMaterial

  constructor(private viewCamera: Camera) {
    super('NightLightsPass')
    this.needsSwap = false
    this.needsDepthTexture = true
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        inputBuffer: new Uniform(null),
        depthBuffer: new Uniform(null),
        texelSize: new Uniform(new Vector2()),
        baseMap: new Uniform(null),
        detailMap: new Uniform(null),
        detailLoaded: new Uniform(new Float32Array(WINDOW_TILES * WINDOW_TILES)),
        detailOrigin: new Uniform(new Vector2()),
        tileDegrees: new Uniform(2.8125),
        columns: new Uniform(128),
        detailEnabled: new Uniform(0),
        inverseProjection: new Uniform(new Matrix4()),
        cameraWorld: new Uniform(new Matrix4()),
        cameraPositionECEF: new Uniform(new Vector3()),
        sunDirection: new Uniform(new Vector3()),
        roadGain: new Uniform(0.08),
        pixelAngle: new Uniform(0.001),
        roadLights: new Uniform(null),
        roadLamps: new Uniform(null),
        lampGain: new Uniform(0.12),
        roadTexelMeters: new Uniform(new Float32Array(ROAD_LEVELS)),
        roadOrigin: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector2())),
        roadEnabled: new Uniform(new Float32Array(ROAD_LEVELS)),
        roadAnchor: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector3())),
        roadEast: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector3())),
        roadNorth: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector3())),
        roadMercator: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector4())),
        roadCurvature: new Uniform(new Float32Array(ROAD_LEVELS)),
        roadLayers: new Uniform(new Float32Array(ROAD_LEVELS * WINDOW * WINDOW).fill(-1))
      }
    })
    this.fullscreenMaterial = this.material
  }

  private u<T>(name: string): { value: T } {
    return this.material.uniforms[name] as { value: T }
  }

  override set mainCamera(camera: Camera) {
    this.viewCamera = camera
  }

  get texture(): Texture {
    return this.target.texture
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.u<Texture | null>('depthBuffer').value = depthTexture
  }

  setMaps(base: Texture | null, detail: Texture | null): void {
    this.u<Texture | null>('baseMap').value = base
    this.u<Texture | null>('detailMap').value = detail
  }

  setDetail(enabled: boolean, origin: { x: number; y: number }, loaded: Float32Array, tileDegrees: number, columns: number): void {
    this.u<number>('columns').value = columns
    this.u<number>('detailEnabled').value = enabled ? 1 : 0
    this.u<Vector2>('detailOrigin').value.set(origin.x, origin.y)
    this.u<Float32Array>('detailLoaded').value.set(loaded)
    this.u<number>('tileDegrees').value = tileDegrees
  }

  setRoads(texture: DataArrayTexture, lamps: DataArrayTexture, levels: readonly RoadLevelUniforms[]): void {
    this.u<DataArrayTexture>('roadLights').value = texture
    this.u<DataArrayTexture>('roadLamps').value = lamps
    const enabled = this.u<Float32Array>('roadEnabled').value
    const layers = this.u<Float32Array>('roadLayers').value
    levels.forEach((level, i) => {
      enabled[i] = level.enabled ? 1 : 0
      this.u<Vector3[]>('roadAnchor').value[i]!.copy(level.anchor)
      this.u<Vector3[]>('roadEast').value[i]!.copy(level.east)
      this.u<Vector3[]>('roadNorth').value[i]!.copy(level.north)
      this.u<Vector4[]>('roadMercator').value[i]!.set(...level.mercator)
      this.u<Float32Array>('roadCurvature').value[i] = level.curvature
      this.u<Float32Array>('roadTexelMeters').value[i] = level.metersPerTexel
      this.u<Vector2[]>('roadOrigin').value[i]!.set(...level.origin)
      layers.set(level.layers, i * WINDOW * WINDOW)
    })
  }

  setSun(direction: Vector3): void {
    this.u<Vector3>('sunDirection').value.copy(direction)
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
    this.u<Vector2>('texelSize').value.set(1 / width, 1 / height)
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null): void {
    const camera = this.viewCamera
    camera.updateMatrixWorld()
    if (camera instanceof PerspectiveCamera) {
      const height = renderer.getDrawingBufferSize(drawingBuffer).y
      this.u<number>('pixelAngle').value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height)
    }
    this.u<Matrix4>('inverseProjection').value.copy(camera.projectionMatrixInverse)
    this.u<Matrix4>('cameraWorld').value.copy(camera.matrixWorld)
    const position = this.u<Vector3>('cameraPositionECEF').value
    position.setFromMatrixPosition(camera.matrixWorld)
    this.u<Texture | null>('inputBuffer').value = inputBuffer?.texture ?? null
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
  }

  override dispose(): void {
    super.dispose()
    this.target.dispose()
    this.material.dispose()
  }
}
