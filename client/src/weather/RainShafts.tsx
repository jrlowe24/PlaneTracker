import { useFrame, useThree } from '@react-three/fiber'
import { ecefToGeodetic, precipitationIntensity } from '@windowseat/shared'
import { useEffect, useMemo, type FC } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type Camera,
  LineSegments,
  Matrix4,
  ShaderMaterial,
  Uniform,
  Vector3
} from 'three'

import { AIRCRAFT_LAYER } from '../aircraft/layers'
import { weatherStore } from '../data/weather'
import { normalPassExclusions } from '../scene/normalPassExclusions'
import { nightState } from '../scene/nightLighting'
import { settingsStore } from '../state/settings'

const DROP_COUNT = 8000
const RADIUS = 2200
const MIN_HEIGHT = 1800
const MAX_HEIGHT = 18_000
const MAX_RADIUS = 12_000

function random(index: number, seed: number): number {
  const x = Math.sin(index * 127.1 + seed * 311.7) * 43_758.5453
  return x - Math.floor(x)
}

function createRain(): LineSegments<BufferGeometry, ShaderMaterial> {
  const positions = new Float32Array(DROP_COUNT * 2 * 3)
  const phases = new Float32Array(DROP_COUNT * 2)
  for (let i = 0; i < DROP_COUNT; ++i) {
    const angle = random(i, 1) * Math.PI * 2
    const distance = Math.sqrt(random(i, 2)) * RADIUS
    const x = Math.cos(angle) * distance
    const y = Math.sin(angle) * distance
    const length = 4 + random(i, 3) * 18
    const phase = random(i, 4)
    const offset = i * 6
    positions[offset] = x
    positions[offset + 1] = y
    positions[offset + 2] = 0
    positions[offset + 3] = x + (random(i, 5) - 0.5) * 1.5
    positions[offset + 4] = y + (random(i, 6) - 0.5) * 1.5
    positions[offset + 5] = -length
    phases[i * 2] = phase
    phases[i * 2 + 1] = phase
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('phase', new BufferAttribute(phases, 1))
  const material = new ShaderMaterial({
    uniforms: {
      rainTime: new Uniform(0),
      rainDensity: new Uniform(0),
      rainHeight: new Uniform(MIN_HEIGHT),
      rainRadiusScale: new Uniform(1),
      rainColor: new Uniform(new Color())
    },
    vertexShader: /* glsl */ `
      attribute float phase;
      uniform float rainTime;
      uniform float rainHeight;
      uniform float rainRadiusScale;
      varying float vRainFade;

      void main() {
        float head = mod(phase * rainHeight - rainTime * 260.0, rainHeight);
        vec3 localPosition = vec3(position.xy * rainRadiusScale, head + position.z);
        vRainFade = smoothstep(0.0, 80.0, localPosition.z)
          * (1.0 - smoothstep(rainHeight - 240.0, rainHeight, localPosition.z));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(localPosition, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float rainDensity;
      uniform vec3 rainColor;
      varying float vRainFade;

      void main() {
        // The atmosphere's mixed-lighting pass cannot preserve a transparent
        // object over post-lit terrain. Stochastically keep opaque drop
        // samples instead: each retained pixel has its own depth and the gaps
        // reveal correctly lit terrain, while motion makes the result read as
        // translucent rain rather than a dotted line.
        float noise = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        if (noise > rainDensity * vRainFade) discard;
        gl_FragColor = vec4(rainColor, 1.0);
      }
    `,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false
  })
  const rain = new LineSegments(geometry, material)
  rain.name = 'regional-rain-shafts'
  rain.frustumCulled = false
  rain.renderOrder = 8
  // Preserve the rain's already-lit radiance in AerialPerspective instead
  // of treating it as terrain albedo. Its own depth still receives haze and
  // lets terrain occlude drops behind ridges and buildings.
  rain.layers.enable(AIRCRAFT_LAYER)
  return rain
}

const up = new Vector3()
const east = new Vector3()
const north = new Vector3()
const basis = new Matrix4()

class RainController {
  readonly mesh = createRain()

  constructor() {
    normalPassExclusions.add(this.mesh)
  }

  update(camera: Camera, delta: number): void {
    const rain = this.mesh
    const settings = settingsStore.get()
    const sample = weatherStore.get().sample
    const strength = settings.precipitation === 'off'
      ? 0
      : settings.precipitation === 'force'
        ? 0.75
        : settings.weatherPrototype !== 'live'
          ? 0
          : precipitationIntensity(sample?.weatherCode ?? null, sample?.cape)
    const altitude = ecefToGeodetic(
      camera.position.x,
      camera.position.y,
      camera.position.z
    ).height
    rain.visible = strength > 0.01 && altitude < 60_000
    if (!rain.visible) return

    const uniforms = rain.material.uniforms as {
      rainTime: Uniform<number>
      rainDensity: Uniform<number>
      rainHeight: Uniform<number>
      rainRadiusScale: Uniform<number>
      rainColor: Uniform<Color>
    }
    uniforms.rainTime.value += Math.min(delta, 0.1) * (0.75 + strength * 0.5)
    uniforms.rainDensity.value = 0.3 + strength * 0.38
    // Rain is lit mostly by diffuse sky. At night it should remain legible
    // after eye adaptation without becoming the white fluorescent bars that
    // an unlit, non-depth-writing overlay produced.
    const night = nightState.night
    uniforms.rainColor.value.setRGB(
      0.032 + (0.0045 - 0.032) * night,
      0.043 + (0.006 - 0.043) * night,
      0.055 + (0.0085 - 0.055) * night
    ).multiplyScalar(0.65 + strength * 0.35)

    up.copy(camera.position).normalize()
    east.set(-up.y, up.x, 0)
    if (east.lengthSq() < 1e-6) east.set(0, 1, 0)
    east.normalize()
    north.crossVectors(up, east).normalize()
    basis.makeBasis(east, north, up)
    rain.quaternion.setFromRotationMatrix(basis)
    // Span from just above the ground to slightly above the camera. The old
    // lab-mode volume floated around the camera, so oblique views put every
    // streak against the sky and none in front of the terrain.
    const baseAltitude = 60
    const volumeHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, altitude - baseAltitude + 600))
    const radius = Math.min(MAX_RADIUS, Math.max(RADIUS, 1800 + altitude * 0.7))
    uniforms.rainHeight.value = volumeHeight
    uniforms.rainRadiusScale.value = radius / RADIUS
    rain.position.copy(camera.position).addScaledVector(up, -Math.max(0, altitude - baseAltitude))
    rain.updateMatrixWorld()
  }

  dispose(): void {
    normalPassExclusions.delete(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

/**
 * A cheap regional precipitation volume: thousands of depth-tested streaks
 * in a moving ENU cylinder beneath the camera. It is intentionally geometry,
 * not a full-screen filter, so terrain and aircraft occlude the rain.
 */
export const RainShafts: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const controller = useMemo(() => new RainController(), [])

  useEffect(() => {
    return () => {
      controller.dispose()
    }
  }, [controller])

  useFrame((_, delta) => {
    controller.update(camera, delta)
  })

  return <primitive object={controller.mesh} dispose={null} />
}
