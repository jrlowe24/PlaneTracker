import { describe, expect, it } from 'vitest'

import { cloudLayersFromWeather, cumulusBaseAboveGround, type WeatherSample } from './weather'

const base: WeatherSample = {
  lat: 47.45,
  lon: -122.31,
  time: 0,
  elevation: 120,
  cloudCoverLow: 0,
  cloudCoverMid: 0,
  cloudCoverHigh: 0,
  temperature: 20,
  dewPoint: 10,
  freezingLevel: 3500
}

describe('cloud layers from weather', () => {
  it('puts the cumulus base at the lifting condensation level', () => {
    expect(cumulusBaseAboveGround(20, 10)).toBe(1250)
    const spec = cloudLayersFromWeather({ ...base, cloudCoverLow: 40 })
    expect(spec.low.altitude).toBe(120 + 1250)
    expect(spec.low.coverage).toBeCloseTo(0.4, 9)
    expect(spec.coverage).toBeCloseTo(0.4, 9)
  })

  it('keeps layers ordered and within sensible bounds', () => {
    const humid = cloudLayersFromWeather({ ...base, dewPoint: 19.8, cloudCoverLow: 90, cloudCoverMid: 60, cloudCoverHigh: 100 })
    expect(humid.low.altitude).toBe(120 + 300)
    expect(humid.mid.altitude).toBeGreaterThan(humid.low.altitude + humid.low.height)
    expect(humid.high.altitude).toBeGreaterThan(humid.mid.altitude)
    expect(humid.high.coverage).toBe(1)
  })

  it('is clear when every layer is clear', () => {
    const clear = cloudLayersFromWeather(base)
    expect(clear.coverage).toBe(0)
    expect(clear.low.coverage + clear.mid.coverage + clear.high.coverage).toBe(0)
  })
})
