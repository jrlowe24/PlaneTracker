import type { AircraftState } from '@windowseat/shared'

import type { AircraftClass } from './airframes'

/**
 * What kind of flight an aircraft is, for its map color: airline, cargo,
 * business/private, general aviation, helicopter, military, or unknown.
 * From the airframe class, the callsign (ICAO airline prefix + flight
 * number) and known military address blocks and callsigns.
 */
export type AircraftCategory = 'airline' | 'cargo' | 'business' | 'general' | 'helicopter' | 'military' | 'other'

export const CATEGORY_LABELS: Record<AircraftCategory, string> = {
  airline: 'Airline',
  cargo: 'Cargo',
  business: 'Business',
  general: 'General aviation',
  helicopter: 'Helicopter',
  military: 'Military',
  other: 'Other'
}

/** Marker colors (sRGB hex), distinct on terrain, ocean and night. */
export const CATEGORY_COLORS: Record<AircraftCategory, string> = {
  airline: '#ffd166',
  cargo: '#63b3ed',
  business: '#b794f6',
  general: '#4fd1c5',
  helicopter: '#f687b3',
  military: '#9ae6b4',
  other: '#cbd5e0'
}

/** ICAO prefixes of all-cargo airlines (and cargo divisions flying under their own code). */
const CARGO = new Set(
  `FDX UPS GTI ABX ATN CKS CLX BOX GEC CAO DHK BCS DAE DHX AJT NCA MPH CLU ABW SQC ICV TAY
   SRR WGN KYE PAC CKK CSS LCO TPA ABD AHK QAC NPT RCF ESK SWN JOS CVK MXL WAL`
    .split(/\s+/)
    .filter(code => code.length === 3)
)

/** Military / government transport callsign prefixes (ICAO telephony codes). */
const MILITARY_CALLSIGN = /^(RCH|REACH|CNV|PAT|NAVY|ARMY|SAM|VV|EVAC|RRR|ASCOT|CFC|GAF|FAF|IAM|BAF|NATO|MMF|DUKE|SPAR|VENUS|ORDER|KING|PEDRO|JAKE|TOPCT|HKY|SNTRY|HOMER|TABOR|BOLT|SLAM|RAZOR|VIPER|COBRA|HAWK|EAGLE)\d+$/

/** ICAO address blocks allocated to military operators. */
const MILITARY_BLOCKS: Array<[number, number]> = [
  [0xadf7c8, 0xafffff], // United States
  [0x43c000, 0x43cfff], // United Kingdom
  [0x3aa000, 0x3affff], // France
  [0x3f4000, 0x3fbfff], // Germany
  [0x7cf800, 0x7cfaff] // Australia
]

const AIRLINE_CALLSIGN = /^[A-Z]{3}\d/

function militaryAddress(hex: string): boolean {
  const value = Number.parseInt(hex, 16)
  if (!Number.isFinite(value)) return false
  return MILITARY_BLOCKS.some(([lo, hi]) => value >= lo && value <= hi)
}

export function aircraftCategory(state: AircraftState, cls: AircraftClass): AircraftCategory {
  const callsign = (state.callsign ?? '').trim().toUpperCase()
  if (militaryAddress(state.hex) || MILITARY_CALLSIGN.test(callsign)) return 'military'
  if (cls === 'helicopter' || state.category === 'A7') return 'helicopter'
  const airlineCallsign = AIRLINE_CALLSIGN.test(callsign)
  if (airlineCallsign && CARGO.has(callsign.slice(0, 3))) return 'cargo'
  switch (cls) {
    case 'narrowbody':
    case 'widebody':
    case 'regional':
      return 'airline'
    case 'turboprop':
      return airlineCallsign ? 'airline' : 'business'
    case 'bizjet':
      return 'business'
    case 'light':
      return 'general'
    default:
      if (state.category === 'A1' || state.category === 'B1' || state.category === 'B4') return 'general'
      if (state.category === 'A2') return 'business'
      if (state.category === 'A3' || state.category === 'A4' || state.category === 'A5') return 'airline'
      return airlineCallsign ? 'airline' : 'other'
  }
}
