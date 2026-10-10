import { describe, expect, it } from 'vitest'

import {
  cloudLayersFromWeather,
  convectiveCoverage,
  cumulusBaseAboveGround,
  type WeatherSample
} from './weather'

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
  freezingLevel: 3500,
  cape: 0,
  weatherCode: 0
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

  it('adds towering convective cells only for storms or strong instability', () => {
    expect(cloudLayersFromWeather(base).convective.coverage).toBe(0)
    expect(convectiveCoverage(500, 3)).toBe(0)
    const storm = cloudLayersFromWeather({ ...base, cape: 2000, weatherCode: 95 })
    expect(storm.convective.coverage).toBeGreaterThan(0.1)
    expect(storm.convective.altitude).toBe(storm.low.altitude)
    expect(storm.convective.height).toBeGreaterThan(8000)
    expect(convectiveCoverage(3000, 2)).toBeGreaterThan(0)
  })
})
