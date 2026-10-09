import { AIRFRAMES, type AircraftClass, type AirframeParams } from './airframes'

/**
 * Real length and wingspan (meters) of common types, so a class placeholder
 * can be scaled to the actual aircraft (a B763 is 55 m long, not the 70 m
 * of the widebody placeholder). Manufacturer figures, rounded.
 */
const DIMENSIONS: Record<string, [length: number, span: number]> = {
  // Airbus narrowbody
  A318: [31.4, 34.1], A319: [33.8, 35.8], A19N: [33.8, 35.8], A320: [37.6, 35.8],
  A20N: [37.6, 35.8], A321: [44.5, 35.8], A21N: [44.5, 35.8],
  BCS1: [35.0, 35.1], BCS3: [38.7, 35.1],
  // Boeing narrowbody
  B712: [37.8, 28.4], B733: [33.4, 28.9], B734: [36.4, 28.9], B735: [31.0, 28.9],
  B736: [31.2, 34.3], B737: [33.6, 34.3], B738: [39.5, 35.8], B739: [42.1, 35.8],
  B37M: [35.6, 35.9], B38M: [39.5, 35.9], B39M: [42.2, 35.9], B3XM: [43.8, 35.9],
  B752: [47.3, 38.1], B753: [54.4, 38.1],
  MD82: [45.1, 32.9], MD83: [45.1, 32.9], MD88: [45.1, 32.9], MD90: [46.5, 32.9],
  // Widebody
  A306: [54.1, 44.8], A310: [46.7, 43.9], A332: [58.8, 60.3], A333: [63.7, 60.3],
  A338: [58.8, 64.0], A339: [63.7, 64.0], A343: [63.7, 60.3], A346: [75.4, 63.5],
  A359: [66.8, 64.8], A35K: [73.8, 64.8], A388: [72.7, 79.8],
  B744: [70.7, 64.4], B748: [76.3, 68.4], B74F: [70.7, 64.4],
  B762: [48.5, 47.6], B763: [54.9, 47.6], B764: [61.4, 51.9],
  B772: [63.7, 60.9], B77L: [63.7, 64.8], B773: [73.9, 60.9], B77W: [73.9, 64.8],
  B778: [70.9, 71.8], B779: [76.7, 71.8],
  B788: [56.7, 60.1], B789: [62.8, 60.1], B78X: [68.3, 60.1],
  MD11: [61.6, 51.7], DC10: [55.5, 50.4],
  // Regional
  E135: [26.3, 20.0], E145: [29.9, 20.0], E170: [29.9, 26.0], E175: [31.7, 26.0],
  E75L: [31.7, 26.0], E75S: [31.7, 26.0], E190: [36.2, 28.7], E195: [38.7, 28.7],
  E290: [36.2, 33.7], E295: [41.5, 35.1],
  CRJ2: [26.8, 21.2], CRJ7: [32.5, 23.2], CRJ9: [36.2, 24.9], CRJX: [39.1, 26.2],
  // Turboprop
  AT43: [22.7, 24.6], AT45: [22.7, 24.6], AT72: [27.2, 27.1], AT75: [27.2, 27.1],
  AT76: [27.2, 27.1], DH8A: [22.3, 25.9], DH8C: [25.7, 27.4], DH8D: [32.8, 28.4],
  SF34: [19.7, 21.4], C208: [11.5, 15.9], PC12: [14.4, 16.3], B350: [14.2, 17.7],
  BE20: [13.3, 16.6], DHC6: [15.8, 19.8], C130: [29.8, 40.4], C30J: [34.4, 40.4],
  // Business jets
  GLF4: [26.9, 23.7], GLF5: [29.4, 28.5], GLF6: [30.4, 30.4], GLEX: [30.3, 28.7],
  GL7T: [33.8, 31.7], CL30: [20.9, 19.5], CL35: [20.9, 21.0], CL60: [20.9, 19.6],
  C25A: [14.4, 15.5], C25B: [15.6, 15.9], C25C: [16.3, 16.3], C510: [12.4, 13.2],
  C525: [12.9, 14.3], C560: [14.9, 15.9], C56X: [15.8, 17.2], C680: [19.4, 19.4],
  C68A: [20.7, 22.0], C700: [22.3, 21.0], C750: [22.0, 19.4], E50P: [12.8, 12.3],
  E55P: [15.6, 16.2], E545: [20.7, 20.0], FA7X: [23.2, 26.2], FA8X: [24.5, 26.3],
  F2TH: [20.2, 19.3], F900: [20.2, 19.3], LJ45: [17.7, 14.6], LJ75: [17.7, 15.5],
  PC24: [16.9, 17.0], SF50: [9.4, 11.8], HDJT: [13.0, 12.1],
  // Light
  C150: [7.3, 10.1], C152: [7.3, 10.1], C172: [8.3, 11.0], C182: [8.8, 11.0],
  C206: [8.6, 11.0], C210: [8.6, 11.2], P28A: [7.3, 10.7], P28R: [7.6, 10.8],
  PA46: [8.8, 13.1], SR20: [7.9, 11.7], SR22: [7.9, 11.7], DA40: [8.1, 11.9],
  DA42: [8.6, 13.4], BE36: [8.4, 10.2], BE58: [9.1, 11.5], M20P: [7.5, 11.0],
  // Helicopters (length incl. rotor, rotor diameter as span)
  EC35: [12.2, 10.2], EC45: [13.0, 11.0], H135: [12.2, 10.2], H145: [13.6, 11.0],
  AS50: [12.9, 10.7], B06: [11.9, 10.2], B407: [12.7, 10.7], B429: [12.7, 11.0],
  R44: [11.7, 10.1], R22: [8.8, 7.7], S76: [16.0, 13.4], A139: [16.7, 13.8],
  H60: [19.8, 16.4]
}

export interface AirframeScale {
  /** Spanwise (model X). */
  span: number
  /** Lengthwise and vertical (model Z and Y). */
  length: number
}

/**
 * Display size relative to real dimensions. True scale read as oversized
 * against the photogrammetry (whose buildings and runways look smaller than
 * their nominal size from the air).
 */
export const AIRCRAFT_SIZE_SCALE = 0.75

/** Displayed [length, span] in meters: the type's, else the class placeholder's. */
export function typeDimensions(typeCode: string | null, cls: AircraftClass): [number, number] {
  const dims = typeCode == null ? undefined : DIMENSIONS[typeCode.toUpperCase()]
  const params = AIRFRAMES[cls]
  const [length, span] = dims ?? [params.length, params.rotorDiameter ?? params.wingSpan]
  return [length * AIRCRAFT_SIZE_SCALE, span * AIRCRAFT_SIZE_SCALE]
}

/** Scale from the class placeholder to the real type (1, 1 if unknown). */
export function airframeScale(typeCode: string | null, cls: AircraftClass): AirframeScale {
  const params = AIRFRAMES[cls]
  const dims = typeDimensions(typeCode, cls)
  const length = dims[0] / params.length
  // Helicopters: "span" is the rotor; the placeholder's rotor diameter.
  const classSpan = params.rotorDiameter ?? params.wingSpan
  const span = classSpan > 0 ? dims[1] / classSpan : length
  return { span, length }
}

/** Class parameters scaled to the real type (for seat position, gear height). */
export function scaledAirframe(params: AirframeParams, scale: AirframeScale): AirframeParams {
  if (scale.span === 1 && scale.length === 1) return params
  const l = scale.length
  return {
    ...params,
    length: params.length * l,
    groundClearance: params.groundClearance * l,
    fuselageRadius: params.fuselageRadius * l,
    wingSpan: params.wingSpan * scale.span,
    wingRootChord: params.wingRootChord * l,
    wingTipChord: params.wingTipChord * l,
    wingRootZ: params.wingRootZ * l,
    wingThickness: params.wingThickness * l
  }
}
