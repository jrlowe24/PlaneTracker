import { LocalWeather, type ProceduralTexture } from '@takram/three-clouds'
import type { Texture } from 'three'

/**
 * Source of cloud coverage for the volumetric clouds.
 *
 * The clouds read a "local weather" texture (one coverage channel per cloud
 * layer: r = low cumulus, g = mid, b = cirrus), tiled over the globe, plus a
 * global coverage. This is the seam for real weather: a provider can build a
 * coverage texture from e.g. satellite cloud masks or model output (GFS /
 * Open-Meteo cloud cover per level) for the area in view, and report the
 * matching coverage, without touching the renderer.
 */
export interface CloudWeather {
  readonly name: string
  readonly localWeatherTexture: Texture | ProceduralTexture
  /** 0 = clear … 1 = overcast. */
  readonly coverage: number
  /** Drift of the weather texture in UV units per second (wind). */
  readonly velocity: readonly [number, number]
  /** Called every frame with the view center (degrees), for providers that stream data. */
  update?: (lat: number, lon: number) => void
  dispose: () => void
}

/** Procedural coverage (takram's tileable curl/Perlin local weather). */
export function createProceduralWeather(coverage = 0.35): CloudWeather {
  const texture = new LocalWeather()
  return {
    name: 'procedural',
    localWeatherTexture: texture,
    coverage,
    velocity: [0.00002, 0.000005],
    dispose: () => {
      texture.dispose()
    }
  }
}
