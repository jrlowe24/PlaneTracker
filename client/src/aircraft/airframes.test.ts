import { describe, expect, it } from 'vitest'

import { AIRFRAMES, buildAirframe, buildGear, type AircraftClass } from './airframes'
import { aircraftClass } from './typeClasses'

describe('procedural airframes', () => {
  for (const cls of Object.keys(AIRFRAMES) as AircraftClass[]) {
    it(`builds ${cls} with colors, normals and plausible bounds`, () => {
      const params = AIRFRAMES[cls]
      const geometry = buildAirframe(params, { segments: 8 })
      const position = geometry.getAttribute('position')
      expect(position.count).toBeGreaterThan(100)
      expect(geometry.getAttribute('normal').count).toBe(position.count)
      expect(geometry.getAttribute('color').count).toBe(position.count)
      geometry.computeBoundingBox()
      const box = geometry.boundingBox!
      // Nose forward (+Z) and roughly the right length.
      expect(box.max.z).toBeCloseTo(params.length / 2, 0)
      expect(box.max.z - box.min.z).toBeGreaterThan(params.length * 0.95)
      const gear = buildGear(params)
      gear.computeBoundingBox()
      // Gear reaches the ground: groundClearance below the fuselage axis.
      expect(gear.boundingBox!.min.y).toBeCloseTo(-params.groundClearance, 1)
    })
  }
})

describe('aircraftClass', () => {
  it('maps type designators, then emitter categories', () => {
    expect(aircraftClass('B738')).toBe('narrowbody')
    expect(aircraftClass('b77w')).toBe('widebody')
    expect(aircraftClass('E75L')).toBe('regional')
    expect(aircraftClass('AT76')).toBe('turboprop')
    expect(aircraftClass('GLF6')).toBe('bizjet')
    expect(aircraftClass('EC35')).toBe('helicopter')
    expect(aircraftClass('C172')).toBe('light')
    expect(aircraftClass('ZZZZ', 'A5')).toBe('widebody')
    expect(aircraftClass(null, 'A7')).toBe('helicopter')
    expect(aircraftClass(null, null)).toBe('generic')
  })
})
