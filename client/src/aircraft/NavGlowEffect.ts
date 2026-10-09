import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import {
  PerspectiveCamera,
  Uniform,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type WebGLRenderer
} from 'three'

import { glowLights, glowState } from './navLightsStore'

/** Halos drawn per frame (nearest lights first). */
const MAX_GLOWS = 48
/** Physical glow radius around a light, meters. */
const GLOW_RADIUS_M = 1.2
const MIN_RADIUS_PX = 3
const MAX_RADIUS_PX = 14
const GLOW_GAIN = 0.35

const fragmentShader = /* glsl */ `
uniform vec4 glows[${MAX_GLOWS}];
uniform vec3 glowColors[${MAX_GLOWS}];
uniform int glowCount;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_GLOWS}; ++i) {
    if (i >= glowCount) break;
    vec4 g = glows[i];
    vec2 d = (uv - g.xy) * resolution;
    float r = g.w;
    float q = dot(d, d) / (r * r);
    if (q > 30.0) continue;
    // Hidden behind something nearer than the light (tolerance for the
    // light sitting on its own aircraft's surface).
    float sceneDistance = -getViewZ(readDepth(g.xy));
    if (sceneDistance < g.z - max(3.0, g.z * 0.01)) continue;
    float glow = exp(-q) * 0.7 + 0.3 / (1.0 + q * 3.0);
    sum += glowColors[i] * glow;
  }
  outputColor = vec4(inputColor.rgb + sum * ${GLOW_GAIN.toFixed(3)}, inputColor.a);
}
`

const relative = new Vector3()
const projected = new Vector3()
const drawingBuffer = new Vector2()

/**
 * Glow halos around aircraft nav lights: projects the nearest lights to the
 * screen on the CPU and adds a soft radial glow in post, hidden where the
 * depth buffer shows something in front. Only the lights glow (a selective
 * bloom pass bloomed the whole scene).
 */
export class NavGlowEffect extends Effect {
  constructor(private camera: Camera) {
    super('NavGlowEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['glows', new Uniform(Array.from({ length: MAX_GLOWS }, () => new Vector4()))],
        ['glowColors', new Uniform(Array.from({ length: MAX_GLOWS }, () => new Vector3()))],
        ['glowCount', new Uniform(0)]
      ])
    })
  }

  override set mainCamera(camera: Camera) {
    this.camera = camera
  }

  override update(renderer: WebGLRenderer): void {
    const camera = this.camera
    const glows = this.uniforms.get('glows')!.value as Vector4[]
    const colors = this.uniforms.get('glowColors')!.value as Vector3[]
    const count = Math.min(glowState.count, glowLights.length)
    if (!(camera instanceof PerspectiveCamera) || count === 0) {
      this.uniforms.get('glowCount')!.value = 0
      return
    }
    const height = renderer.getDrawingBufferSize(drawingBuffer).y
    const pixelAngle = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height)
    const nearest = glowLights.slice(0, count).sort((a, b) => a.distance - b.distance)
    let n = 0
    for (const light of nearest) {
      if (n >= MAX_GLOWS) break
      relative.set(light.x, light.y, light.z)
      projected.copy(relative).add(camera.position).project(camera)
      if (projected.z > 1 || Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.1) continue
      const radius = Math.min(MAX_RADIUS_PX, Math.max(MIN_RADIUS_PX, GLOW_RADIUS_M / (light.distance * pixelAngle)))
      // View-space distance along the camera axis, comparable to getViewZ.
      const viewZ = relative.dot(camera.getWorldDirection(projected.clone()))
      glows[n]!.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5, viewZ, radius)
      colors[n]!.set(light.r, light.g, light.b)
      ++n
    }
    this.uniforms.get('glowCount')!.value = n
  }
}
