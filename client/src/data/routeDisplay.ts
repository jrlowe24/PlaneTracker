import { airportCode, currentLeg, type RouteLeg } from '@windowseat/shared'

import type { TrackedAircraft } from './aircraftRegistry'
import { flightConnection } from './flightConnection'

export interface RouteDisplay {
  leg: RouteLeg
  /** "LAX → SEA" */
  short: string
  /** "Los Angeles (LAX) → Seattle (SEA)" */
  long: string
}

function place(airport: RouteLeg['from']): string {
  return `${airport.location ?? airport.name} (${airportCode(airport)})`
}

/** The leg this aircraft is flying, from its callsign's scheduled route. */
export function routeFor(aircraft: TrackedAircraft): RouteDisplay | null {
  const callsign = aircraft.state.callsign
  if (callsign == null) return null
  const route = flightConnection.routes.get(callsign)
  if (route == null) return null
  const lat = aircraft.pose?.lat ?? aircraft.state.lat
  const lon = aircraft.pose?.lon ?? aircraft.state.lon
  const leg = currentLeg(route, lat, lon, aircraft.state.onGround ? null : aircraft.state.track)
  if (leg == null) return null
  return {
    leg,
    short: `${airportCode(leg.from)} → ${airportCode(leg.to)}`,
    long: `${place(leg.from)} → ${place(leg.to)}`
  }
}
