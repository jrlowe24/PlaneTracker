import type { AircraftState } from '@windowseat/shared'

/** A ground circle to fetch aircraft for. */
export interface Region {
  /** Degrees. */
  lat: number
  /** Degrees. */
  lon: number
  /** Nautical miles. */
  radiusNm: number
}

export interface FlightSourceListener {
  /** New or refreshed aircraft states. `receivedAt` is server wall time (ms). */
  onAircraft: (states: AircraftState[], receivedAt: number) => void
  /** The source jumped in time (replay loop); clients should start over. */
  onReset?: () => void
}

/**
 * Upstream flight data. Implementations: adsb.lol (live), replay (recorded
 * fixture) and synthetic (stress test). OpenSky, airplanes.live or a paid
 * feed can be added by implementing this interface and normalizing into
 * AircraftState.
 */
export interface FlightSource {
  readonly name: string
  /** Attribution the client must display while this source is active. */
  readonly attribution: string
  readonly attributionUrl: string | null
  /**
   * The regions clients currently look at. Region-less sources (replay,
   * synthetic) may ignore this.
   */
  setRegions: (regions: Region[]) => void
  start: (listener: FlightSourceListener) => void
  stop: () => void
}
