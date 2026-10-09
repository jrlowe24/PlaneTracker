import type { AircraftClass } from './airframes'

/**
 * ICAO type designator → airframe class. Covers the common types; anything
 * else falls back to the ADS-B emitter category, then 'generic'.
 */
const CLASS_BY_TYPE: Record<string, AircraftClass> = {}

function add(cls: AircraftClass, types: string): void {
  for (const type of types.split(/\s+/)) {
    if (type !== '') CLASS_BY_TYPE[type] = cls
  }
}

add(
  'narrowbody',
  `A318 A319 A320 A321 A19N A20N A21N BCS1 BCS3 B712 B717 B721 B722 B732 B733 B734 B735
   B736 B737 B738 B739 B37M B38M B39M B3XM B752 B753 MD80 MD81 MD82 MD83 MD87 MD88 MD90
   C919 T204 T214 F100`
)
add(
  'widebody',
  `A306 A30B A310 A332 A333 A337 A338 A339 A342 A343 A345 A346 A359 A35K A388 B741 B742
   B743 B744 B748 B74S B762 B763 B764 B772 B773 B77L B77W B778 B779 B788 B789 B78X DC10
   MD11 IL96 A3ST`
)
add(
  'regional',
  `CRJ1 CRJ2 CRJ7 CRJ9 CRJX E135 E145 E170 E175 E75L E75S E190 E195 E290 E295 SU95 AR85
   AR1 RJ70 RJ85 RJ1H B461 B462 B463 J328`
)
add(
  'turboprop',
  `AT43 AT45 AT46 AT72 AT75 AT76 DH8A DH8B DH8C DH8D SF34 SB20 JS31 JS32 JS41 D328 E120
   F50 C130 C30J A400 L188 BE20 BE30 BE35 B350 BE9L BE99 PC12 PC24 C208 KODI TBM7 TBM8
   TBM9 P180 DHC6 AN26 AN24 L410 C212 SW4`
)
add(
  'bizjet',
  `GLF4 GLF5 GLF6 GL5T GL7T GLEX G150 G280 GALX CL30 CL35 CL60 C25A C25B C25C C25M C500
   C501 C510 C525 C550 C560 C56X C650 C680 C68A C700 C750 E50P E55P E545 E550 FA10 FA20
   FA50 FA7X FA8X F2TH F900 LJ35 LJ40 LJ45 LJ60 LJ75 H25B HA4T PRM1 SF50 HDJT`
)
add(
  'helicopter',
  `EC20 EC25 EC30 EC35 EC45 EC55 EC75 H120 H125 H130 H135 H145 H155 H160 H175 AS32 AS50
   AS55 AS65 B06 B105 B212 B407 B412 B429 B430 B505 S76 S92 H47 H53 H60 H64 UH1 R22 R44
   R66 A109 A119 A139 A169 A189 AW09 MI8 BK17 NH90 EH10 V22`
)
add(
  'light',
  `C150 C152 C162 C170 C172 C175 C177 C180 C182 C185 C195 C206 C207 C210 C310 C340 C402
   C414 C421 P28A P28B P28R P28T P32R P46T PA11 PA12 PA18 PA20 PA22 PA24 PA27 PA30 PA31
   PA34 PA44 PA46 M20P M20T SR20 SR22 S22T DA20 DA40 DA42 DA62 BE33 BE36 BE55 BE58 BE76
   AA5 RV6 RV7 RV8 RV10 RV12 RV14 GLAS J3 CH7A AT3 G115 TB20 TBM`
)

/** ADS-B emitter category fallback. */
function classFromCategory(category: string | null): AircraftClass | null {
  switch (category) {
    case 'A1':
      return 'light'
    case 'A2':
      return 'bizjet'
    case 'A3':
      return 'narrowbody'
    case 'A4':
      // B757 / high-vortex large.
      return 'narrowbody'
    case 'A5':
      return 'widebody'
    case 'A7':
      return 'helicopter'
    case 'B1':
    case 'B4':
      return 'light'
    default:
      return null
  }
}

export function aircraftClass(
  typeCode: string | null,
  category: string | null = null
): AircraftClass {
  if (typeCode != null) {
    const cls = CLASS_BY_TYPE[typeCode.toUpperCase()]
    if (cls != null) return cls
  }
  return classFromCategory(category) ?? 'generic'
}
