import {
  DataTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType
} from 'three'

/**
 * Per-layer cloud coverage texture for takram's clouds ("local weather":
 * r = low cumulus, g = mid, b = cirrus), tiled over the globe.
 *
 * takram has one global `coverage` uniform for all layers, so per-layer
 * cover can't be set there. Instead each channel holds tileable fBm noise
 * that has been rank-transformed to a uniform distribution u ∈ [0, 1); for
 * a layer coverage c the channel stores u − (1 − c) + THRESHOLD, so exactly
 * a fraction c of the texels exceed THRESHOLD — where, with the renderer's
 * global coverage held at GLOBAL_COVERAGE and the layer's filter width at
 * FILTER_WIDTH, clouds start (mid-layer height). Exposed for that pairing.
 */
export const GLOBAL_COVERAGE = 0.5
export const FILTER_WIDTH = 0.2
/** Weather value where clouds begin mid-layer: mix(v, 1, w) = 1 − coverage. */
const THRESHOLD = (1 - GLOBAL_COVERAGE - FILTER_WIDTH) / (1 - FILTER_WIDTH)

const SIZE = 256

/** Deterministic hash → [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + seed * 2_147_483_647) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

/** Periodic value noise: lattice of `period` cells over [0, 1), wrapping. */
function valueNoise(u: number, v: number, periodX: number, periodY: number, seed: number): number {
  const x = u * periodX
  const y = v * periodY
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const wrap = (i: number, p: number): number => ((i % p) + p) % p
  const a = hash(wrap(x0, periodX), wrap(y0, periodY), seed)
  const b = hash(wrap(x0 + 1, periodX), wrap(y0, periodY), seed)
  const c = hash(wrap(x0, periodX), wrap(y0 + 1, periodY), seed)
  const d = hash(wrap(x0 + 1, periodX), wrap(y0 + 1, periodY), seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

interface NoiseStyle {
  /** Base lattice periods (cells per tile) in x and y; y < x stretches features. */
  periodX: number
  periodY: number
  octaves: number
  seed: number
}

const STYLES: [NoiseStyle, NoiseStyle, NoiseStyle] = [
  // Low: cumulus blobs, a few km across.
  { periodX: 12, periodY: 12, octaves: 4, seed: 11 },
  // Mid: broader sheets (altostratus/altocumulus).
  { periodX: 5, periodY: 5, octaves: 4, seed: 23 },
  // High: streaky cirrus.
  { periodX: 16, periodY: 3, octaves: 3, seed: 37 }
]

/** Rank-transforms values to a uniform distribution over [0, 1). */
function toUniform(values: Float32Array): Float32Array {
  const order = Array.from(values.keys()).sort((i, j) => values[i]! - values[j]!)
  const out = new Float32Array(values.length)
  for (let rank = 0; rank < order.length; ++rank) out[order[rank]!] = rank / order.length
  return out
}

function fbmChannel(style: NoiseStyle): Float32Array {
  const values = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; ++y) {
    for (let x = 0; x < SIZE; ++x) {
      let sum = 0
      let amplitude = 0.5
      for (let o = 0; o < style.octaves; ++o) {
        const f = 2 ** o
        sum += amplitude * valueNoise(x / SIZE, y / SIZE, style.periodX * f, style.periodY * f, style.seed + o)
        amplitude *= 0.5
      }
      values[y * SIZE + x] = sum
    }
  }
  return toUniform(values)
}

export class CoverageTexture {
  readonly texture: DataTexture
  private readonly data: Uint8Array
  private readonly uniform: [Float32Array, Float32Array, Float32Array]
  private readonly current: [number, number, number] = [-1, -1, -1]

  constructor() {
    this.uniform = [fbmChannel(STYLES[0]), fbmChannel(STYLES[1]), fbmChannel(STYLES[2])]
    this.data = new Uint8Array(SIZE * SIZE * 4)
    const texture = new DataTexture(this.data, SIZE, SIZE, RGBAFormat, UnsignedByteType)
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.minFilter = LinearMipMapLinearFilter
    texture.magFilter = LinearFilter
    texture.generateMipmaps = true
    texture.colorSpace = NoColorSpace
    this.texture = texture
    this.setCoverage(0, 0, 0)
  }

  /** Per-layer coverage 0…1; only rewrites channels that changed noticeably. */
  setCoverage(low: number, mid: number, high: number): void {
    const next = [low, mid, high]
    let changed = false
    for (let channel = 0; channel < 3; ++channel) {
      const c = Math.min(1, Math.max(0, next[channel]!))
      if (Math.abs(c - this.current[channel]!) < 0.005) continue
      this.current[channel] = c
      changed = true
      const u = this.uniform[channel]!
      const offset = THRESHOLD - (1 - c)
      for (let i = 0; i < u.length; ++i) {
        const v = Math.min(1, Math.max(0, u[i]! + offset))
        this.data[i * 4 + channel] = Math.round(v * 255)
      }
    }
    if (changed) this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
