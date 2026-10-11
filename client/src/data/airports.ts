/**
 * Airport search, from the OurAirports index built at deploy time
 * (scripts/build-runways.mjs): every airport with an IATA code plus all
 * large and medium ones. Loaded on the first search, then cached.
 */

export interface Airport {
  iata: string
  icao: string
  name: string
  city: string
  country: string
  lat: number
  lon: number
  /** 2 large, 1 medium, 0 other. */
  size: number
}

type Entry = [string, string, string, string, string, number, number, number]

let loading: Promise<Airport[]> | null = null

export function loadAirports(): Promise<Airport[]> {
  loading ??= fetch('/runways/airports.json')
    .then(async response => (response.ok ? ((await response.json()) as Entry[]) : []))
    .then(entries =>
      entries.map(([iata, icao, name, city, country, lat, lon, size]) => ({ iata, icao, name, city, country, lat, lon, size }))
    )
    .catch(() => {
      loading = null
      return []
    })
  return loading
}

/** Words of a name or city, lowercased, for prefix matches ("int" → "International"). */
function wordStarts(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  if (lower.startsWith(query)) return true
  return lower.split(/[\s\-/(),.]+/).some(word => word.startsWith(query))
}

function score(airport: Airport, query: string, upper: string): number {
  let s = 0
  if (airport.iata === upper) s = 100
  else if (airport.icao === upper) s = 95
  else if (airport.city.toLowerCase().startsWith(query)) s = 50
  else if (upper.length >= 2 && airport.iata.startsWith(upper)) s = 48
  else if (airport.name.toLowerCase().startsWith(query)) s = 45
  else if (query.length >= 3 && (wordStarts(airport.city, query) || wordStarts(airport.name, query))) s = 35
  else if (upper.length >= 3 && airport.icao.startsWith(upper)) s = 25
  else if (query.length >= 4 && `${airport.name} ${airport.city}`.toLowerCase().includes(query)) s = 20
  if (s === 0) return 0
  // Bigger airports first among similar matches; an exact code always wins.
  return s + airport.size * 4
}

/** Best matches for a query (codes, city or name), biggest airports first. */
export function searchAirports(airports: readonly Airport[], query: string, limit = 5): Airport[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const upper = q.toUpperCase()
  const scored: Array<{ airport: Airport; score: number }> = []
  for (const airport of airports) {
    const s = score(airport, q, upper)
    if (s > 0) scored.push({ airport, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(entry => entry.airport)
}

/** The airport a query names exactly by code, if any. */
export function exactAirport(airports: readonly Airport[], query: string): Airport | null {
  const upper = query.trim().toUpperCase()
  if (upper.length < 3 || upper.length > 4) return null
  return airports.find(a => a.iata === upper || a.icao === upper) ?? null
}
