/**
 * The single place where ADS-B units are converted to SI.
 * Everything on the wire stays in feet / knots / ft-per-minute.
 */

export const METERS_PER_FOOT = 0.3048
export const METERS_PER_NAUTICAL_MILE = 1852
export const SECONDS_PER_HOUR = 3600
export const SECONDS_PER_MINUTE = 60

export function feetToMeters(feet: number): number {
  return feet * METERS_PER_FOOT
}

export function metersToFeet(meters: number): number {
  return meters / METERS_PER_FOOT
}

export function knotsToMetersPerSecond(knots: number): number {
  return (knots * METERS_PER_NAUTICAL_MILE) / SECONDS_PER_HOUR
}

export function feetPerMinuteToMetersPerSecond(feetPerMinute: number): number {
  return (feetPerMinute * METERS_PER_FOOT) / SECONDS_PER_MINUTE
}

export function nauticalMilesToMeters(nauticalMiles: number): number {
  return nauticalMiles * METERS_PER_NAUTICAL_MILE
}

export function metersToNauticalMiles(meters: number): number {
  return meters / METERS_PER_NAUTICAL_MILE
}
