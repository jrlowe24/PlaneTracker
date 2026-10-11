import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera
} from 'three'

import { flightConnection } from '../data/flightConnection'
import { nightState } from '../scene/nightLighting'
import { normalPassExclusions } from '../scene/normalPassExclusions'
import { AIRFRAMES } from './airframes'

/**
 * Soft contact shadows under aircraft on or near the ground: without them,
 * aircraft on a runway read as hovering. Each is a soft plan-view
 * silhouette (fuselage + wings) laid on the terrain, cast along the sun
 * direction from the aircraft's height and fading out by ~150 m above the
 * ground. Drawn into the scene before post lighting, it darkens the ground's
 * albedo like a real shadow, and dims to a faint contact shadow at night.
 */

const MAX_HEIGHT_AGL = 150
const MAX_DISTANCE = 15_000
const DAY_STRENGTH = 0.55
const NIGHT_STRENGTH = 0.18
/** Lift off the terrain, meters (avoid z-fighting). */
const LIFT = 0.25

const vertexShader = /* glsl */ `
attribute float instanceStrength;
varying vec2 vUv;
varying float vStrength;
void main() {
  vUv = uv;
  vStrength = instanceStrength;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`

// Plan view: u across the span (-0.5..0.5), v along the length (nose at 1).
const fragmentShader = /* glsl */ `
varying vec2 vUv;
varying float vStrength;
float soft(float d, float w) { return 1.0 - smoothstep(-w, w, d); }
void main() {
  vec2 p = vUv - 0.5;
  // Fuselage: narrow ellipse along the length.
  float fuselage = soft(length(p / vec2(0.05, 0.48)) - 1.0, 0.1);
  // Wings: a swept band across the span, a little aft of center.
  float wy = p.y + 0.02 + abs(p.x) * 0.35;
  float wing = soft(abs(wy) - 0.045 + abs(p.x) * 0.04, 0.02) * soft(abs(p.x) - 0.48, 0.015);
  // Tailplane.
  float ty = p.y + 0.42 + abs(p.x) * 0.3;
  float tail = soft(abs(ty) - 0.025, 0.015) * soft(abs(p.x) - 0.16, 0.015);
  float shape = max(fuselage, max(wing, tail));
  float alpha = shape * vStrength;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
}
`

const up = new Vector3()
const sun = new Vector3()
const ground = new Vector3()
const forward = new Vector3()
const right = new Vector3()
const matrix = new Matrix4()

export class GroundShadows {
  readonly mesh: InstancedMesh
  private capacity = 0
  private readonly geometry = new PlaneGeometry(1, 1)
  private readonly material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  })
  private strength = new Float32Array(0)

  constructor() {
    this.mesh = new InstancedMesh(this.geometry, this.material, 1)
    this.mesh.frustumCulled = false
    this.mesh.name = 'ground-shadows'
    this.mesh.renderOrder = 1
    // Not in the normal buffer: there it would be a full flat quad.
    normalPassExclusions.add(this.mesh)
    this.allocate(256)
  }

  private allocate(capacity: number): void {
    this.capacity = capacity
    this.mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.strength = new Float32Array(capacity)
    const attribute = new InstancedBufferAttribute(this.strength, 1)
    attribute.setUsage(DynamicDrawUsage)
    this.geometry.setAttribute('instanceStrength', attribute)
  }

  update(camera: PerspectiveCamera, sunDirection: Vector3 | null): void {
    const origin = camera.position
    this.mesh.position.copy(origin)
    let n = 0
    for (const aircraft of flightConnection.registry.list) {
      const pose = aircraft.pose
      if (pose == null || pose.opacity <= 0 || aircraft.groundHeight == null) continue
      const agl = pose.height - aircraft.groundHeight
      if (agl > MAX_HEIGHT_AGL || aircraft.cameraDistance > MAX_DISTANCE) continue
      if (n >= this.capacity) this.allocate(this.capacity * 2)

      up.copy(pose.position).normalize()
      // Shadow center: from the aircraft along -sun to the ground (straight
      // down when the sun is low or absent).
      let sunUp = 0
      if (sunDirection != null) {
        sun.copy(sunDirection)
        sunUp = sun.dot(up)
      }
      ground.copy(pose.position).addScaledVector(up, -agl + LIFT)
      if (sunUp > 0.17) {
        // Horizontal sun component × height / tan(elevation).
        const horizontal = sun.addScaledVector(up, -sunUp)
        ground.addScaledVector(horizontal, -agl / sunUp)
      }
      const p = AIRFRAMES[aircraft.cls]
      const span = (p.wingSpan > 0 ? p.wingSpan : p.length * 0.4) * aircraft.scale.span
      const length = p.length * aircraft.scale.length
      // Heading frame in the tangent plane.
      forward.copy(pose.forward).addScaledVector(up, -pose.forward.dot(up)).normalize()
      right.crossVectors(forward, up)
      matrix.makeBasis(right.multiplyScalar(span), forward.multiplyScalar(length), up)
      matrix.setPosition(ground.sub(origin))
      matrix.toArray(this.mesh.instanceMatrix.array as Float32Array, n * 16)

      const day = Math.max(0, Math.min(1, sunUp / 0.17))
      const base = NIGHT_STRENGTH + (DAY_STRENGTH - NIGHT_STRENGTH) * day * (1 - nightState.night)
      const fade = 1 - Math.min(1, Math.max(0, agl - 5) / (MAX_HEIGHT_AGL - 5))
      this.strength[n] = base * fade * fade * pose.opacity
      ++n
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    ;(this.geometry.getAttribute('instanceStrength') as InstancedBufferAttribute).needsUpdate = true
  }

  dispose(): void {
    normalPassExclusions.delete(this.mesh)
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
  }
}
