import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import {
  DataTexture,
  Matrix4,
  PerspectiveCamera,
  Vector2 as DrawingBufferSize,
  RGBAFormat,
  Uniform,
  Vector2,
  Vector3,
  type Camera,
  type Texture,
  type WebGLRenderer
} from 'three'

const drawingBuffer = new DrawingBufferSize()
/** Procedural point-light grid: finest cell (m) and number of 2× levels. */
const CELL0 = 35
const GRID_LEVELS = 9

import { WINDOW_TILES } from './nightLightTiles'

const fragmentShader = /* glsl */ `
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
/** Angular size of a pixel (radians), for the ground footprint. */
uniform float pixelAngle;
uniform float pointGain;
/** Per grid level: camera cell index and position within it (CPU doubles). */
uniform ivec3 gridCameraCell[${GRID_LEVELS}];
uniform vec3 gridCameraFraction[${GRID_LEVELS}];
uniform sampler2D lightingMask;
uniform sampler2D cloudOverlay;

const float WINDOW = ${WINDOW_TILES.toFixed(1)};

const float CELL0 = 35.0;
const int LEVELS = ${GRID_LEVELS};

/** Camera-relative world offset (precise; no large ECEF values involved). */
vec3 offsetFromDepth(const vec2 uv, const float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = inverseProjection * ndc;
  view /= view.w;
  return mat3(cameraWorld) * view.xyz;
}

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

/**
 * Point lights of grid level k (cell = CELL0 * 2^k). Each cell holds one
 * candidate light; distance is measured in the tangent plane, so the light
 * is a vertical column that the ground (or a building) passes through.
 * Cell indices are integers anchored on the CPU in double precision.
 */
float pointLights(int k, vec3 offset, vec3 up, float footprint, float value) {
  float cell = CELL0 * exp2(float(k));
  vec3 rel = (offset + gridCameraFraction[k]) / cell;
  vec3 base = floor(rel);
  vec3 f = rel - base;
  uvec3 h = pcg3d(uvec3(ivec3(base) + gridCameraCell[k]));
  vec3 r = vec3(h & 0xffffu) / 65535.0;
  float lit = step(r.x, value * value * 0.8);
  vec3 center = vec3(0.3) + 0.4 * r;
  vec3 d = (f - center) * cell;
  d -= up * dot(d, up);
  // Lamp: ~1.5 px wide (at least 0.5 m); pool of light on the ground up close.
  float radius = clamp(1.5 * footprint, 0.5, 0.18 * cell);
  float d2 = dot(d, d);
  float lamp = exp(-d2 / (radius * radius));
  float pool = 0.08 * exp(-d2 / 36.0) * smoothstep(3.0, 0.5, footprint);
  return lit * (lamp + pool) * (0.5 + r.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (depth >= 0.9999999) return;
  vec3 offset = offsetFromDepth(uv, depth);
  vec3 p = cameraPositionECEF + offset;
  vec3 up = normalize(p);
  // Lights come on through civil twilight at each point on the ground.
  float night = smoothstep(0.06, -0.08, dot(up, sunDirection));
  if (night <= 0.0) return;

  // Geodetic-ish latitude (ECEF world, WGS84 e² ≈ 0.00669438).
  float lon = atan(p.y, p.x);
  float lat = atan(p.z, length(p.xy) * (1.0 - 0.00669438));
  vec2 deg = vec2(degrees(lon) + 180.0, 90.0 - degrees(lat));

  float value = texture(baseMap, deg / vec2(360.0, 180.0)).r;
  if (detailEnabled > 0.5) {
    vec2 t = deg / tileDegrees - detailOrigin;
    // Windows can straddle the antimeridian (origin.x < 0 or past the end).
    t.x = mod(t.x, columns);
    if (t.x >= 0.0 && t.y >= 0.0 && t.x < WINDOW && t.y < WINDOW) {
      ivec2 cell = ivec2(floor(t));
      float loaded = detailLoaded[cell.y * int(WINDOW) + cell.x];
      // Fade out toward the window edge so the base takes over smoothly.
      float edge = min(min(t.x, t.y), min(WINDOW - t.x, WINDOW - t.y));
      float weight = loaded * smoothstep(0.0, 0.75, edge);
      float detail = texture(detailMap, t / WINDOW).r;
      value = mix(value, detail, weight);
    }
  }
  if (value <= 0.02) return;

  float distance = length(offset);
  float footprint = distance * pixelAngle; // meters per pixel on the ground

  // Area glow: the NASA map itself (display-encoded gray; a steep curve so
  // only city cores glow and suburbs stay dim).
  float glow = pow(value, 3.0);

  // The ~600 m map is a soft blob up close, but a lit city is a field of
  // point lights. Scatter procedural lights on a world-fixed 3D grid whose
  // cell size follows the pixel footprint (~8 px per cell, 35 m at the
  // finest), lit with probability following the map. Two levels blend.
  float k = clamp(log2(footprint * 8.0 / CELL0), 0.0, float(LEVELS) - 1.001);
  int k0 = int(floor(k));
  float points = mix(pointLights(k0, offset, up, footprint, value),
                     pointLights(k0 + 1, offset, up, footprint, value),
                     fract(k));
  float pointsWeight = smoothstep(400.0, 150.0, footprint);
  // From orbit the glow is all there is; nearer, it is the faint sky-glow
  // and scattered light under the points.
  float glowGain = mix(0.25, 25.0, smoothstep(150.0, 3000.0, footprint));
  float radiance = intensity * (glow * glowGain + points * pointsWeight * pointGain);

  // Warm sodium in dim areas, whiter LED in bright cores.
  vec3 tint = mix(vec3(1.0, 0.5, 0.16), vec3(1.0, 0.83, 0.6), smoothstep(0.4, 0.95, value));

  // Atmospheric extinction along the view path (air mass from the ground
  // point toward the camera, capped by the actual distance).
  float mu = max(dot(up, -offset / distance), 0.03);
  float airPath = min(distance, 8000.0 / mu);
  float transmittance = exp(-airPath / 30000.0);

  // 0 on aircraft; edge texels blend, so require fully terrain.
  float terrain = smoothstep(0.9, 1.0, texture(lightingMask, uv).r);
  float clouds = texture(cloudOverlay, uv).a;  // clouds in front
  outputColor.rgb += tint * radiance * night * transmittance * terrain * (1.0 - clouds);
}
`

function solidTexture(r: number, g: number, b: number, a: number): DataTexture {
  const texture = new DataTexture(new Uint8Array([r, g, b, a]), 1, 1, RGBAFormat)
  texture.needsUpdate = true
  return texture
}

/**
 * Adds city lights (NASA Black Marble) after the atmosphere's lighting:
 * reconstructs each pixel's ECEF position from depth, looks up the light
 * map (detail window where loaded, global base elsewhere), fades lights in
 * with the local sun angle, and attenuates them by air mass, clouds in
 * front (atmosphere overlay alpha) and aircraft (lighting mask).
 */
export class NightLightsEffect extends Effect {
  private readonly white = solidTexture(255, 255, 255, 255)
  private readonly clear = solidTexture(0, 0, 0, 0)

  constructor(private camera: Camera) {
    super('NightLightsEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      // CONVOLUTION keeps this effect out of AerialPerspective's merged
      // pass: together they exceed the 16 texture units WebGL guarantees.
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ['baseMap', new Uniform(null)],
        ['detailMap', new Uniform(null)],
        ['detailLoaded', new Uniform(new Float32Array(WINDOW_TILES * WINDOW_TILES))],
        ['detailOrigin', new Uniform(new Vector2())],
        ['tileDegrees', new Uniform(2.8125)],
        ['columns', new Uniform(128)],
        ['detailEnabled', new Uniform(0)],
        ['inverseProjection', new Uniform(new Matrix4())],
        ['cameraWorld', new Uniform(new Matrix4())],
        ['cameraPositionECEF', new Uniform(new Vector3())],
        ['sunDirection', new Uniform(new Vector3())],
        ['intensity', new Uniform(0.0015)],
        ['pixelAngle', new Uniform(0.001)],
        ['pointGain', new Uniform(5)],
        ['gridCameraCell', new Uniform(new Int32Array(GRID_LEVELS * 3))],
        ['gridCameraFraction', new Uniform(Array.from({ length: GRID_LEVELS }, () => new Vector3()))],
        ['lightingMask', new Uniform(null)],
        ['cloudOverlay', new Uniform(null)]
      ])
    })
    this.uniform('lightingMask').value = this.white
    this.uniform('cloudOverlay').value = this.clear
  }

  private uniform<T>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>
  }

  override set mainCamera(camera: Camera) {
    this.camera = camera
  }

  setMaps(base: Texture | null, detail: Texture | null): void {
    this.uniform<Texture | null>('baseMap').value = base
    this.uniform<Texture | null>('detailMap').value = detail
  }

  setDetail(
    enabled: boolean,
    origin: { x: number; y: number },
    loaded: Float32Array,
    tileDegrees: number,
    columns: number
  ): void {
    this.uniform<number>('columns').value = columns
    this.uniform<number>('detailEnabled').value = enabled ? 1 : 0
    this.uniform<Vector2>('detailOrigin').value.set(origin.x, origin.y)
    this.uniform<Float32Array>('detailLoaded').value.set(loaded)
    this.uniform<number>('tileDegrees').value = tileDegrees
  }

  setSun(direction: Vector3): void {
    this.uniform<Vector3>('sunDirection').value.copy(direction)
  }

  setMasks(lightingMask: Texture | null, cloudOverlay: Texture | null): void {
    this.uniform<Texture>('lightingMask').value = lightingMask ?? this.white
    this.uniform<Texture>('cloudOverlay').value = cloudOverlay ?? this.clear
  }

  override update(renderer: WebGLRenderer): void {
    const camera = this.camera
    camera.updateMatrixWorld()
    if (camera instanceof PerspectiveCamera) {
      const height = renderer.getDrawingBufferSize(drawingBuffer).y
      this.uniform<number>('pixelAngle').value =
        (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height)
    }
    this.uniform<Matrix4>('inverseProjection').value.copy(camera.projectionMatrixInverse)
    this.uniform<Matrix4>('cameraWorld').value.copy(camera.matrixWorld)
    const position = this.uniform<Vector3>('cameraPositionECEF').value
    position.setFromMatrixPosition(camera.matrixWorld)
    const cells = this.uniform<Int32Array>('gridCameraCell').value
    const fractions = this.uniform<Vector3[]>('gridCameraFraction').value
    for (let k = 0; k < GRID_LEVELS; ++k) {
      const size = CELL0 * 2 ** k
      const x = Math.floor(position.x / size)
      const y = Math.floor(position.y / size)
      const z = Math.floor(position.z / size)
      cells.set([x, y, z], k * 3)
      fractions[k]!.set(position.x - x * size, position.y - y * size, position.z - z * size)
    }
  }

  override dispose(): void {
    this.white.dispose()
    this.clear.dispose()
    super.dispose()
  }
}
