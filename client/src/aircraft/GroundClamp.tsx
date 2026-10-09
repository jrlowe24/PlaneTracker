import { useFrame } from '@react-three/fiber'
import { DEG, geodeticToEcef, geoidHeight, WGS84_A, WGS84_E2 } from '@windowseat/shared'
import { useMemo, type FC } from 'react'
import { Raycaster, Vector3, type Object3D } from 'three'

import { config } from '../config'
import type { TrackedAircraft } from '../data/aircraftRegistry'
import { flightConnection } from '../data/flightConnection'
import { getGoogleTiles } from '../globe/googleTiles'

/** Only aircraft this close to the camera are clamped (beyond, icons hide errors). */
const CLAMP_DISTANCE = 40_000
const RAYCASTS_PER_FRAME = 3
const RECHECK_MS = 4000
const RECHECK_METERS = 25
/** Rays start this far above the geoid + last ground estimate. */
const RAY_START_HEIGHT = 400
/** Airborne aircraft below this altitude (ft) are clamped to the terrain too. */
const LOW_ALTITUDE_FT = 3000

interface ClampRecord {
  lat: number
  lon: number
  at: number
}

const origin = new Vector3()
const direction = new Vector3()

/** Ellipsoid normal (geodetic up) at a latitude/longitude. */
function geodeticUp(latDeg: number, lonDeg: number, out: Vector3): Vector3 {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  return out.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
}

/** Ellipsoid height of an ECEF point given the latitude it lies at (fast, exact for points along the normal). */
function heightAlongNormal(point: Vector3, latDeg: number): number {
  const sinLat = Math.sin(latDeg * DEG)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  const p = Math.hypot(point.x, point.y)
  return Math.abs(latDeg) < 45
    ? p / Math.cos(latDeg * DEG) - n
    : point.z / sinLat - n * (1 - WGS84_E2)
}

/**
 * Puts on-ground aircraft on the photorealistic tiles: ADS-B reports no
 * altitude on the ground, so a few rays per frame are cast straight down at
 * nearby taxiing/parked aircraft and the hit height replaces their sample
 * heights. Results are cached until the aircraft moves or the tiles refine.
 */
class GroundClampController {
  private readonly raycaster = new Raycaster()
  private readonly records = new WeakMap<TrackedAircraft, ClampRecord>()

  constructor() {
    // 3d-tiles-renderer honors firstHitOnly for fast tile raycasts.
    ;(this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
  }

  update(ground: Object3D | null): void {
    const now = performance.now()
    let budget = RAYCASTS_PER_FRAME
    for (const aircraft of flightConnection.registry.list) {
      if (budget === 0) break
      const state = aircraft.state
      // On-ground aircraft, and low aircraft (approach/departure) so that
      // late data can't push them through the terrain.
      const low = !state.onGround && (state.altGeom ?? state.altBaro ?? Infinity) < LOW_ALTITUDE_FT
      if ((!state.onGround && !low) || aircraft.cameraDistance > CLAMP_DISTANCE) continue
      const record = this.records.get(aircraft)
      if (record != null) {
        const moved =
          Math.hypot(
            (state.lat - record.lat) * 111_000,
            (state.lon - record.lon) * 111_000 * Math.cos(state.lat * DEG)
          ) > RECHECK_METERS
        if (!moved && now - record.at < RECHECK_MS) continue
      }
      this.records.set(aircraft, { lat: state.lat, lon: state.lon, at: now })
      --budget

      if (ground == null) {
        // Plain ellipsoid globe: the ground is at height 0.
        flightConnection.registry.setGroundHeight(aircraft.hex, 0)
        continue
      }
      const guess = aircraft.groundHeight ?? geoidHeight(state.lat, state.lon)
      // Low aircraft: start above the aircraft (terrain may be higher than a
      // stale guess in hilly areas).
      const top = low ? Math.max(guess + RAY_START_HEIGHT, (state.altGeom ?? 0) * 0.3048 + 50) : guess + RAY_START_HEIGHT
      const start = geodeticToEcef(state.lat, state.lon, top)
      origin.set(start.x, start.y, start.z)
      geodeticUp(state.lat, state.lon, direction).negate()
      this.raycaster.set(origin, direction)
      this.raycaster.far = top - guess + RAY_START_HEIGHT * 3
      const hit = this.raycaster.intersectObject(ground, true)[0]
      if (hit != null) {
        flightConnection.registry.setGroundHeight(
          aircraft.hex,
          heightAlongNormal(hit.point, state.lat)
        )
      }
    }
  }
}

export const GroundClamp: FC = () => {
  const controller = useMemo(() => new GroundClampController(), [])
  const ground = useMemo(
    () => (config.tilesDisabled ? null : getGoogleTiles({ apiKey: config.googleMapsApiKey }).group),
    []
  )
  useFrame(() => {
    controller.update(ground)
  })
  return null
}
