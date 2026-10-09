import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import {
  Matrix4,
  PerspectiveCamera,
  Uniform,
  Vector2,
  Vector3,
  type Camera,
  type Texture,
  type WebGLRenderer
} from 'three'

import { WINDOW_TILES } from './nightLightTiles'

const drawingBuffer = new Vector2()
/** Street-lamp grid spacing, meters. */
const LAMP_SPACING = 24

/**
 * Emission is handed to AerialPerspective in the alpha channel as alpha =
 * 1 − emission / NIGHT_LIGHT_MAX_EMISSION (effect passes clamp alpha to
 * [0, 1]). Terrain alpha is otherwise 1, so 1 means "no light".
 */
export const NIGHT_LIGHT_MAX_EMISSION = 0.1

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
/** Street-lamp grid: camera cell index and position within it (CPU doubles). */
uniform ivec3 lampCameraCell;
uniform vec3 lampCameraFraction;

const float LAMP_SPACING = ${LAMP_SPACING.toFixed(1)};
const float WINDOW_SPACING = 3.2;
const float WINDOW = ${WINDOW_TILES.toFixed(1)};

/** Camera-relative world offset (precise; no large ECEF values involved). */
vec3 offsetFromDepth(const vec2 uv, const float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = inverseProjection * ndc;
  view /= view.w;
  return mat3(cameraWorld) * view.xyz;
}

/** NASA Black Marble brightness (display-encoded gray, 0…1) at a position. */
float lightMap(const vec3 p) {
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
      value = mix(value, texture(detailMap, t / WINDOW).r, weight);
    }
  }
  return value;
}

float luminance(const vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/** Water-likeness of an albedo: dark and bluish. */
float waterScore(const vec3 albedo) {
  return smoothstep(-0.005, 0.02, albedo.b - albedo.r) * smoothstep(0.1, 0.03, luminance(albedo));
}

/**
 * Surface classes from the photo texture's own colors (unlit albedo at this
 * point in the chain): x = street-like (mid-dark grey asphalt next to
 * contrasting surfaces), y = other built-up (grey, brighter: roofs, lots),
 * z = local texture structure (0 on smooth or still-coarse tiles).
 * Water (dark, bluish) and vegetation (green) score zero.
 */
vec3 surfaceScore(const vec3 albedo, const vec2 uv) {
  float lum = luminance(albedo);
  float hi = max(albedo.r, max(albedo.g, albedo.b));
  float lo = min(albedo.r, min(albedo.g, albedo.b));
  float saturation = (hi - lo) / max(hi, 1e-4);
  float vegetation = smoothstep(0.005, 0.03, albedo.g - max(albedo.r, albedo.b));
  float grey = (1.0 - smoothstep(0.15, 0.4, saturation)) * (1.0 - waterScore(albedo)) * (1.0 - vegetation);
  // Local structure: streets and buildings are busy, water and fields smooth.
  vec2 d = 2.0 * texelSize;
  float around = 0.25 * (
    luminance(texture(inputBuffer, uv + vec2(d.x, 0.0)).rgb) +
    luminance(texture(inputBuffer, uv - vec2(d.x, 0.0)).rgb) +
    luminance(texture(inputBuffer, uv + vec2(0.0, d.y)).rgb) +
    luminance(texture(inputBuffer, uv - vec2(0.0, d.y)).rgb));
  float structure = smoothstep(0.03, 0.25, abs(lum - around) / (lum + around + 0.02));
  float road = grey * smoothstep(0.025, 0.05, lum) * smoothstep(0.17, 0.09, lum);
  float built = grey * smoothstep(0.09, 0.2, lum);
  return vec3(vec2(road, built) * (0.3 + 0.7 * structure), structure);
}

uvec3 pcg3d(uvec3 v);

/** Brightness variation between ~250 m districts (world-fixed, 0.35…1.4). */
float districtVariation(const vec3 offset) {
  vec3 rel = (offset + lampCameraFraction) / 256.0 + vec3(lampCameraCell) * (LAMP_SPACING / 256.0);
  uvec3 h = pcg3d(uvec3(ivec3(floor(rel))));
  return 0.35 + 1.05 * float(h.x & 0xffffu) / 65535.0;
}

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

/**
 * Street lamps: one candidate per cell of a world-fixed 3D grid
 * (LAMP_SPACING m; integer cells anchored on the CPU in double precision),
 * drawn as a small bright spot (≥ 1.5 px) with a pool of light around it.
 * Only shown where the surface reads as a street, so they line the roads.
 */
float lamps(const vec3 offset, const vec3 up, const float footprint) {
  vec3 rel = (offset + lampCameraFraction) / LAMP_SPACING;
  vec3 base = floor(rel);
  uvec3 h = pcg3d(uvec3(ivec3(base) + lampCameraCell));
  vec3 r = vec3(h & 0xffffu) / 65535.0;
  vec3 d = (rel - base - (0.3 + 0.4 * r)) * LAMP_SPACING;
  d -= up * dot(d, up);
  float d2 = dot(d, d);
  float radius = max(1.5 * footprint, 0.6);
  float spot = exp(-d2 / (radius * radius)) * min(1.0, 0.6 / radius) * 30.0;
  float pool = exp(-d2 / 64.0) * 0.6;
  return step(0.35, r.y) * (spot + pool);
}

/**
 * Lit windows on building facades: a world-fixed 3D grid of WINDOW_SPACING
 * m cells (anchored like the lamps), a fraction lit, each a small square.
 */
float windows(const vec3 offset, const float footprint) {
  vec3 rel = (offset + lampCameraFraction) / WINDOW_SPACING +
    vec3(lampCameraCell) * (LAMP_SPACING / WINDOW_SPACING);
  vec3 base = floor(rel);
  uvec3 h = pcg3d(uvec3(ivec3(base)) + 7u);
  vec3 r = vec3(h & 0xffffu) / 65535.0;
  vec3 f = abs(rel - base - 0.5);
  float size = 0.22 + 0.5 * footprint / WINDOW_SPACING;
  float inside = 1.0 - smoothstep(size - 0.06, size, max(f.x, max(f.y, f.z)));
  return step(r.x, 0.24) * inside * (0.4 + 0.9 * r.y * r.y);
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
  float value = lightMap(p);
  // The NASA map's dim floor (rural scatter, airglow, blur halo around
  // cities) stays dark: only genuinely lit areas emit.
  float lit = smoothstep(0.28, 0.85, value);
  if (lit <= 0.0) return;

  // Close up, light follows the streets and built surfaces in the imagery,
  // with individual lamps along streets; from far away (coarse tiles,
  // ground pixels of hundreds of meters) the map alone describes the glow,
  // still kept off water.
  float footprint = length(offset) * pixelAngle;
  vec3 surface = surfaceScore(inputColor.rgb, uv);
  // Streets glow, roofs barely; contrast curves keep it from reading as a
  // tinted photo. Districts vary (some blocks much brighter than others).
  float district = districtVariation(offset);
  // Thin street lines (only strongly street-like pixels), dim; the lamps
  // below carry most of the light, so ground between them stays dark.
  float near = district * (0.11 * smoothstep(0.4, 0.8, surface.x) + 0.01 * surface.y);
  float lampWeight = smoothstep(28.0, 6.0, footprint);
  if (lampWeight > 0.0) {
    // Only where the imagery shows real street structure: coarse tiles
    // still loading are smooth, and a lamp grid on them reads as dots.
    near += lampWeight * smoothstep(0.15, 0.45, surface.x) * smoothstep(0.25, 0.55, surface.z) *
      lamps(offset, up, footprint);
  }
  // Facades (surface normal from depth derivatives, near-horizontal) get
  // lit windows up close.
  vec3 normal = normalize(cross(dFdx(offset), dFdy(offset)));
  float facade = smoothstep(0.3, 0.12, abs(dot(normal, up)));
  float windowWeight = facade * smoothstep(2.0, 0.6, footprint);
  if (windowWeight > 0.0) near += windowWeight * 1.6 * windows(offset, footprint);
  float far = smoothstep(120.0, 1200.0, footprint);
  float shape = mix(near, 0.3 * (1.0 - waterScore(inputColor.rgb)), far);
  // Steep curve on the map so cores dominate and suburbs stay dim.
  float emission = intensity * lit * lit * shape * night;
  outputColor.a = 1.0 - min(emission / ${NIGHT_LIGHT_MAX_EMISSION.toFixed(3)}, 1.0);
}
`

/**
 * City lights (NASA Black Marble), shaped by the imagery: runs before
 * AerialPerspective on the unlit photo texture and passes emitted radiance
 * to it in the alpha channel. AerialPerspective adds it to post-lit terrain
 * (not aircraft) before atmospheric transmittance and the cloud overlay, so
 * lights dim through haze and hide behind clouds naturally.
 */
export class NightLightsEffect extends Effect {
  constructor(private camera: Camera) {
    super('NightLightsEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      // Own pass: it must run before AerialPerspective (which reads the
      // emission), and merged they'd exceed WebGL's 16 texture units.
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
        ['intensity', new Uniform(0.02)],
        ['pixelAngle', new Uniform(0.001)],
        ['lampCameraCell', new Uniform(new Int32Array(3))],
        ['lampCameraFraction', new Uniform(new Vector3())]
      ])
    })
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
    const x = Math.floor(position.x / LAMP_SPACING)
    const y = Math.floor(position.y / LAMP_SPACING)
    const z = Math.floor(position.z / LAMP_SPACING)
    this.uniform<Int32Array>('lampCameraCell').value.set([x, y, z])
    this.uniform<Vector3>('lampCameraFraction').value.set(
      position.x - x * LAMP_SPACING,
      position.y - y * LAMP_SPACING,
      position.z - z * LAMP_SPACING
    )
  }
}
