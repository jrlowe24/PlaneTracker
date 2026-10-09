import { describe, expect, it } from 'vitest'

import { currentLeg, isAirlineCallsign, type RouteAirport, type RouteInfo } from './routes'

const SEA: RouteAirport = { icao: 'KSEA', iata: 'SEA', name: 'Seattle Tacoma', location: 'Seattle', countryiso2: 'US', lat: 47.449, lon: -122.309 }
const BLI: RouteAirport = { icao: 'KBLI', iata: 'BLI', name: 'Bellingham', location: 'Bellingham', countryiso2: 'US', lat: 48.7928, lon: -122.538 }
const LAX: RouteAirport = { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles', location: 'Los Angeles', countryiso2: 'US', lat: 33.9425, lon: -118.408 }

describe('currentLeg', () => {
  it('finds the single leg and flags plausibility', () => {
    const route: RouteInfo = { callsign: 'ASA1305', airports: [LAX, SEA] }
    // Over Oregon heading north-west towards SEA.
    const leg = currentLeg(route, 44.5, -121.5, 340)!
    expect(leg.from.iata).toBe('LAX')
    expect(leg.to.iata).toBe('SEA')
    expect(leg.plausible).toBe(true)
    // Over Chicago: not this flight.
    expect(currentLeg(route, 41.9, -87.6, 270)!.plausible).toBe(false)
  })

  it('uses the track to pick the leg of an out-and-back route', () => {
    const route: RouteInfo = { callsign: 'SKW3433', airports: [SEA, BLI, SEA] }
    // Halfway, heading north: SEA → BLI.
    const north = currentLeg(route, 48.1, -122.4, 355)!
    expect([north.from.iata, north.to.iata]).toEqual(['SEA', 'BLI'])
    // Same place heading south: BLI → SEA.
    const south = currentLeg(route, 48.1, -122.4, 175)!
    expect([south.from.iata, south.to.iata]).toEqual(['BLI', 'SEA'])
    expect(south.plausible).toBe(true)
  })

  it('ignores track near airports and handles missing data', () => {
    const route: RouteInfo = { callsign: 'ASA1305', airports: [LAX, SEA] }
    // On approach to SEA heading south (downwind) is still this route.
    expect(currentLeg(route, 47.6, -122.35, 160)!.plausible).toBe(true)
    expect(currentLeg({ callsign: 'X', airports: [SEA] }, 47, -122, 0)).toBeNull()
  })
})

describe('isAirlineCallsign', () => {
  it('accepts airline callsigns and rejects registrations', () => {
    expect(isAirlineCallsign('ASA1305')).toBe(true)
    expect(isAirlineCallsign('DLH4AB')).toBe(true)
    expect(isAirlineCallsign('N5667D')).toBe(false)
    expect(isAirlineCallsign('CGJAZ')).toBe(false)
    expect(isAirlineCallsign(null)).toBe(false)
  })
})
