/**
 * Current weather at a point (Open-Meteo, CC BY 4.0), and how it maps to
 * the volumetric cloud layers.
 */
export interface WeatherSample {
  /** Grid point the forecast is for (degrees). */
  lat: number
  lon: number
  /** Epoch ms of the model time step. */
  time: number
  /** Terrain elevation of the grid point, meters MSL. */
  elevation: number
  /** Cloud cover in %, low (< ~2 km), mid (~2–6 km), high (> ~6 km). */
  cloudCoverLow: number
  cloudCoverMid: number
  cloudCoverHigh: number
  /** °C at 2 m. */
  temperature: number
  /** °C at 2 m. */
  dewPoint: number
  /** Height of the 0 °C level, meters MSL (null if unknown). */
  freezingLevel: number | null
  /** Convective available potential energy, J/kg (null if unknown). */
  cape: number | null
  /** WMO weather code (95–99 thunderstorm, 80–82 showers), if known. */
  weatherCode: number | null
}

/** Cloud cover of one cell of the regional weather grid (1° cells). */
export interface WeatherGridCell {
  /** Cell center, degrees (integers). */
  lat: number
  lon: number
  /** Cloud cover in %, low / mid / high. */
  low: number
  mid: number
  high: number
  /** Convective available potential energy, J/kg. */
  cape: number
  /** WMO weather code. */
  code: number
}

export interface CloudLayerSpec {
  /** Cloud base, meters MSL. */
  altitude: number
  /** Layer thickness, meters. */
  height: number
  /** 0 … 1. */
  coverage: number
}

export interface CloudWeatherSpec {
  /** Global coverage parameter for the renderer (0 … 1). */
  coverage: number
  low: CloudLayerSpec
  mid: CloudLayerSpec
  high: CloudLayerSpec
  /** Towering cumulus / cumulonimbus (sparse cells), coverage 0 when none. */
  convective: CloudLayerSpec
}

/**
 * How much of an area towering convective cells cover (0 … 1, sparse by
 * design): thunderstorms (WMO 95–99) give scattered cumulonimbus; showers
 * (80–82) or high CAPE give fewer, smaller towers.
 */
export function convectiveCoverage(cape: number | null, code: number | null): number {
  const c = Math.max(0, cape ?? 0)
  const instability = clampValue((c - 300) / 1700, 0, 1)
  let coverage = 0
  if (code != null && code >= 95) coverage = 0.3 + 0.15 * instability
  else if (code != null && code >= 80 && code <= 82) coverage = 0.08 + 0.12 * instability
  return Math.max(coverage, 0.12 * clampValue((c - 1500) / 1500, 0, 1))
}

/** Top of convective towers above their base, meters, from CAPE. */
export function convectiveDepth(cape: number | null): number {
  return clampValue(3500 + Math.max(0, cape ?? 0) * 3, 3500, 10_000)
}

function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function clampValue(x: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, x))
}

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))

/**
 * Cumulus base from the surface temperature–dew point spread (lifting
 * condensation level, Espy's approximation: ~125 m per °C), above ground.
 */
export function cumulusBaseAboveGround(temperature: number, dewPoint: number): number {
  return 125 * Math.max(0, temperature - dewPoint)
}

/**
 * Layer heights and coverages for a weather sample:
 * - low: base at the lifting condensation level (≥ 300 m above ground),
 *   thicker with more cover (convective towers when it's mostly cloudy);
 * - mid: altostratus/altocumulus around 3–5 km, above the low tops;
 * - high: cirrus near 8 km (higher when the freezing level is high).
 * The renderer's single global coverage follows the low/mid cover, which
 * dominate what you see; the cirrus layer's opacity is set per layer.
 */
export function cloudLayersFromWeather(sample: WeatherSample): CloudWeatherSpec {
  const low = clamp(sample.cloudCoverLow / 100, 0, 1)
  const mid = clamp(sample.cloudCoverMid / 100, 0, 1)
  const high = clamp(sample.cloudCoverHigh / 100, 0, 1)

  const ground = Math.max(0, sample.elevation)
  const lowBase = ground + clamp(cumulusBaseAboveGround(sample.temperature, sample.dewPoint), 300, 3000)
  // Scattered cumulus build tall; near overcast, low cloud is a flatter
  // stratocumulus sheet (thick decks read as walls of cotton).
  const deck = smoothstep01((low - 0.55) / 0.35)
  const lowHeight = (400 + 1400 * low) * (1 - deck) + 600 * deck
  const midBase = Math.max(lowBase + lowHeight + 300, 3000)
  const midHeight = 600 + 1200 * mid
  const freezing = sample.freezingLevel ?? 3000
  const highBase = clamp(freezing + 4500, 7000, 11_000)

  return {
    coverage: clamp(Math.max(low, mid * 0.9), 0, 1),
    low: { altitude: lowBase, height: lowHeight, coverage: low },
    mid: { altitude: midBase, height: midHeight, coverage: mid },
    high: { altitude: highBase, height: 500, coverage: high },
    convective: {
      altitude: lowBase,
      height: convectiveDepth(sample.cape),
      coverage: convectiveCoverage(sample.cape, sample.weatherCode)
    }
  }
}
