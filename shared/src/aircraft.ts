/**
 * Normalized aircraft state, shared by server and client.
 *
 * Units are kept exactly as ADS-B reports them (feet, knots, ft/min, degrees)
 * so that what travels on the wire is easy to compare with the upstream feed.
 * Conversion to SI happens in one place: `./units.ts`.
 */
export interface AircraftState {
  /** ICAO 24-bit address as lowercase hex. Unique key. */
  hex: string
  callsign: string | null
  registration: string | null
  /** ICAO aircraft type designator, e.g. "A320", "B738". */
  typeCode: string | null
  /** Degrees, WGS84. */
  lat: number
  /** Degrees, WGS84. */
  lon: number
  /** Barometric (pressure) altitude in feet. Null when unknown or on ground. */
  altBaro: number | null
  /** Geometric (GNSS) altitude in feet above the WGS84 ellipsoid. */
  altGeom: number | null
  onGround: boolean
  /** Ground speed in knots. */
  groundSpeed: number | null
  /** True track over ground in degrees clockwise from north. */
  track: number | null
  /** Vertical rate in feet per minute (positive = climbing). */
  verticalRate: number | null
  /** Unix epoch milliseconds when the position was measured. */
  positionTimestamp: number
}
