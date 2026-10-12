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
 * Cloud noise for takram's clouds ("local weather": r = low coverage,
 * g = mid, b = cirrus, a = reserved), tiled over the globe.
 *
 * Each channel holds tileable fBm noise rank-transformed to a uniform
 * distribution u ∈ [0, 1). The patched clouds shader (regionalShader.ts)
 * adds COVERAGE_THRESHOLD − (1 − c) for the cover c at each sample's
 * position, so exactly a fraction c of the area exceeds COVERAGE_THRESHOLD
 * — where, with the renderer's global coverage held at GLOBAL_COVERAGE and
 * each layer's filter width at FILTER_WIDTH, clouds start (mid-layer).
 */
export const GLOBAL_COVERAGE = 0.5
/**
 * Width of the coverage ramp. Wide on purpose (Nubis-style): density fades
 * gradually toward a cloud field's edge, so the 3D shape and detail noise
 * decide where cloud survives there (broken, cellular edges and fragments)
 * instead of a crisp outline traced by the 2D coverage map.
 */
export const FILTER_WIDTH = 0.4
/** Weather value where clouds begin mid-layer: mix(v, 1, w) = 1 − coverage. */
export const COVERAGE_THRESHOLD = (1 - GLOBAL_COVERAGE - FILTER_WIDTH) / (1 - FILTER_WIDTH)

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
  /** Amplitude ratio between octaves (0.5 default; higher = rougher edges). */
  persistence?: number
}

const STYLES: [NoiseStyle, NoiseStyle, NoiseStyle, NoiseStyle] = [
  // Low clouds use a broad, irregular envelope. The volumetric shape and
  // detail textures supply the smaller puffs; putting those into the weather
  // mask too made high-cover fields read as evenly spaced cotton balls.
  { periodX: 8, periodY: 6, octaves: 4, seed: 11, persistence: 0.42 },
  // Mid: broader sheets (altostratus/altocumulus).
  { periodX: 5, periodY: 5, octaves: 4, seed: 23 },
  // High: streaky cirrus.
  { periodX: 16, periodY: 3, octaves: 3, seed: 37 },
  // Reserved for a future weather-driven convective layer.
  { periodX: 7, periodY: 7, octaves: 2, seed: 53 }
]

// Shared synoptic envelope. Each rendered texture tile spans roughly a
// thousand kilometres (VolumetricClouds lowers localWeatherRepeat), so these
// two-to-three broad lobes become mesoscale systems rather than another row
// of individual cloud puffs.
const SYSTEM_STYLE: NoiseStyle = {
  periodX: 2,
  periodY: 2,
  octaves: 4,
  seed: 79,
  persistence: 0.46
}

/** How strongly each layer follows the shared weather system. */
const SYSTEM_WEIGHTS = [0.72, 0.68, 0.38, 0.78] as const

/** Rank-transforms values to a uniform distribution over [0, 1). */
function toUniform(values: Float32Array): Float32Array {
  const order = Array.from(values.keys()).sort((i, j) => values[i]! - values[j]!)
  const out = new Float32Array(values.length)
  for (let rank = 0; rank < order.length; ++rank) out[order[rank]!] = rank / order.length
  return out
}

function fbmValues(style: NoiseStyle): Float32Array {
  const values = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; ++y) {
    for (let x = 0; x < SIZE; ++x) {
      let sum = 0
      let amplitude = 0.5
      for (let o = 0; o < style.octaves; ++o) {
        const f = 2 ** o
        sum += amplitude * valueNoise(x / SIZE, y / SIZE, style.periodX * f, style.periodY * f, style.seed + o)
        amplitude *= style.persistence ?? 0.5
      }
      values[y * SIZE + x] = sum
    }
  }
  return values
}

function fbmChannel(style: NoiseStyle, system: Float32Array, systemWeight: number): Float32Array {
  const detail = fbmValues(style)
  const values = new Float32Array(detail.length)
  for (let i = 0; i < values.length; ++i) {
    values[i] = system[i]! * systemWeight + detail[i]! * (1 - systemWeight)
  }
  // Preserve the coverage contract after correlating the layers: a requested
  // cover of c still occupies exactly c of a sufficiently large region.
  return toUniform(values)
}

export class CoverageTexture {
  readonly texture: DataTexture

  constructor() {
    const system = fbmValues(SYSTEM_STYLE)
    const channels = STYLES.map((style, i) => fbmChannel(style, system, SYSTEM_WEIGHTS[i]!))
    const data = new Uint8Array(SIZE * SIZE * 4)
    for (let channel = 0; channel < 4; ++channel) {
      const u = channels[channel]!
      for (let i = 0; i < u.length; ++i) data[i * 4 + channel] = Math.round(u[i]! * 255)
    }
    const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType)
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.minFilter = LinearMipMapLinearFilter
    texture.magFilter = LinearFilter
    texture.generateMipmaps = true
    texture.colorSpace = NoColorSpace
    texture.needsUpdate = true
    this.texture = texture
  }

  dispose(): void {
    this.texture.dispose()
  }
}
