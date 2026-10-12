import { geodeticToEcef } from '@windowseat/shared'
import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  airportFloodLights,
  AirportFloodLightController
} from './AirportFloodLights'

describe('elevated airport floodlights', () => {
  it('deduplicates candidates and publishes camera-relative lights', () => {
    const controller = new AirportFloodLightController()
    controller.add(
      new Float32Array([
        -122.31,
        47.45,
        -122.31,
        47.45,
        -122.309,
        47.451
      ])
    )
    const p = geodeticToEcef(47.45, -122.31, 30_000)
    controller.update(new Vector3(p.x, p.y, p.z), 0.75)

    expect(airportFloodLights.count.value).toBe(2)
    expect(airportFloodLights.position[0]!.w).toBeGreaterThan(100)
    expect(airportFloodLights.color[0]!.length()).toBeGreaterThan(0)

    controller.clear()
    expect(airportFloodLights.count.value).toBe(0)
  })
})
