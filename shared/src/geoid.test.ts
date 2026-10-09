import { meanSeaLevel } from 'egm96-universal'
import { describe, expect, it } from 'vitest'

import { geoidHeight } from './geoid'

describe('geoidHeight (1° EGM96 grid)', () => {
  it('matches the full 15′ EGM96 model within a few meters', () => {
    let worst = 0
    for (let lat = -85; lat <= 85; lat += 7.3) {
      for (let lon = -179; lon <= 179; lon += 11.7) {
        worst = Math.max(worst, Math.abs(geoidHeight(lat, lon) - meanSeaLevel(lat, lon)))
      }
    }
    expect(worst).toBeLessThan(6)
  })

  it('has known values: Seattle ≈ −23 m, Sri Lanka low ≈ −100 m, New Guinea ≈ +75 m', () => {
    expect(Math.abs(geoidHeight(47.45, -122.31) - meanSeaLevel(47.45, -122.31))).toBeLessThan(2)
    expect(geoidHeight(47.45, -122.31)).toBeLessThan(-20)
    expect(geoidHeight(5, 78)).toBeLessThan(-90)
    expect(geoidHeight(-5, 145)).toBeGreaterThan(60)
  })
})
