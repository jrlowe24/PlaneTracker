import { describe, expect, it } from 'vitest'

import {
  feetPerMinuteToMetersPerSecond,
  feetToMeters,
  knotsToMetersPerSecond,
  metersToFeet,
  metersToNauticalMiles,
  nauticalMilesToMeters
} from './units'

describe('units', () => {
  it('converts feet to meters exactly (international foot)', () => {
    expect(feetToMeters(1)).toBe(0.3048)
    expect(feetToMeters(35000)).toBeCloseTo(10668, 6)
    expect(metersToFeet(feetToMeters(12345))).toBeCloseTo(12345, 9)
  })

  it('converts knots to m/s', () => {
    expect(knotsToMetersPerSecond(1)).toBeCloseTo(0.514444, 6)
    // Typical cruise: 450 kt ≈ 231.5 m/s
    expect(knotsToMetersPerSecond(450)).toBeCloseTo(231.5, 1)
  })

  it('converts ft/min to m/s', () => {
    expect(feetPerMinuteToMetersPerSecond(60)).toBeCloseTo(0.3048, 9)
    // Typical 3° approach at 140 kt descends at ~ -750 ft/min ≈ -3.81 m/s
    expect(feetPerMinuteToMetersPerSecond(-750)).toBeCloseTo(-3.81, 2)
  })

  it('converts nautical miles to meters and back', () => {
    expect(nauticalMilesToMeters(1)).toBe(1852)
    expect(metersToNauticalMiles(nauticalMilesToMeters(250))).toBeCloseTo(250, 9)
  })
})
