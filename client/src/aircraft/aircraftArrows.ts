import {
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Uniform,
  Vector2,
  type Camera,
  type WebGLRenderer
} from 'three'

import { CATEGORY_COLORS, type AircraftCategory } from './categories'

/**
 * Map markers for distant aircraft: flat top-down silhouettes, always
 * facing the screen, pointing along the aircraft's heading as seen on
 * screen, a fixed size in pixels and colored by kind of flight. Drawn after
 * post-processing into the final image (like map icons, they're not part
 * of the lit scene), in one draw call. Up close, aircraft are 3D models;
 * AircraftInstances crossfades between the two.
 */

export type ArrowIcon = 0 | 1 | 2
/** Atlas slots: airliner/jet, straight-wing light aircraft, helicopter. */
export const ICON_JET: ArrowIcon = 0
export const ICON_LIGHT: ArrowIcon = 1
export const ICON_HELICOPTER: ArrowIcon = 2
const ICONS = 3
const CELL = 128

// Drawn straight into the display (sRGB) image: keep the sRGB values.
const COLORS = Object.fromEntries(
  Object.entries(CATEGORY_COLORS).map(([key, hex]) => [key, new Color(hex).convertLinearToSRGB()])
) as Record<AircraftCategory, Color>
const SELECTED = new Color('#f26b0d').convertLinearToSRGB()

function drawAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = CELL * ICONS
  canvas.height = CELL
  const ctx = canvas.getContext('2d')!
  const shapes: Array<(c: CanvasRenderingContext2D) => void> = [
    // Jet: fuselage, swept wings, tailplane.
    c => {
      c.beginPath()
      c.roundRect(57, 6, 14, 116, 7)
      c.moveTo(64, 44)
      c.lineTo(8, 76)
      c.lineTo(8, 86)
      c.lineTo(64, 68)
      c.lineTo(120, 86)
      c.lineTo(120, 76)
      c.closePath()
      c.moveTo(64, 98)
      c.lineTo(38, 114)
      c.lineTo(38, 121)
      c.lineTo(64, 112)
      c.lineTo(90, 121)
      c.lineTo(90, 114)
      c.closePath()
    },
    // Light aircraft: straight wing, short nose.
    c => {
      c.beginPath()
      c.roundRect(57, 12, 14, 108, 7)
      c.roundRect(6, 42, 116, 16, 5)
      c.roundRect(38, 100, 52, 13, 4)
    },
    // Helicopter: rotor disc, cabin, tail boom.
    c => {
      c.beginPath()
      c.ellipse(64, 54, 15, 24, 0, 0, Math.PI * 2)
      c.rect(61, 70, 6, 50)
      c.rect(52, 112, 24, 6)
    }
  ]
  shapes.forEach((shape, i) => {
    ctx.save()
    ctx.translate(i * CELL, 0)
    // Outline (green) under the fill (red): the shader colors the fill and
    // darkens the rim, readable on bright and dark ground alike.
    shape(ctx)
    ctx.lineJoin = 'round'
    ctx.lineWidth = 12
    ctx.strokeStyle = 'rgb(0,255,0)'
    ctx.stroke()
    ctx.fillStyle = 'rgb(0,255,0)'
    ctx.fill('nonzero')
    shape(ctx)
    ctx.fillStyle = 'rgb(255,0,0)'
    ctx.fill('nonzero')
    if (i === ICON_HELICOPTER) {
      ctx.beginPath()
      ctx.arc(64, 54, 50, 0, Math.PI * 2)
      ctx.lineWidth = 5
      ctx.strokeStyle = 'rgb(140,255,0)'
      ctx.stroke()
    }
    ctx.restore()
  })
  return canvas
}

const vertexShader = /* glsl */ `
attribute vec3 iCenter;
attribute vec3 iForward;
attribute vec4 iColor;
/** x: size (CSS pixels), y: atlas slot, z: selected. */
attribute vec3 iMeta;
uniform vec2 viewport;
uniform float pixelRatio;
varying vec2 vUv;
varying vec4 vColor;
varying float vIcon;
varying float vSelected;

void main() {
  vec4 view = modelViewMatrix * vec4(iCenter, 1.0);
  vec4 center = projectionMatrix * view;
  if (center.w <= 0.0 || iColor.a <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Heading on screen: project a point a little ahead of the aircraft.
  vec4 ahead = projectionMatrix * modelViewMatrix * vec4(iCenter + iForward * max(1.0, 0.01 * length(view.xyz)), 1.0);
  vec2 dir = (ahead.xy / ahead.w - center.xy / center.w) * viewport;
  vec2 axis = dot(dir, dir) > 1e-8 ? normalize(dir) : vec2(0.0, 1.0);
  vec2 side = vec2(axis.y, -axis.x);
  vec2 pixels = (position.x * side + position.y * axis) * iMeta.x * pixelRatio;
  gl_Position = center;
  gl_Position.xy += pixels * 2.0 / viewport * center.w;
  vUv = position.xy + 0.5;
  vColor = iColor;
  vIcon = iMeta.y;
  vSelected = iMeta.z;
}
`

const fragmentShader = /* glsl */ `
uniform sampler2D atlas;
varying vec2 vUv;
varying vec4 vColor;
varying float vIcon;
varying float vSelected;

void main() {
  vec4 t = texture2D(atlas, vec2((vIcon + vUv.x) / ${ICONS.toFixed(1)}, vUv.y));
  float fill = t.r;
  float shape = max(t.g, fill);
  float alpha = shape * vColor.a;
  if (alpha < 0.01) discard;
  vec3 rim = mix(vec3(0.04, 0.05, 0.07), vec3(1.0), vSelected);
  vec3 color = mix(rim, vColor.rgb, fill / max(shape, 1e-3));
  gl_FragColor = vec4(color, alpha);
}
`

export class AircraftArrows {
  readonly scene = new Scene()
  private readonly geometry = new InstancedBufferGeometry()
  private readonly material: ShaderMaterial
  private readonly mesh: Mesh
  private readonly texture: CanvasTexture
  private capacity = 0
  private center = new Float32Array(0)
  private forward = new Float32Array(0)
  private color = new Float32Array(0)
  private meta = new Float32Array(0)
  private count = 0
  private readonly viewport = new Vector2()

  constructor() {
    const quad = new PlaneGeometry(1, 1)
    this.geometry.index = quad.index
    this.geometry.setAttribute('position', quad.getAttribute('position'))
    this.texture = new CanvasTexture(drawAtlas())
    this.texture.minFilter = LinearMipmapLinearFilter
    this.texture.generateMipmaps = true
    this.texture.anisotropy = 4
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { atlas: new Uniform(this.texture), viewport: new Uniform(this.viewport), pixelRatio: new Uniform(1) },
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.name = 'aircraft-arrows'
    this.scene.add(this.mesh)
    this.allocate(1024)
  }

  private allocate(capacity: number): void {
    const keep = this.count
    const grow = (old: Float32Array, size: number): Float32Array<ArrayBuffer> => {
      const next = new Float32Array(capacity * size)
      next.set(old.subarray(0, keep * size))
      return next
    }
    this.center = grow(this.center, 3)
    this.forward = grow(this.forward, 3)
    this.color = grow(this.color, 4)
    this.meta = grow(this.meta, 3)
    this.capacity = capacity
    const attribute = (name: string, array: Float32Array, size: number): void => {
      const a = new InstancedBufferAttribute(array, size)
      a.setUsage(DynamicDrawUsage)
      this.geometry.setAttribute(name, a)
    }
    attribute('iCenter', this.center, 3)
    attribute('iForward', this.forward, 3)
    attribute('iColor', this.color, 4)
    attribute('iMeta', this.meta, 3)
  }

  /** Starts a frame; markers are relative to `origin` (the camera position). */
  begin(origin: { x: number; y: number; z: number }): void {
    this.count = 0
    this.mesh.position.set(origin.x, origin.y, origin.z)
  }

  add(
    x: number,
    y: number,
    z: number,
    forward: { x: number; y: number; z: number },
    category: AircraftCategory,
    icon: ArrowIcon,
    sizePixels: number,
    alpha: number,
    selected: boolean
  ): void {
    if (this.count >= this.capacity) this.allocate(this.capacity * 2)
    const i = this.count++
    this.center[i * 3] = x
    this.center[i * 3 + 1] = y
    this.center[i * 3 + 2] = z
    this.forward[i * 3] = forward.x
    this.forward[i * 3 + 1] = forward.y
    this.forward[i * 3 + 2] = forward.z
    const color = selected ? SELECTED : COLORS[category]
    this.color[i * 4] = color.r
    this.color[i * 4 + 1] = color.g
    this.color[i * 4 + 2] = color.b
    this.color[i * 4 + 3] = alpha
    this.meta[i * 3] = sizePixels
    this.meta[i * 3 + 1] = icon
    this.meta[i * 3 + 2] = selected ? 1 : 0
  }

  end(): void {
    this.geometry.instanceCount = this.count
    for (const name of ['iCenter', 'iForward', 'iColor', 'iMeta']) {
      const attribute = this.geometry.getAttribute(name) as InstancedBufferAttribute
      attribute.clearUpdateRanges()
      attribute.addUpdateRange(0, this.count * attribute.itemSize)
      attribute.needsUpdate = true
    }
  }

  /** Draws the markers over the finished frame. */
  render(renderer: WebGLRenderer, camera: Camera): void {
    if (this.count === 0) return
    renderer.getDrawingBufferSize(this.viewport)
    this.material.uniforms.pixelRatio!.value = renderer.getPixelRatio()
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, camera)
    renderer.autoClear = autoClear
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}
