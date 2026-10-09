import { angleDifference, greatCircleDistance, initialBearing } from './geo'

/**
 * Scheduled route for a callsign, from vradarserver's standing data
 * (CC0, served by adsb.lol). ADS-B itself carries no origin/destination.
 */
export interface RouteAirport {
  icao: string
  iata: string | null
  name: string
  /** City / location name. */
  location: string | null
  countryiso2: string | null
  lat: number
  lon: number
}

export interface RouteInfo {
  callsign: string
  /** Two or more airports; multi-leg routes list every stop. */
  airports: RouteAirport[]
}

export interface RouteLeg {
  from: RouteAirport
  to: RouteAirport
  /**
   * The aircraft's position and track fit this leg. Callsign routes are
   * schedules, not flight plans: a reused or wrong callsign gives an
   * implausible route that should be shown with caution or hidden.
   */
  plausible: boolean
}

/** Close to an airport, track says little (climb-out turns, approach patterns). */
const NEAR_AIRPORT_M = 25_000

/**
 * Picks the leg of a (possibly multi-leg) route the aircraft is flying:
 * the leg whose great circle it deviates from least, preferring legs whose
 * destination lies ahead of its track.
 */
export function currentLeg(
  route: RouteInfo,
  lat: number,
  lon: number,
  track: number | null
): RouteLeg | null {
  const airports = route.airports
  if (airports.length < 2) return null
  let best: { leg: RouteLeg; score: number } | null = null
  for (let i = 0; i < airports.length - 1; ++i) {
    const from = airports[i]!
    const to = airports[i + 1]!
    const legLength = greatCircleDistance(from.lat, from.lon, to.lat, to.lon)
    const fromDistance = greatCircleDistance(from.lat, from.lon, lat, lon)
    const toDistance = greatCircleDistance(lat, lon, to.lat, to.lon)
    const detour = fromDistance + toDistance - legLength
    const nearAirport = fromDistance < NEAR_AIRPORT_M || toDistance < NEAR_AIRPORT_M
    const headingOk =
      track == null ||
      nearAirport ||
      Math.abs(angleDifference(track, initialBearing(lat, lon, to.lat, to.lon))) < 100
    const plausible = headingOk && detour < Math.max(150_000, 0.35 * legLength)
    const score = detour + (headingOk ? 0 : 1e12)
    if (best == null || score < best.score) {
      best = { leg: { from, to, plausible }, score }
    }
  }
  return best?.leg ?? null
}

/** Airline-style callsign (ICAO airline code + flight number), worth a route lookup. */
export function isAirlineCallsign(callsign: string | null): callsign is string {
  return callsign != null && /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(callsign)
}

/** Short airport code for display: IATA, else ICAO. */
export function airportCode(airport: RouteAirport): string {
  return airport.iata ?? airport.icao
}
