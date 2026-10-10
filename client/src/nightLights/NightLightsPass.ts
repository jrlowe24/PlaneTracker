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
/** Grid for world-fixed procedural detail (windows, districts), meters. */
const CELL = 24

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
uniform float intensity;
uniform float roadGain;
uniform float pixelAngle;
uniform ivec3 cameraCell;
uniform vec3 cameraFraction;

// Street / airport light rasters (RoadLightTiles), two windows.
uniform sampler2DArray roadLights;
uniform highp sampler2DArray roadLamps;
uniform float lampGain;
uniform float roadTexelMeters[${ROAD_LEVELS}];
uniform float roadEnabled[${ROAD_LEVELS}];
uniform vec3 roadAnchor[${ROAD_LEVELS}];
uniform vec3 roadEast[${ROAD_LEVELS}];
uniform vec3 roadNorth[${ROAD_LEVELS}];
uniform vec4 roadMercator[${ROAD_LEVELS}];
uniform float roadCurvature[${ROAD_LEVELS}];
uniform float roadLayers[${ROAD_LEVELS * WINDOW * WINDOW}];

const float CELL = ${CELL.toFixed(1)};
const float WINDOW_SPACING = 3.2;
const float DETAIL_WINDOW = ${WINDOW_TILES.toFixed(1)};
const float ROAD_WINDOW = ${WINDOW.toFixed(1)};
const int TILE = ${ROAD_TILE_SIZE};
// Same table as LAMP_COLORS in roadRaster.worker.ts.
const vec3 LAMP_COLORS[8] = vec3[8](
  vec3(0.0), vec3(1.0, 0.42, 0.1), vec3(1.0, 0.68, 0.36), vec3(0.95, 0.85, 0.7),
  vec3(0.92, 0.94, 1.0), vec3(0.15, 1.0, 0.35), vec3(0.2, 0.35, 1.0), vec3(1.0, 0.08, 0.05));

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

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

/** Lit windows on facades (world-fixed grid, a fraction lit). */
float windows(const vec3 offset, const float footprint) {
  vec3 rel = (offset + cameraFraction) / WINDOW_SPACING + vec3(cameraCell) * (CELL / WINDOW_SPACING);
  vec3 base = floor(rel);
  uvec3 h = pcg3d(uvec3(ivec3(base)) + 7u);
  vec3 r = vec3(h & 0xffffu) / 65535.0;
  vec3 f = abs(rel - base - 0.5);
  float size = 0.22 + 0.5 * footprint / WINDOW_SPACING;
  float inside = 1.0 - smoothstep(size - 0.06, size, max(f.x, max(f.y, f.z)));
  return step(r.x, 0.12) * inside * (0.3 + 0.7 * r.y * r.y);
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
 * Lamps near this pixel drawn exactly: each texel cell holds at most one
 * lamp's precise position, so they're sharp points of a physical size
 * (~0.7 m, at least ~1.5 px) at any zoom, with a faint glow around them.
 */
vec3 nearLamps(const int level, const vec2 local, const float footprint) {
  float meters = roadTexelMeters[level];
  vec2 texel = local * float(TILE);
  ivec2 base = ivec2(floor(texel));
  float radius = max(0.35, 0.8 * footprint);
  float glowRadius = radius * 2.5;
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
      float d = length(texel - position) * meters;
      float core = exp(-d * d / (radius * radius));
      float glow = exp(-d * d / (glowRadius * glowRadius)) * 0.06;
      sum += LAMP_COLORS[index] * lamp.a * (core + glow);
    }
  }
  return sum;
}

/**
 * Light from one road window: pools (rgb), its lamps, and how much of the
 * pixel it covers (fading out over the outer quarter tile so the next
 * level takes over smoothly).
 */
vec4 roadLevel(const int level, const vec3 offset, const float footprint, out vec3 lamps) {
  lamps = vec3(0.0);
  if (roadEnabled[level] < 0.5) return vec4(0.0);
  vec2 local = roadLocal(level, offset);
  if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(ROAD_WINDOW)))) return vec4(0.0);
  float layer = roadLayer(level, ivec2(floor(local)));
  if (layer < 0.0) return vec4(0.0);
  // Gradients of the continuous coordinates: no mip spikes at tile seams.
  vec4 light = textureGrad(roadLights, vec3(fract(local), layer), dFdx(local), dFdy(local));
  // Far: lamp energy averaged by the mips, in the pools' color (white where
  // there are none, e.g. runway lights).
  float poolLuma = max(light.r, max(light.g, light.b));
  vec3 farColor = poolLuma > 0.004 ? light.rgb / poolLuma : vec3(0.92, 0.94, 1.0);
  vec3 far = farColor * light.a * 1.5;
  float meters = roadTexelMeters[level];
  float nearWeight = smoothstep(meters * 1.2, meters * 0.5, footprint);
  lamps = nearWeight > 0.0 ? mix(far, nearLamps(level, local, footprint), nearWeight) : far;
  float edge = min(min(local.x, local.y), min(ROAD_WINDOW - local.x, ROAD_WINDOW - local.y));
  return vec4(light.rgb, smoothstep(0.0, 0.25, edge));
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
  float footprint = length(offset) * pixelAngle;

  // OpenStreetMap streets, areas and airports, nearest window first. Kept
  // where the satellite map says the area is actually lit: rural roads and
  // farm tracks stay dark (MSFS lights them like suburbs).
  vec3 lampsA;
  vec3 lampsB;
  vec4 a = roadLevel(0, offset, footprint, lampsA);
  vec4 b = roadLevel(1, offset, footprint, lampsB);
  float covered = a.a + (1.0 - a.a) * b.a;
  float wb = (1.0 - a.a) * b.a;
  vec3 roads = a.rgb * a.a + b.rgb * wb;
  vec3 lamps = lampsA * a.a + lampsB * wb;
  float urban = smoothstep(0.08, 0.4, value);
  // Street light lands on the ground, not on walls: only on surfaces that
  // face up (normal from depth derivatives).
  vec3 normal = normalize(cross(dFdx(offset), dFdy(offset)));
  float upness = abs(dot(normal, up));
  vec3 emission = (roads * roadGain + lamps * lampGain) * urban * smoothstep(0.55, 0.85, upness);

  // Lit windows on facades up close.
  float lit = smoothstep(0.28, 0.85, value);
  float facade = smoothstep(0.3, 0.12, upness);
  float windowWeight = facade * smoothstep(2.0, 0.6, footprint);
  if (windowWeight > 0.0) {
    emission += vec3(1.0, 0.72, 0.42) * intensity * lit * windowWeight * 1.6 * windows(offset, footprint);
  }

  // Beyond the street windows, the satellite map's glow alone (off water);
  // it fades in with distance so uncovered ground nearby isn't a flat wash.
  float far = (1.0 - covered) * smoothstep(15.0, 300.0, footprint);
  float glow = intensity * lit * lit * 0.3 * (1.0 - waterScore(albedo.rgb));
  emission += far * glow * mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.78, 0.5), smoothstep(0.0, 0.006, glow));

  outColor = vec4(emission * night, 1.0);
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
 * - NASA Black Marble beyond them, and as the "is it lit" mask;
 * - procedural lit windows on facades up close.
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
        intensity: new Uniform(0.02),
        roadGain: new Uniform(0.016),
        pixelAngle: new Uniform(0.001),
        cameraCell: new Uniform(new Int32Array(3)),
        cameraFraction: new Uniform(new Vector3()),
        roadLights: new Uniform(null),
        roadLamps: new Uniform(null),
        lampGain: new Uniform(0.12),
        roadTexelMeters: new Uniform(new Float32Array(ROAD_LEVELS)),
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
    const x = Math.floor(position.x / CELL)
    const y = Math.floor(position.y / CELL)
    const z = Math.floor(position.z / CELL)
    this.u<Int32Array>('cameraCell').value.set([x, y, z])
    this.u<Vector3>('cameraFraction').value.set(position.x - x * CELL, position.y - y * CELL, position.z - z * CELL)
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
