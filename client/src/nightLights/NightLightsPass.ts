import { MipmapBlurPass, Pass } from 'postprocessing'
import {
  CustomBlending,
  OneFactor,
  ZeroFactor,
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
import { MAX_WINDOW, ROAD_LEVELS, ROAD_TILE_SIZE, type RoadLevelUniforms } from './roadTiles'
import { MAX_RUNWAYS, type RunwayUniforms } from './runwayLights'
import { lightBeams, MAX_LIGHT_BEAMS } from '../aircraft/navLightsStore'

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
/** Airfield lighting on by day (dusk, low overcast), 0 … 1. */
uniform float airfieldOn;
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
uniform float roadLayers[${ROAD_LEVELS * MAX_WINDOW * MAX_WINDOW}];
uniform float roadFade[${ROAD_LEVELS * MAX_WINDOW * MAX_WINDOW}];
/** Tiles per side of each level's window. */
uniform float roadWindow[${ROAD_LEVELS}];
// Buildings of the finest street level's tiles: R = height / 2 m,
// G = random byte per building (RoadLightTiles.buildings).
uniform highp sampler2DArray buildingMap;
uniform float windowGain;
/** Share of lit windows now (by the hour at the view): homes, offices. */
uniform vec2 windowShares;
uniform int runwayCount;
uniform vec4 runwayOrigin[${MAX_RUNWAYS}];
uniform vec4 runwayAlong[${MAX_RUNWAYS}];
uniform vec4 runwayAcross[${MAX_RUNWAYS}];
uniform vec4 runwayApproach[${MAX_RUNWAYS}];
uniform int beamCount;
uniform vec4 beamPosition[${MAX_LIGHT_BEAMS}];
uniform vec4 beamDirection[${MAX_LIGHT_BEAMS}];

const float DETAIL_WINDOW = ${WINDOW_TILES.toFixed(1)};
const int ROAD_STRIDE = ${MAX_WINDOW * MAX_WINDOW};
const int TILE = ${ROAD_TILE_SIZE};
// Same table as LAMP_COLORS in roadRaster.worker.ts.
const vec3 LAMP_COLORS[9] = vec3[9](
  vec3(0.0), vec3(1.0, 0.42, 0.1), vec3(1.0, 0.68, 0.36), vec3(0.95, 0.85, 0.7),
  vec3(0.92, 0.94, 1.0), vec3(0.15, 1.0, 0.35), vec3(0.2, 0.35, 1.0), vec3(1.0, 0.08, 0.05),
  vec3(1.0, 0.96, 0.86));
/** Palette entries from here on are airfield lights. */
const int AIRFIELD = 5;
/** Least brightness of an airfield light however far (before glow). */
const float AIRFIELD_FLOOR = 0.12;


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
  int w = int(roadWindow[level]);
  if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(w)))) return -1.0;
  return roadLayers[level * ROAD_STRIDE + cell.y * w + cell.x];
}

/**
 * Brightness of a lamp drawn bigger than it is, share = its true size
 * over its drawn size. Slower than its true share (share²) so lamps stay
 * visible; steeper again far away (share < 0.1, a pixel spanning tens of
 * meters), where lamps at their true spacing fill every pixel along a road
 * and the slow falloff turned streets into a glowing map.
 */
float distantFade(const float share) {
  return min(1.0, pow(share, 0.6) * pow(min(1.0, share / 0.1), 0.7));
}

/**
 * Airfield lamp brightness at a footprint share (true size / drawn size):
 * fades slower than street lamps (runways stay readable from afar) but
 * does fade, and loses its close-up boost far away. Held at 0.45 with the
 * full boost, far rows merged into solid, glaring outlines.
 */
float airfieldK(const float share) {
  return max(AIRFIELD_FLOOR, pow(distantFade(share), 0.75));
}
float airfieldBoost(const float share) {
  return mix(1.0, 1.8, smoothstep(0.05, 0.4, share));
}

/**
 * A lamp is ~0.7 m. Farther away it's drawn at least about a pixel wide,
 * and dimmed as it grows, a little slower than its true share of the pixel
 * so distant cities still read as fields of lights (as they do to the eye,
 * through glare) rather than a lattice of full-brightness dots.
 * (Steeper far away: see distantFade.)
 */
/** Share of a lamp's drawn light that glows: all of it within a few km. */
float glowShare(const float share) {
  return pow(min(1.0, share / 0.15), 1.4);
}

uvec2 pcg2d(uvec2 v);
const int QUIET_FLAG = 16;
/** 0 in busy areas … 1 in quiet ones (NASA's map), set per pixel. */
float quietness;

/** Narrowest lamp drawn (pixels, gaussian radius). */
const float MIN_LAMP_PIXELS = 1.1;
float sq(const float x) { return x * x; }

float lampFade(const float radius) {
  float share = 0.5 / radius;
  return min(1.0, pow(share, 0.9) * pow(min(1.0, share / 0.1), 0.7));
}

/**
 * Lamps near this pixel drawn exactly: each texel cell holds at most one
 * lamp's precise position, so they're sharp points of a physical size
 * (~0.7 m, at least ~1.5 px) at any zoom, with a faint glow around them.
 */
vec3 nearLamps(const int level, const vec2 local, const float footprint, const vec3 dX, const vec3 dY, out vec3 field) {
  field = vec3(0.0);
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
  // Never narrower than MIN_LAMP_PIXELS: a smaller dot is bright on a pixel
  // center and gone between them, so distant lamps twinkled as the camera
  // moved. Widened lamps are dimmed to keep the same light.
  float core = max(MIN_LAMP_PIXELS, physical);
  float fade = distantFade(physical / 0.8) * sq(max(0.8, physical) / core);
  // The 3x3 cell search reaches about a texel from this pixel in every
  // direction: radii (pixels) beyond that would be clipped into dashes
  // where a pixel spans a lot of ground (grazing views).
  float reach = max(0.6, meters / max(length(dX), length(dY)));
  vec3 sum = vec3(0.0);
  float cover = 0.0;
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 c = base + ivec2(dx, dy);
      ivec2 cell = ivec2(floor(vec2(c) / float(TILE)));
      float layer = roadLayer(level, cell);
      if (layer < 0.0) continue;
      vec4 lamp = texelFetch(roadLamps, ivec3(c - cell * TILE, int(layer)), 0);
      int index = int(lamp.b * 255.0 + 0.5);
      if (index == 0) continue;
      // Quiet-street lamps (residential, service): fewer where NASA's map
      // says the area is quiet, by a world-fixed per-lamp hash.
      if (index >= QUIET_FLAG) {
        index -= QUIET_FLAG;
        uvec2 h = pcg2d(uvec2(ivec2(roadOrigin[level]) * TILE + c));
        if (float(h.x & 0xffffu) / 65535.0 < quietness * 0.6) continue;
      }
      vec2 position = vec2(c) + lamp.rg * (255.0 / 256.0) + 0.5 / 256.0;
      float d = length(toPixel * (position - texel));
      // Airfield lights are high-intensity, focused toward approaching
      // aircraft: much brighter, with a few pixels of glare, and they carry
      // farther.
      bool airfield = index >= AIRFIELD;
      float r = min(airfield ? max(MIN_LAMP_PIXELS, physical * 0.6) : core, reach);
      float glare = min(r + 2.0, reach);
      // Airfield lights (taxiways here; runways are drawn exactly) fade
      // slower than streets, so they read from farther off (airfieldK).
      float k = airfield ? airfieldK(physical / 0.8) * sq(max(0.8, physical * 0.6) / max(MIN_LAMP_PIXELS, physical * 0.6)) : fade;
      float spot = exp(-d * d / (r * r));
      float light = spot * (airfield ? airfieldBoost(physical / 0.8) : 1.0) + exp(-d * d / (glare * glare)) * (airfield ? 0.08 : 0.06);
      vec3 contribution = LAMP_COLORS[index] * lamp.a * k * light;
      if (airfield) field += contribution;
      else sum += contribution;
      cover += spot;
    }
  }
  // Lamps overlapping on screen (far away, rows of airfield lights seen
  // end-on) don't add up: their number per pixel grows faster with
  // distance than each one dims, which made distant runways and roads
  // brighter than near ones. Overlaps blend to the lamps' own brightness.
  field /= max(1.0, cover);
  return sum / max(1.0, cover);
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
vec3 carpet(const int level, const vec2 local, const float footprint, const float density, const vec3 dX, const vec3 dY) {
  vec2 texel = local * float(TILE);
  ivec2 base = ivec2(floor(texel));
  ivec2 origin = ivec2(roadOrigin[level]) * TILE;
  // Sized on screen (pixels, like nearLamps): measured on the ground, the
  // dots shrank to slivers at grazing angles and twinkled in motion.
  vec4 m = roadMercator[level];
  mat2 toTexel = float(TILE) * mat2(
    m.z * dot(dX, roadEast[level]), -m.w * dot(dX, roadNorth[level]),
    m.z * dot(dY, roadEast[level]), -m.w * dot(dY, roadNorth[level]));
  if (abs(determinant(toTexel)) < 1e-8) return vec3(0.0);
  mat2 toPixel = inverse(toTexel);
  float drawn = max(0.35 / max(footprint, 1e-3), 0.6);
  float radius = max(drawn, MIN_LAMP_PIXELS);
  float fade = lampFade(max(0.35, 0.6 * footprint)) * sq(drawn / radius);
  vec3 sum = vec3(0.0);
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 c = base + ivec2(dx, dy);
      uvec2 h = pcg2d(uvec2(origin + c));
      vec2 r = vec2(h & 0xffffu) / 65535.0;
      if (r.x >= density) continue;
      vec2 position = vec2(c) + 0.15 + 0.7 * vec2(fract(r.y * 7.13), fract(r.y * 13.7));
      float d = length(toPixel * (position - texel));
      float i = 0.7 + 0.8 * fract(r.y * 31.1);
      vec3 color = fract(r.y * 3.7) < 0.55 ? LAMP_COLORS[1] : LAMP_COLORS[2];
      sum += color * i * fade * exp(-d * d / (radius * radius));
    }
  }
  return sum;
}

/**
 * Runway lighting, drawn exactly from each runway's axis (runwayLights.ts):
 * every lamp at its true place in the runway's own frame (along, across,
 * meters), so rows are straight, spacing exact and approach lights in line
 * with the runway at any distance. Per pixel, each row of lamps only
 * evaluates the few lamps nearest it.
 *
 * - edge lights (precision every 30 m, else 60 m; dimmer on small fields),
 * - centerline every 15 m (precision),
 * - threshold: green bar just outside the end, red just inside (small
 *   fields: a few at each corner),
 * - ALSF-2 (precision): 5-lamp barrettes every 30 m, crossbars at 150 and
 *   300 m, red side barrettes over the inner 270 m;
 * - MALSR (instrument): barrettes every 60 m to 420 m, crossbar at 300 m,
 *   single sequenced flashers beyond.
 */
vec2 rwP;
mat2 rwToPixel;
float rwR;
float rwGlare;
float rwK;
float rwBoost;
vec3 rwSum;
float rwCover;

void runwayLamp(const vec2 at, const vec3 color, const float intensity) {
  vec2 d2 = rwToPixel * (at - rwP);
  float d = dot(d2, d2);
  float spot = exp(-d / (rwR * rwR));
  float light = spot * rwBoost + exp(-d / (rwGlare * rwGlare)) * 0.08;
  rwSum += color * intensity * rwK * light;
  rwCover += spot;
}

/** Lamps at origin + i·step·dir, i = 0 … count-1: the three nearest. */
void lampRow(const vec2 origin, const vec2 dir, const float step, const float count, const vec3 color, const float intensity) {
  if (count < 1.0) return;
  float i0 = clamp(floor(dot(rwP - origin, dir) / step + 0.5), 0.0, count - 1.0);
  for (float k = -1.0; k <= 1.0; k += 1.0) {
    float i = i0 + k;
    if (i < 0.0 || i > count - 1.0) continue;
    runwayLamp(origin + dir * (i * step), color, intensity);
  }
}

/**
 * Rows centered on origin + j·rowStep·rowDir (j = 0 … rows-1), each
 * count lamps, spaced by lampStep along lampDir: the three nearest rows.
 */
void lampRows(const vec2 origin, const vec2 rowDir, const float rowStep, const float rows, const vec2 lampDir, const float lampStep, const float count, const vec3 color, const float intensity) {
  if (rows < 1.0) return;
  float j0 = clamp(floor(dot(rwP - origin, rowDir) / rowStep + 0.5), 0.0, rows - 1.0);
  for (float k = -1.0; k <= 1.0; k += 1.0) {
    float j = j0 + k;
    if (j < 0.0 || j > rows - 1.0) continue;
    vec2 start = origin + rowDir * (j * rowStep) - lampDir * (lampStep * (count - 1.0) * 0.5);
    lampRow(start, lampDir, lampStep, count, color, intensity);
  }
}

/** Lamp size and brightness for lamps seen at this footprint (m per pixel). */
void runwayLampScale(const float footprint) {
  float physical = 0.35 / max(footprint, 1e-3);
  rwR = max(0.8, physical * 0.6);
  // A little glare close up only: far away it filled the gaps between the
  // rows, and the glow pass adds the halo anyway.
  rwGlare = rwR + clamp(physical, 0.0, 2.0);
  rwK = airfieldK(physical / 0.8);
  rwBoost = airfieldBoost(physical / 0.8);
}

/** Approach lights off one runway end (rwP / rwToPixel set for them). */
void approachLights(const vec2 end, const vec2 outward, const float reach, const bool isPrecision) {
  vec3 white = LAMP_COLORS[8];
  vec3 red = LAMP_COLORS[7];
  const vec2 ACROSS = vec2(0.0, 1.0);
  if (isPrecision) {
    lampRows(end + outward * 30.0, outward, 30.0, floor((reach - 30.0) / 30.0) + 1.0, ACROSS, 1.0, 5.0, white, 0.85);
    if (reach >= 150.0) lampRow(end + outward * 150.0 - ACROSS * 9.0, ACROSS, 1.5, 13.0, white, 0.85);
    if (reach >= 300.0) lampRow(end + outward * 300.0 - ACROSS * 15.0, ACROSS, 1.5, 21.0, white, 0.85);
    float sideRows = floor((min(reach, 270.0) - 30.0) / 30.0) + 1.0;
    lampRows(end + outward * 30.0 - ACROSS * 12.9, outward, 30.0, sideRows, ACROSS, 1.5, 3.0, red, 0.7);
    lampRows(end + outward * 30.0 + ACROSS * 12.9, outward, 30.0, sideRows, ACROSS, 1.5, 3.0, red, 0.7);
  } else {
    lampRows(end + outward * 60.0, outward, 60.0, floor((min(reach, 420.0) - 60.0) / 60.0) + 1.0, ACROSS, 1.0, 5.0, white, 0.85);
    if (reach >= 300.0) lampRow(end + outward * 300.0 - ACROSS * 10.5, ACROSS, 1.5, 15.0, white, 0.85);
    if (reach >= 480.0) lampRow(end + outward * 480.0, outward, 60.0, floor((reach - 480.0) / 60.0) + 1.0, white, 0.85);
  }
}

/**
 * Runway lights for this pixel. dir, dirX, dirY: the view ray and its
 * screen derivatives (approach lights are placed where the ray meets the
 * level plane through the runway end: they stand on poles level with the
 * runway, not on the ground beyond it; where the ground in the approach
 * area rises above that level they top it, and nearer terrain hides them).
 */
vec3 runwayLights(const vec3 offset, const float footprint, const vec3 dX, const vec3 dY, const vec3 dir, const vec3 dirX, const vec3 dirY) {
  rwSum = vec3(0.0);
  rwCover = 0.0;
  vec3 RUNWAY_WHITE = LAMP_COLORS[8];
  vec3 GREEN_LIGHT = LAMP_COLORS[5];
  vec3 RED_LIGHT = LAMP_COLORS[7];
  const vec2 ALONG = vec2(1.0, 0.0);
  const vec2 ACROSS = vec2(0.0, 1.0);
  float groundDistance = length(offset);
  for (int n = 0; n < ${MAX_RUNWAYS}; ++n) {
    if (n >= runwayCount) break;
    vec4 o = runwayOrigin[n];
    vec4 al = runwayAlong[n];
    vec3 ac = runwayAcross[n].xyz;
    vec4 approach = runwayApproach[n];
    float len = o.w;
    int lighting = int(al.w + 0.5);
    bool basic = lighting == 0;
    bool isPrecision = lighting == 2;
    float halfWidth = basic ? 12.0 : 23.0;
    vec3 v = offset - o.xyz;
    vec2 ground = vec2(dot(v, al.xyz), dot(v, ac));
    mat2 groundLocal = mat2(dot(dX, al.xyz), dot(dX, ac), dot(dY, al.xyz), dot(dY, ac));
    bool groundOk = abs(determinant(groundLocal)) > 1e-10;
    mat2 groundToPixel = groundOk ? inverse(groundLocal) : mat2(0.0);

    // On the pavement: edge lights, centerline, thresholds.
    if (groundOk && ground.x > -60.0 && ground.x < len + 60.0 && abs(ground.y) < 60.0) {
      rwP = ground;
      rwToPixel = groundToPixel;
      runwayLampScale(footprint);
      float spacing = isPrecision ? 30.0 : 60.0;
      lampRows(vec2(spacing * 0.5, 0.0), ALONG, spacing, floor((len - spacing * 0.5) / spacing) + 1.0, ACROSS, 2.0 * halfWidth, 2.0, RUNWAY_WHITE, basic ? 0.6 : 1.0);
      if (isPrecision) lampRow(vec2(7.5, 0.0), ALONG, 15.0, floor((len - 7.5) / 15.0) + 1.0, RUNWAY_WHITE, 0.25);
      for (int e = 0; e < 2; ++e) {
        vec2 end = vec2(e == 0 ? 0.0 : len, 0.0);
        vec2 outward = vec2(e == 0 ? -1.0 : 1.0, 0.0);
        if (basic) {
          for (int s = 0; s < 2; ++s) {
            float side = s == 0 ? -1.0 : 1.0;
            lampRow(end + outward * 2.0 + ACROSS * (side * (halfWidth - 1.5)), -side * ACROSS, 3.0, 3.0, GREEN_LIGHT, 0.7);
            lampRow(end - outward * 2.0 + ACROSS * (side * (halfWidth - 1.5)), -side * ACROSS, 3.0, 3.0, RED_LIGHT, 0.45);
          }
        } else {
          lampRow(end + outward * 2.0 - ACROSS * 21.0, ACROSS, 3.0, 15.0, GREEN_LIGHT, 1.0);
          lampRow(end - outward * 2.0 - ACROSS * 19.5, ACROSS, 3.0, 14.0, RED_LIGHT, 0.6);
        }
      }
    }

    // Approach lights, level with each runway end.
    if (basic) continue;
    for (int e = 0; e < 2; ++e) {
      float reach = e == 0 ? approach.x : approach.y;
      if (reach < 30.0) continue;
      vec2 end = vec2(e == 0 ? 0.0 : len, 0.0);
      vec2 outward = vec2(e == 0 ? -1.0 : 1.0, 0.0);
      float height = e == 0 ? approach.z : approach.w;
      if (height < -1e5) {
        // Threshold height not known yet: on the ground, as before.
        if (!groundOk) continue;
        float beyond = dot(ground - end, outward);
        if (beyond < -40.0 || beyond > reach + 40.0 || abs(ground.y) > 40.0) continue;
        rwP = ground;
        rwToPixel = groundToPixel;
        runwayLampScale(footprint);
      } else {
        vec3 base = o.xyz + al.xyz * (e == 0 ? 0.0 : len);
        vec3 normal = normalize(cameraPositionECEF + base);
        vec3 point = base + normal * height;
        float facing = dot(dir, normal);
        if (abs(facing) < 1e-4) continue;
        float t = dot(point, normal) / facing;
        if (t <= 0.0) continue;
        if (t > groundDistance + 3.0 + 0.003 * t) {
          // Ground (trees, a roof, an embankment) above the threshold's
          // level where the ray meets it. Inside the approach area the
          // poles stand taller than that: the lamps ride on top of it.
          // Anywhere else it's terrain in front, hiding them.
          if (!groundOk) continue;
          float over = dot(ground - end, outward);
          if (over < -40.0 || over > reach + 40.0 || abs(ground.y) > 40.0) continue;
          rwP = ground;
          rwToPixel = groundToPixel;
          runwayLampScale(footprint);
        } else {
          vec3 q = dir * t;
          vec3 qv = q - o.xyz;
          rwP = vec2(dot(qv, al.xyz), dot(qv, ac));
          float beyond = dot(rwP - end, outward);
          if (beyond < -40.0 || beyond > reach + 40.0 || abs(rwP.y) > 40.0) continue;
          vec3 qX = dirX * t - dir * (t * dot(dirX, normal) / facing);
          vec3 qY = dirY * t - dir * (t * dot(dirY, normal) / facing);
          mat2 local = mat2(dot(qX, al.xyz), dot(qX, ac), dot(qY, al.xyz), dot(qY, ac));
          if (abs(determinant(local)) < 1e-10) continue;
          rwToPixel = inverse(local);
          runwayLampScale(t * pixelAngle);
        }
      }
      approachLights(end, outward, reach, isPrecision);
    }
  }
  // Overlapping lamps (far away) blend to their own brightness.
  return rwSum / max(1.0, rwCover);
}


float hash1(const uvec2 v) {
  return float(pcg2d(v).x & 0xffffu) / 65535.0;
}

/** Length of the overlap of [a0, a1] and [b0, b1]. */
float overlap(const float a0, const float a1, const float b0, const float b1) {
  return max(0.0, min(a1, b1) - max(a0, b0));
}

/** Building traits for its windows (set per pixel by buildingWindows). */
bool wOffice;
float wShare;
uvec2 wBuilding;
uint wSide;
float wTint;

/** A home window's light: warm bulbs mostly, some white LED, a TV's blue. */
vec3 homeColor(const float r) {
  return r < 0.55 ? vec3(1.0, 0.62, 0.32)
    : r < 0.82 ? vec3(1.0, 0.8, 0.58)
    : r < 0.94 ? vec3(0.86, 0.9, 1.0)
    : vec3(0.42, 0.58, 1.0) * 0.5;
}

/** Width (columns) of a lit cluster: an office suite, an apartment. */
float wCluster;

/**
 * Whether the cluster holding this window cell is lit (a suite's or a
 * home's lights on): windows light in runs along a floor, the way real
 * towers show patches of lit offices among dark ones. xyz: its light's
 * color, w: 1 if lit.
 */
vec4 cluster(const ivec2 cell) {
  int block = int(floor(float(cell.x) / wCluster));
  uvec2 h = pcg2d(uvec2(uint(block + 65536) + wSide * 131071u, uint(cell.y + 65536)) ^ (wBuilding * 2246822519u));
  if (float(h.x & 0xffffu) / 65535.0 >= wShare) return vec4(0.0);
  float r = float(h.y & 0xffffu) / 65535.0;
  // Mostly warm white (as offices look at night), some neutral, a few cool.
  vec3 color = wOffice
    ? (r < 0.6 ? vec3(1.0, 0.84, 0.6) : r < 0.9 ? vec3(1.0, 0.93, 0.8) : vec3(0.85, 0.92, 1.0))
    : homeColor(r);
  return vec4(color, 1.0);
}

/** Share of a lit cluster's windows that are lit (rooms, desks left dark). */
float clusterFill() {
  return wOffice ? 0.85 : 0.7;
}

/**
 * Windows smaller than a pixel, as points of light (like distant street
 * lamps): groups of k×k cells, each drawn as one ~pixel-wide point at a
 * world-fixed spot, lit if the cluster at its middle is and as bright as
 * that cluster's light over the group (up to a window's own). Far towers
 * read as dark shapes with patches of light, and nothing twinkles, as the
 * points stay put. Groups wider than a cluster are lit by chance.
 */
vec3 windowPoints(const vec2 cellF, const vec2 w, const float k, const float area) {
  // At least about a pixel wide: narrower points twinkle as they cross
  // pixel centers in motion (peak below keeps their light the same).
  const float RADIUS = 0.95;
  float clusters = max(1.0, k / wCluster) * k;
  float anyLit = k > wCluster ? 1.0 - pow(1.0 - wShare, clusters) : 1.0;
  if (anyLit <= 0.001) return vec3(0.0);
  // The group's light gathered into one point.
  float litShare = k > wCluster ? wShare / anyLit : 1.0;
  float peak = min(1.0, clusterFill() * litShare * area * k * k / (w.x * w.y * 3.14159 * RADIUS * RADIUS));
  vec2 g = cellF / k;
  ivec2 base = ivec2(floor(g - 0.5));
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 2; ++j) {
    for (int i = 0; i < 2; ++i) {
      ivec2 c = base + ivec2(i, j);
      uvec2 h = pcg2d(uvec2(c + 65536) ^ (wBuilding * 2654435761u) ^ uvec2(uint(k) * 7919u, wSide * 104729u));
      vec4 lit = cluster(ivec2(floor((vec2(c) + 0.5) * k)));
      if (k > wCluster) {
        // Many clusters per group: lit by chance, in a typical color.
        if (float(h.x & 0xffffu) / 65535.0 >= anyLit) continue;
        lit = vec4(wOffice ? vec3(1.0, 0.86, 0.64) : vec3(1.0, 0.7, 0.42), 1.0);
      }
      if (lit.w <= 0.0) continue;
      vec2 jitter = vec2(float(h.x >> 16u), float(h.y & 0xffffu)) / 65535.0;
      vec2 d = (cellF - (vec2(c) + 0.2 + 0.6 * jitter) * k) / w;
      sum += lit.rgb * 0.75 * exp(-dot(d, d) / (RADIUS * RADIUS));
    }
  }
  return sum * peak;
}

/** Light of one window cell (column, floor): its color if lit, else 0. */
vec3 windowAt(const ivec2 cell) {
  uvec2 wid = uvec2(uint(cell.x + 65536) + wSide * 131071u, uint(cell.y + 65536)) ^ (wBuilding * 2654435761u);
  uvec2 hw = pcg2d(wid);
  float rw = float(hw.x & 0xffffu) / 65535.0;
  float rc = float(hw.y & 0xffffu) / 65535.0;
  vec4 lit = cluster(cell);
  if (lit.w <= 0.0) {
    // A rare light on in a dark office floor.
    return wOffice && rw < 0.01 ? vec3(1.0, 0.9, 0.72) * 0.6 : vec3(0.0);
  }
  if (rw >= clusterFill()) return vec3(0.0);
  // Curtains and blinds dim many home windows; offices are evenly lit.
  return lit.rgb * (wOffice ? mix(0.65, 0.9, rc) : mix(0.3, 1.0, rc));
}

/**
 * Lit windows on building walls: OSM footprints with a height, in the
 * finest street level's tiles. A wall pixel looks up the building a couple
 * of meters inside it; windows sit on a world-fixed grid (floors by
 * altitude, columns along the wall) so they hold still as the camera
 * moves. Each building gets a use (offices among the tall ones), a floor
 * height, window size and how busy it is; each window (offices: each
 * floor) is lit or not by a hash and the hour. Where windows are under a
 * couple of pixels they blend into their average light instead of
 * shimmering. Returns the windows' emitted light.
 */
vec3 buildingWindows(const vec3 offset, const vec3 surfaceNormal, const vec3 dX, const vec3 dY) {
  if (roadEnabled[0] < 0.5) return vec3(0.0);
  vec3 east = roadEast[0];
  vec3 north = roadNorth[0];
  vec3 n = normalize(surfaceNormal);
  if (dot(n, offset) > 0.0) n = -n;
  vec2 h = vec2(dot(n, east), dot(n, north));
  if (dot(h, h) < 1e-4) return vec3(0.0);
  h = normalize(h);
  // The building behind this wall: a few meters in (OSM footprints and
  // the photographed walls are often meters apart), the tallest found.
  vec3 inward = east * h.x + north * h.y;
  float window = roadWindow[0];
  vec2 b = vec2(0.0);
  ivec2 tile = ivec2(0);
  for (int i = 0; i < 3; ++i) {
    vec2 local = roadLocal(0, offset - inward * (i == 0 ? 2.0 : i == 1 ? 5.0 : 9.0));
    if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(window)))) continue;
    ivec2 t = ivec2(floor(local));
    float layer = roadLayer(0, t);
    if (layer < 0.0) continue;
    vec2 found = texelFetch(buildingMap, ivec3(ivec2(fract(local) * float(TILE)), int(layer)), 0).rg * 255.0;
    if (found.r > b.r) {
      b = found;
      tile = t;
    }
    if (b.r >= 4.5) break;
  }
  float height = b.r * 2.0;
  // Houses and garages: no window grid (too small to read as windows).
  if (height < 9.0) return vec3(0.0);
  vec2 local = roadLocal(0, offset);
  float fade = roadFade[tile.y * int(window) + tile.x];
  float edge = min(min(local.x, local.y), min(window - local.x, window - local.y));
  fade *= smoothstep(0.0, 0.25, edge);
  if (fade <= 0.0) return vec3(0.0);

  // Per building: world-fixed id (its byte, made unique by its tile).
  uvec2 tileId = uvec2(ivec2(roadOrigin[0]) + tile);
  uvec2 bid = uvec2(uint(b.g + 0.5) + tileId.x * 256u, tileId.y);
  uvec2 hb = pcg2d(bid);
  float r0 = float(hb.x & 0xffffu) / 65535.0;
  float r1 = float(hb.x >> 16u) / 65535.0;
  float r2 = float(hb.y & 0xffffu) / 65535.0;
  float r3 = float(hb.y >> 16u) / 65535.0;
  bool office = r0 < smoothstep(20.0, 90.0, height) * 0.75;
  float floorHeight = office ? mix(3.7, 4.3, r1) : mix(2.9, 3.4, r1);
  float columnWidth = office ? mix(1.6, 3.2, r2) : mix(2.6, 4.0, r2);
  // How busy this building is; a few stand dark (vacant, closed, parking).
  float busy = r3 < 0.08 ? 0.0 : mix(0.35, 1.5, fract(r3 * 13.7));
  float share = clamp((office ? windowShares.y : windowShares.x) * busy, 0.0, 0.95);

  // Wall coordinates: altitude, and along the wall (the anchor's east or
  // north axis, whichever the wall runs closer to: robust to the noisy
  // photogrammetry normals; walls at an angle get somewhat wider windows).
  vec3 pl = offset - roadAnchor[0];
  float altitude = dot(pl, normalize(cross(east, north)));
  bool facesEast = abs(h.x) > abs(h.y);
  float along = facesEast ? dot(pl, north) : dot(pl, east);
  uint side = facesEast ? (h.x > 0.0 ? 0u : 1u) : (h.y > 0.0 ? 2u : 3u);
  vec2 cellF = vec2((along + r2 * 7.0) / columnWidth, (altitude + r1 * 5.0) / floorHeight);
  // Pixel size on the wall along each axis, in cells: floors (tall) stay
  // sharp farther than columns (narrow), and grazing walls blur along.
  vec3 alongAxis = facesEast ? north : east;
  vec3 upAxis = normalize(cross(east, north));
  vec2 w = vec2(
    max(abs(dot(dX, alongAxis)), abs(dot(dY, alongAxis))) / columnWidth,
    max(abs(dot(dX, upAxis)), abs(dot(dY, upAxis))) / floorHeight);

  // Window opening within its cell: offices nearly continuous glass,
  // homes punched windows.
  vec2 x01 = office ? vec2(0.1, 0.9) : vec2(0.2, 0.8);
  vec2 y01 = office ? vec2(0.25, 0.88) : vec2(0.32, 0.86);

  wOffice = office;
  wShare = share;
  wBuilding = bid;
  wSide = side;
  wTint = r1;
  // Suites of 4-10 windows; homes of 2-3.
  wCluster = office ? floor(mix(4.0, 10.99, fract(r2 * 7.31))) : floor(mix(2.0, 3.99, fract(r2 * 7.31)));

  // Up close, an exact box filter: the share of this pixel (in cell
  // units, w wide) each window opening covers, over the up to 2x2 cells
  // it touches, so windows fade in and out smoothly as the view moves.
  float area = (x01.y - x01.x) * (y01.y - y01.x);
  float size = max(w.x, w.y);
  vec3 windows = vec3(0.0);
  if (size < 0.9) {
    vec2 halfW = max(w, vec2(1e-4)) * 0.5;
    vec2 lo = cellF - halfW;
    vec2 hi = cellF + halfW;
    ivec2 first = ivec2(floor(lo));
    for (int j = 0; j < 2; ++j) {
      int y = first.y + j;
      float oy = overlap(lo.y, hi.y, float(y) + y01.x, float(y) + y01.y) / (2.0 * halfW.y);
      if (oy <= 0.0) continue;
      for (int i = 0; i < 2; ++i) {
        int x = first.x + i;
        float ox = overlap(lo.x, hi.x, float(x) + x01.x, float(x) + x01.y) / (2.0 * halfW.x);
        if (ox > 0.0) windows += windowAt(ivec2(x, y)) * ox * oy;
      }
    }
  }
  // Farther: points of light for groups of windows (k a power of two,
  // groups at least ~1.5 px; blended across the steps).
  if (size > 0.6) {
    float level = log2(max(size * 1.5, 1.0));
    float k = exp2(floor(level));
    float t = fract(level);
    vec3 points = mix(windowPoints(cellF, w, k, area), windowPoints(cellF, w, 2.0 * k, area), t);
    windows = mix(windows, points, smoothstep(0.6, 0.9, size));
  }
  return windows * fade;
}

/**
 * One street level at this pixel: pools (rgb) and coverage (a: inside the
 * window and loaded, fading out over its outer quarter tile), and its
 * lamps, drawn as points.
 */
vec4 roadLevel(const int level, const vec3 offset, const float footprint, const vec3 dX, const vec3 dY, out vec3 lamps, out vec3 field) {
  lamps = vec3(0.0);
  field = vec3(0.0);
  if (roadEnabled[level] < 0.5) return vec4(0.0);
  vec2 local = roadLocal(level, offset);
  float window = roadWindow[level];
  if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(window)))) return vec4(0.0);
  float layer = roadLayer(level, ivec2(floor(local)));
  if (layer < 0.0) return vec4(0.0);
  vec3 pools = texture(roadLights, vec3(fract(local), layer)).rgb;
  lamps = nearLamps(level, local, footprint, dX, dY, field);
  float edge = min(min(local.x, local.y), min(window - local.x, window - local.y));
  ivec2 cell = ivec2(floor(local));
  float fade = roadFade[level * ROAD_STRIDE + cell.y * int(window) + cell.x];
  return vec4(pools, smoothstep(0.0, 0.25, edge) * fade);
}

/**
 * Aircraft landing and taxi light beams on the surface at this offset:
 * irradiance from each cone (soft edge), falling off with distance and
 * the angle of incidence.
 */
vec3 lightBeams(const vec3 offset, const vec3 normal) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHT_BEAMS}; ++i) {
    if (i >= beamCount) break;
    vec3 toPoint = offset - beamPosition[i].xyz;
    float d2 = max(dot(toPoint, toPoint), 4.0);
    vec3 l = toPoint * inversesqrt(d2);
    float edge = beamDirection[i].w;
    float cone = smoothstep(edge, mix(edge, 1.0, 0.6), dot(l, beamDirection[i].xyz));
    float incidence = abs(dot(normal, l));
    sum += vec3(1.0, 0.96, 0.88) * beamPosition[i].w * cone * incidence / d2;
  }
  return sum;
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
  // Runway lights are also on at dusk and under low overcast.
  float fieldOn = max(night, airfieldOn);
  if (fieldOn <= 0.0) return;
  if (night <= 0.0) {
    // Daytime: runway lights only (streets are off, and this stays cheap).
    float footprintDay = length(offset) * pixelAngle;
    vec3 dXDay = dFdx(offset);
    vec3 dYDay = dFdy(offset);
    vec3 n = cross(dXDay, dYDay);
    float nLength = length(n);
    float upDay = nLength > 1e-12 ? abs(dot(n, up)) / nLength : 0.0;
    vec3 dirDay = normalize(offset);
    vec3 runway = runwayLights(offset, footprintDay, dXDay, dYDay, dirDay, dFdx(dirDay), dFdy(dirDay)) * lampGain * smoothstep(0.35, 0.85, upDay) * fieldOn;
    if (any(isnan(runway)) || any(isinf(runway))) runway = vec3(0.0);
    outColor = vec4(runway, lightLuminance(runway) * glowShare(0.35 / max(footprintDay, 1e-3) / 0.8));
    return;
  }
  float value = lightMap(p);
  // Kept where the satellite map says the area is actually lit: rural
  // roads and farm tracks stay dark (MSFS lights them like suburbs).
  // Airfield lights are kept everywhere (rural airports are lit too), so
  // there is no early out for dark areas.
  float urban = smoothstep(0.08, 0.4, value);
  quietness = 1.0 - smoothstep(0.3, 0.7, value);
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
  vec3 fieldLamps = vec3(0.0);
  float coarse = 0.0;
  for (int level = 0; level < ${ROAD_LEVELS}; ++level) {
    if (level < first || remaining <= 0.001) continue;
    float want = level == first ? 1.0 - fract(lod) : 1.0;
    vec3 levelLamps;
    vec3 levelField;
    vec4 s = roadLevel(level, offset, footprint, dX, dY, levelLamps, levelField);
    float w = min(remaining, want) * s.a;
    pools += s.rgb * w;
    lamps += levelLamps * w;
    fieldLamps += levelField * w;
    if (level == ${ROAD_LEVELS - 1}) coarse = w;
    remaining -= w;
  }
  vec3 viewDir = normalize(offset);
  fieldLamps += runwayLights(offset, footprint, dX, dY, viewDir, dFdx(viewDir), dFdy(viewDir));

  // Street light lands on the ground, not on walls: only on surfaces that
  // face up (normal from depth derivatives).
  // (Neighbouring pixels at the same reconstructed point, far away or at
  // depth precision limits, give no normal: treat as not facing up rather
  // than NaN, which the glow blur would spread over the whole screen.)
  vec3 normal = cross(dX, dY);
  float normalLength = length(normal);
  float upness = normalLength > 1e-12 ? abs(dot(normal, up)) / normalLength : 0.0;
  // Lamps are light sources; their pools light the surface, so they show
  // its own color (dark asphalt, markings, sidewalks) rather than glowing.
  vec3 lit = pools * roadGain * albedo.rgb + lamps * lampGain;
  // What feeds the glow (alpha, below): lamps drawn bigger and brighter
  // than their true share of a pixel far away would make a distant
  // airport's or city's glow grow as it shrinks on screen. Beyond a few
  // km, scale the glow down towards the lamps' true energy.
  vec3 glowing = pools * roadGain * albedo.rgb + lamps * lampGain * glowShare(0.35 / max(footprint, 1e-3) / 0.8);

  // Residential carpet where only the coarse level's main roads are drawn,
  // and beyond the street tiles (not loaded yet, or past the windows): the
  // same world-fixed scatter of lamps, so the far city has the texture of
  // the near one instead of a flat, straight-edged wash at the tiles'
  // edge. A faint even glow only where there's no coarse grid at all
  // (very high up).
  // Sparser where NASA's map is dimmer: suburbs thin out to the dark edges.
  float density = pow(smoothstep(0.12, 0.8, value), 1.5) * 0.3;
  float land = 1.0 - waterScore(albedo.rgb);
  bool coarseGrid = roadEnabled[${ROAD_LEVELS - 1}] > 0.5;
  float carpetShare = coarse + (coarseGrid ? remaining : 0.0);
  if (carpetShare > 0.0) {
    vec3 c = carpet(${ROAD_LEVELS - 1}, roadLocal(${ROAD_LEVELS - 1}, offset), footprint, density, dX, dY) * lampGain * carpetShare * land;
    lit += c;
    glowing += c * glowShare(0.5 / max(0.35, 0.6 * footprint));
  }
  if (!coarseGrid) {
    vec3 average = vec3(1.0, 0.6, 0.25) * density * 0.04 * lampGain * remaining * land;
    lit += average;
    glowing += average;
  }

  // Brighter where NASA's map is: downtown cores stand out from suburbs
  // instead of one even sheet of light across the metro area.
  float cores = mix(0.7, 1.3, smoothstep(0.35, 0.95, value));
  float facing = smoothstep(0.35, 0.85, upness) * night;
  float gain = urban * cores * facing;
  vec3 field = fieldLamps * lampGain * smoothstep(0.35, 0.85, upness) * fieldOn;
  vec3 light = lit * gain + field;
  float glow = lightLuminance(glowing) * gain + lightLuminance(field) * glowShare(0.35 / max(footprint, 1e-3) / 0.8);
  // Landing and taxi lights on the runway, taxiway or apron ahead.
  if (beamCount > 0 && normalLength > 1e-12) {
    vec3 beams = albedo.rgb * lightBeams(offset, normal / normalLength) * night;
    light += beams;
    glow += lightLuminance(beams) * 0.15;
  }
  // Lit windows on walls (not on roofs or the ground).
  float wall = 1.0 - smoothstep(0.3, 0.55, upness);
  if (windowGain > 0.0 && wall > 0.0 && normalLength > 1e-12) {
    vec3 windows = buildingWindows(offset, normal, dX, dY) * windowGain * wall * night;
    light += windows;
    glow += lightLuminance(windows) * 0.25;
  }
  // Never NaN or infinite: one such pixel turns the whole glow (and with it
  // every light on screen) black.
  if (any(isnan(light)) || any(isinf(light)) || isnan(glow) || isinf(glow)) {
    light = vec3(0.0);
    glow = 0.0;
  }
  // Alpha: the glow's brightness (the blur carries it along with the color).
  outColor = vec4(max(light, vec3(0.0)), max(glow, 0.0));
}
`

/**
 * Share of lit clusters (office suites, apartments) by hour (solar time
 * at the view), every 2 hours from midnight: homes busiest in the evening
 * and nearly dark before dawn; offices lit as people leave, then patches
 * here and there (cleaning, late work) through the night.
 */
const HOME_LIT = [0.12, 0.05, 0.035, 0.08, 0.18, 0.12, 0.1, 0.1, 0.15, 0.27, 0.3, 0.22]
const OFFICE_LIT = [0.05, 0.035, 0.035, 0.06, 0.22, 0.4, 0.4, 0.4, 0.4, 0.25, 0.14, 0.08]

function litShare(table: readonly number[], hour: number): number {
  const h = ((((hour % 24) + 24) % 24) / 2)
  const i = Math.floor(h)
  const t = h - i
  return table[i]! + (table[(i + 1) % 12]! - table[i]!) * t * t * (3 - 2 * t)
}

/** Lit windows' brightness (relative to the street lamps' lampGain). */
const WINDOW_GAIN = 0.02

/** Glow around night lights (blurred light added to them). */
const NIGHT_GLOW = 0.45

/**
 * Adds the lights' glow, and writes the cloud underglow into alpha: seen
 * from above a deck, how much of the city's light below diffuses up
 * through the cloud at this pixel. AerialPerspective (patched) lights
 * cloud with it, by cloud opacity.
 */
const COMBINE_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D glowBuffer;
uniform float glowStrength;
uniform sampler2D depthBuffer;
uniform sampler2D baseMap;
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
uniform vec3 cameraPositionECEF;
uniform vec3 sunDirection;
/** Earth radius at the view plus the low cloud base altitude (0: no clouds). */
uniform float cloudBaseRadius;

in vec2 vUv;
out vec4 outColor;

vec3 viewOffset(const vec2 uv, const float depth) {
  vec4 view = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return mat3(cameraWorld) * (view.xyz / view.w);
}

/**
 * Blurred light (luminance) that, seen from above a cloud deck, glows
 * through it as the full-strength underglow.
 */
const float THROUGH_CLOUD_FULL = 0.006;

float underglow(const vec3 blurredLight) {
  if (cloudBaseRadius <= 0.0) return 0.0;
  // Below the base, the clouds light their own bases with the city's glow,
  // volumetrically (clouds/nightClouds.ts).
  if (dot(cameraPositionECEF, cameraPositionECEF) < cloudBaseRadius * cloudBaseRadius) return 0.0;
  // Above it: the cloud lies over the terrain seen through it, and the
  // city's own lights there diffuse up through it: the blurred lights at
  // this pixel (bright over streets, dark over water and parks), not NASA's
  // coarse map, which lit far decks as an even wash that hid the city and
  // didn't follow its lights.
  float depth = texture(depthBuffer, vUv).r;
  if (depth >= 0.9999999) return 0.0;
  vec3 ground = cameraPositionECEF + viewOffset(vUv, depth);
  float nightAbove = smoothstep(0.06, -0.08, dot(normalize(ground), sunDirection));
  float light = dot(blurredLight, vec3(0.2126, 0.7152, 0.0722));
  return min(1.0, light / THROUGH_CLOUD_FULL) * nightAbove;
}

void main() {
  // Glow: the blurred lights' color at the blurred glow brightness (alpha).
  vec4 blurred = texture(glowBuffer, vUv);
  float luminance = dot(blurred.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 glow = blurred.rgb * min(1.0, blurred.a / max(luminance, 1e-6)) * glowStrength;
  float under = underglow(blurred.rgb);
  outColor = vec4(
    any(isnan(glow)) || any(isinf(glow)) ? vec3(0.0) : glow,
    isnan(under) || isinf(under) ? 0.0 : under
  );
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
  /**
   * The lights, then their glow added on top (one full-screen target, not
   * two): what AerialPerspective (patched) adds.
   */
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
  /**
   * The lights blurred: their glow, like the halo lights form in the eye
   * and through the air. Only the lights glow: a bloom over the whole scene
   * buffer washed everything white (stray huge values in it). Combined
   * with the lights here so AerialPerspective reads one texture: its merged
   * effect pass is at the 16 texture unit limit (black screen beyond it).
   */
  private readonly blur = new MipmapBlurPass()
  private readonly material: ShaderMaterial
  private readonly combine: ShaderMaterial

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
        airfieldOn: new Uniform(0),
        pixelAngle: new Uniform(0.001),
        roadLights: new Uniform(null),
        roadLamps: new Uniform(null),
        lampGain: new Uniform(0.12),
        buildingMap: new Uniform(null),
        windowGain: new Uniform(WINDOW_GAIN),
        windowShares: new Uniform(new Vector2(0.2, 0.2)),
        roadTexelMeters: new Uniform(new Float32Array(ROAD_LEVELS)),
        roadOrigin: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector2())),
        roadEnabled: new Uniform(new Float32Array(ROAD_LEVELS)),
        roadAnchor: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector3())),
        roadEast: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector3())),
        roadNorth: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector3())),
        roadMercator: new Uniform(Array.from({ length: ROAD_LEVELS }, () => new Vector4())),
        roadCurvature: new Uniform(new Float32Array(ROAD_LEVELS)),
        roadLayers: new Uniform(new Float32Array(ROAD_LEVELS * MAX_WINDOW * MAX_WINDOW).fill(-1)),
        roadFade: new Uniform(new Float32Array(ROAD_LEVELS * MAX_WINDOW * MAX_WINDOW)),
        roadWindow: new Uniform(new Float32Array(ROAD_LEVELS).fill(4)),
        runwayCount: new Uniform(0),
        runwayOrigin: new Uniform(Array.from({ length: MAX_RUNWAYS }, () => new Vector4())),
        runwayAlong: new Uniform(Array.from({ length: MAX_RUNWAYS }, () => new Vector4())),
        runwayAcross: new Uniform(Array.from({ length: MAX_RUNWAYS }, () => new Vector4())),
        runwayApproach: new Uniform(Array.from({ length: MAX_RUNWAYS }, () => new Vector4())),
        beamCount: new Uniform(0),
        beamPosition: new Uniform(lightBeams.position),
        beamDirection: new Uniform(lightBeams.direction)
      }
    })
    const u = this.material.uniforms
    this.combine = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader: COMBINE_SHADER,
      depthTest: false,
      depthWrite: false,
      // Glow added onto the lights already in the target; alpha replaced by
      // the cloud underglow.
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: ZeroFactor,
      uniforms: {
        glowBuffer: new Uniform(null),
        glowStrength: new Uniform(NIGHT_GLOW),
        depthBuffer: u.depthBuffer!,
        baseMap: u.baseMap!,
        inverseProjection: u.inverseProjection!,
        cameraWorld: u.cameraWorld!,
        cameraPositionECEF: u.cameraPositionECEF!,
        sunDirection: u.sunDirection!,
        cloudBaseRadius: new Uniform(0)
      }
    })
    this.fullscreenMaterial = this.material
    this.blur.levels = 7
    this.blur.radius = 0.75
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

  setRoads(texture: DataArrayTexture, lamps: DataArrayTexture, buildings: DataArrayTexture, levels: readonly RoadLevelUniforms[]): void {
    this.u<DataArrayTexture>('roadLights').value = texture
    this.u<DataArrayTexture>('roadLamps').value = lamps
    this.u<DataArrayTexture>('buildingMap').value = buildings
    const enabled = this.u<Float32Array>('roadEnabled').value
    const layers = this.u<Float32Array>('roadLayers').value
    const fades = this.u<Float32Array>('roadFade').value
    levels.forEach((level, i) => {
      enabled[i] = level.enabled ? 1 : 0
      this.u<Vector3[]>('roadAnchor').value[i]!.copy(level.anchor)
      this.u<Vector3[]>('roadEast').value[i]!.copy(level.east)
      this.u<Vector3[]>('roadNorth').value[i]!.copy(level.north)
      this.u<Vector4[]>('roadMercator').value[i]!.set(...level.mercator)
      this.u<Float32Array>('roadCurvature').value[i] = level.curvature
      this.u<Float32Array>('roadTexelMeters').value[i] = level.metersPerTexel
      this.u<Vector2[]>('roadOrigin').value[i]!.set(...level.origin)
      layers.set(level.layers, i * MAX_WINDOW * MAX_WINDOW)
      fades.set(level.fade, i * MAX_WINDOW * MAX_WINDOW)
      this.u<Float32Array>('roadWindow').value[i] = level.window
    })
  }

  setRunways(runways: RunwayUniforms): void {
    this.u<number>('runwayCount').value = runways.count
    for (let i = 0; i < runways.count; ++i) {
      this.u<Vector4[]>('runwayOrigin').value[i]!.copy(runways.origin[i]!)
      this.u<Vector4[]>('runwayAlong').value[i]!.copy(runways.along[i]!)
      this.u<Vector4[]>('runwayAcross').value[i]!.copy(runways.across[i]!)
      this.u<Vector4[]>('runwayApproach').value[i]!.copy(runways.approach[i]!)
    }
  }

  /** Landing/taxi light beams this frame (NavLights fills lightBeams). */
  setBeams(count: number): void {
    this.u<number>('beamCount').value = count
  }

  /** Earth radius at the view plus the low cloud base altitude; 0 without clouds. */
  setCloudBase(radius: number): void {
    ;(this.combine.uniforms.cloudBaseRadius as { value: number }).value = radius
  }

  setAirfieldOn(value: number): void {
    this.u<number>('airfieldOn').value = value
  }

  /** Lit windows on buildings on or off (quality setting). */
  setWindows(enabled: boolean): void {
    this.u<number>('windowGain').value = enabled ? WINDOW_GAIN : 0
  }

  /** Solar time at the view (hours): sets how many windows are lit. */
  setLocalHour(hour: number): void {
    this.u<Vector2>('windowShares').value.set(litShare(HOME_LIT, hour), litShare(OFFICE_LIT, hour))
  }

  setSun(direction: Vector3): void {
    this.u<Vector3>('sunDirection').value.copy(direction)
  }

  override initialize(renderer: WebGLRenderer, alpha: boolean): void {
    // Half float like the lights themselves: 8-bit mipmaps (the default)
    // quantize the faint glow into flat, hard-edged slabs.
    this.blur.initialize(renderer, alpha, HalfFloatType)
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
    this.blur.setSize(width, height)
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
    this.fullscreenMaterial = this.material
    renderer.render(this.scene, this.camera)
    this.blur.render(renderer, this.target, null)
    this.combine.uniforms.glowBuffer!.value = this.blur.texture
    renderer.setRenderTarget(this.target)
    this.fullscreenMaterial = this.combine
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = autoClear
    this.fullscreenMaterial = this.material
  }

  override dispose(): void {
    super.dispose()
    this.target.dispose()
    this.blur.dispose()
    this.combine.dispose()
    this.material.dispose()
  }
}
