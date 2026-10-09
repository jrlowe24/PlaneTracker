import { describe, expect, it } from 'vitest'

import type { AircraftState } from './aircraft'
import { decodeAircraft, encodeAircraft } from './protocol'

const sample: AircraftState = {
  hex: 'a1b2c3',
  callsign: 'ASA123',
  registration: 'N123AS',
  typeCode: 'B39M',
  category: 'A3',
  squawk: '4521',
  lat: 47.4502113,
  lon: -122.3088456,
  altBaro: 2350,
  altGeom: 2475,
  onGround: false,
  groundSpeed: 142.36,
  track: 163.214,
  verticalRate: -768,
  positionTimestamp: 1_791_512_303_000
}

describe('aircraft tuple encoding', () => {
  it('round-trips, rounding only below ADS-B resolution', () => {
    const decoded = decodeAircraft(encodeAircraft(sample))
    expect(decoded).toEqual({
      ...sample,
      lat: 47.450211,
      lon: -122.308846,
      groundSpeed: 142.4,
      track: 163.21
    })
  })

  it('keeps nulls and ground state', () => {
    const ground: AircraftState = {
      ...sample,
      altBaro: null,
      altGeom: null,
      onGround: true,
      groundSpeed: null,
      track: null,
      verticalRate: null,
      callsign: null
    }
    const json = JSON.parse(JSON.stringify(encodeAircraft(ground))) as ReturnType<
      typeof encodeAircraft
    >
    expect(decodeAircraft(json)).toMatchObject({
      altBaro: null,
      onGround: true,
      track: null,
      callsign: null
    })
  })
})
