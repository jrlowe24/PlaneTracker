import { createStore } from '../state/createStore'
import { flightConnection } from './flightConnection'

export interface UserLocationState {
  /** The user's location (browser geolocation), if granted. */
  position: { lat: number; lon: number } | null
  status: 'idle' | 'locating' | 'granted' | 'denied' | 'unavailable'
}

export const userLocationStore = createStore<UserLocationState>({ position: null, status: 'idle' })

/** Moves under this (meters, roughly) don't resend the location. */
const MIN_MOVE_DEGREES = 0.02

/**
 * Asks for the user's location (once; the browser remembers the choice) and
 * keeps following it at low accuracy. The server keeps traffic within
 * HOME_RADIUS_NM of it live, so "near you" works wherever the camera is.
 */
export function startUserLocation(): void {
  if (userLocationStore.get().status !== 'idle') return
  if (!('geolocation' in navigator)) {
    userLocationStore.set({ status: 'unavailable' })
    return
  }
  userLocationStore.set({ status: 'locating' })
  navigator.geolocation.watchPosition(
    ({ coords }) => {
      const last = userLocationStore.get().position
      const position = { lat: coords.latitude, lon: coords.longitude }
      if (
        last != null &&
        Math.abs(last.lat - position.lat) < MIN_MOVE_DEGREES &&
        Math.abs(last.lon - position.lon) < MIN_MOVE_DEGREES
      ) {
        return
      }
      userLocationStore.set({ position, status: 'granted' })
      flightConnection.setHome(position)
    },
    error => {
      userLocationStore.set({
        status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'
      })
    },
    { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 20_000 }
  )
}
