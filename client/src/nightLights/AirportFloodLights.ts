import { ecefToGeodetic, geodeticToEcef, geoidHeight } from '@windowseat/shared'
import { Raycaster, Uniform, Vector3, Vector4 } from 'three'

/** Kept deliberately small: these loops run for every lit terrain pixel. */
export const MAX_AIRPORT_FLOOD_LIGHTS = 16

/** Shared with both the terrain night pass and detailed-aircraft materials. */
export const airportFloodLights = {
  count: new Uniform(0),
  /** Camera-relative ECEF position; w = reach in metres. */
  position: Array.from(
    { length: MAX_AIRPORT_FLOOD_LIGHTS },
    () => new Vector4()
  ),
  /** Renderer irradiance at one metre, already faded for time/weather. */
  color: Array.from(
    { length: MAX_AIRPORT_FLOOD_LIGHTS },
    () => new Vector3()
  )
}

interface FloodLight {
  lat: number
  lon: number
  ground: Vector3
  height: number
  sampledAt: number
}

const HEIGHT = 22
const RANGE = 145
const INTENSITY = 900
const KEEP_DISTANCE = 80_000
const SAMPLE_DISTANCE = 20_000
const RESAMPLE_MS = 20_000
const RAY_START = 5_000

const raycaster = new Raycaster()
;(raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
const rayOrigin = new Vector3()
const rayDown = new Vector3()

/** Elevated apron floodlights streamed from detailed OSM tiles. */
export class AirportFloodLightController {
  private readonly lights = new Map<string, FloodLight>()
  private reported = false

  add(records: Float32Array): void {
    for (let i = 0; i + 1 < records.length; i += 2) {
      const lon = records[i]!
      const lat = records[i + 1]!
      // About one metre: adjoining vector tiles can report the same mast.
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`
      if (this.lights.has(key)) continue
      const p = geodeticToEcef(lat, lon, 0)
      this.lights.set(key, {
        lat,
        lon,
        ground: new Vector3(p.x, p.y, p.z),
        height: Number.NaN,
        sampledAt: -Infinity
      })
    }
    if (import.meta.env.DEV && !this.reported && this.lights.size > 0) {
      this.reported = true
      console.info(
        `[airport lights] ${this.lights.size} elevated apron candidates loaded`
      )
    }
  }

  update(camera: Vector3, strength: number): void {
    const now = performance.now()
    for (const [key, light] of this.lights) {
      if (light.ground.distanceTo(camera) > KEEP_DISTANCE) this.lights.delete(key)
    }
    const nearest = [...this.lights.values()]
      .map(light => ({ light, distance: light.ground.distanceTo(camera) }))
      .filter(entry => entry.distance < KEEP_DISTANCE)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_AIRPORT_FLOOD_LIGHTS)

    const sample = nearest.find(
      entry =>
        entry.distance < SAMPLE_DISTANCE &&
        now - entry.light.sampledAt > RESAMPLE_MS
    )
    if (sample != null) void this.sampleHeight(sample.light, now)

    const count = strength > 0.001 ? nearest.length : 0
    airportFloodLights.count.value = count
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const debugWindow = window as unknown as {
        __windowSeatAirportLights?: unknown
      }
      debugWindow.__windowSeatAirportLights = {
        candidates: this.lights.size,
        active: count,
        strength
      }
    }
    for (let i = 0; i < count; ++i) {
      const light = nearest[i]!.light
      const height = Number.isFinite(light.height)
        ? light.height
        : geoidHeight(light.lat, light.lon)
      const p = geodeticToEcef(light.lat, light.lon, height + HEIGHT)
      airportFloodLights.position[i]!.set(
        p.x - camera.x,
        p.y - camera.y,
        p.z - camera.z,
        RANGE
      )
      airportFloodLights.color[i]!.set(
        INTENSITY * 0.95 * strength,
        INTENSITY * 0.87 * strength,
        INTENSITY * 0.72 * strength
      )
    }
  }

  clear(): void {
    this.lights.clear()
    airportFloodLights.count.value = 0
  }

  private async sampleHeight(light: FloodLight, now: number): Promise<void> {
    light.sampledAt = now
    // Dynamic to avoid the globe → semantic-water → road-tiles cycle.
    const { peekGoogleTiles } = await import('../globe/googleTiles')
    const ground = peekGoogleTiles()?.group
    if (ground == null) return
    const guess = Number.isFinite(light.height)
      ? light.height
      : geoidHeight(light.lat, light.lon)
    const start = geodeticToEcef(light.lat, light.lon, guess + RAY_START)
    rayOrigin.set(start.x, start.y, start.z)
    rayDown.copy(rayOrigin).normalize().negate()
    raycaster.set(rayOrigin, rayDown)
    raycaster.far = RAY_START * 2
    const hit = raycaster.intersectObject(ground, true)[0]
    if (hit == null) {
      light.sampledAt = now - RESAMPLE_MS + 2_000
      return
    }
    const height = ecefToGeodetic(
      hit.point.x,
      hit.point.y,
      hit.point.z
    ).height
    if (height > geoidHeight(light.lat, light.lon) - 450) {
      light.height = height
    }
  }
}
