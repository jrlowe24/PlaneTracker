import { describe, expect, it } from 'vitest'

import {
  angleDifference,
  destinationPoint,
  ecefToGeodetic,
  enuBasis,
  geodeticToEcef,
  greatCircleDistance,
  initialBearing,
  normalizeLongitude,
  WGS84_A,
  WGS84_B
} from './geo'

describe('geodeticToEcef', () => {
  it('maps the equator/prime meridian and poles to the ellipsoid axes', () => {
    const p = geodeticToEcef(0, 0, 0)
    expect(p.x).toBeCloseTo(WGS84_A, 6)
    expect(p.y).toBeCloseTo(0, 6)
    expect(p.z).toBeCloseTo(0, 6)
    const n = geodeticToEcef(90, 0, 100)
    expect(n.z).toBeCloseTo(WGS84_B + 100, 6)
    expect(Math.hypot(n.x, n.y)).toBeLessThan(1e-6)
  })

  it('matches an independent implementation (takram Geodetic.toECEF)', () => {
    // 47.4502 N, 122.3088 W, 132 m (near SEA), via @takram/three-geospatial.
    const p = geodeticToEcef(47.4502, -122.3088, 132)
    expect(p.x).toBeCloseTo(-2_309_517.852, 2)
    expect(p.y).toBeCloseTo(-3_652_053.99, 2)
    expect(p.z).toBeCloseTo(4_675_852.628, 2)
  })
})

describe('ecefToGeodetic', () => {
  it('round-trips with geodeticToEcef across latitudes and heights', () => {
    for (const lat of [-89.9, -60, -12.3, 0, 33.3, 47.45, 75, 89.99]) {
      for (const lon of [-179.9, -122.3, 0, 45, 179.9]) {
        for (const height of [-100, 0, 132, 11_000, 400_000]) {
          const p = geodeticToEcef(lat, lon, height)
          const g = ecefToGeodetic(p.x, p.y, p.z)
          expect(g.lat).toBeCloseTo(lat, 9)
          expect(normalizeLongitude(g.lon - lon)).toBeCloseTo(0, 9)
          expect(g.height).toBeCloseTo(height, 4)
        }
      }
    }
  })
})

describe('enuBasis', () => {
  it('is orthonormal and up matches the ellipsoid normal direction', () => {
    const { east, north, up } = enuBasis(47.45, -122.31)
    const dot = (a: typeof east, b: typeof east): number =>
      a.x * b.x + a.y * b.y + a.z * b.z
    expect(dot(east, east)).toBeCloseTo(1, 12)
    expect(dot(north, north)).toBeCloseTo(1, 12)
    expect(dot(up, up)).toBeCloseTo(1, 12)
    expect(dot(east, north)).toBeCloseTo(0, 12)
    expect(dot(east, up)).toBeCloseTo(0, 12)
    expect(dot(north, up)).toBeCloseTo(0, 12)
    // Moving up 1000 m changes ECEF along `up`.
    const a = geodeticToEcef(47.45, -122.31, 0)
    const b = geodeticToEcef(47.45, -122.31, 1000)
    expect((b.x - a.x) / 1000).toBeCloseTo(up.x, 9)
    expect((b.y - a.y) / 1000).toBeCloseTo(up.y, 9)
    expect((b.z - a.z) / 1000).toBeCloseTo(up.z, 9)
  })
})

describe('great-circle helpers', () => {
  it('computes distances and bearings', () => {
    // One degree of latitude ≈ 111.2 km on the mean sphere.
    expect(greatCircleDistance(0, 0, 1, 0)).toBeCloseTo(111_195, -1)
    expect(initialBearing(0, 0, 1, 0)).toBeCloseTo(0, 9)
    expect(initialBearing(0, 0, 0, 1)).toBeCloseTo(90, 9)
  })

  it('destinationPoint inverts distance and bearing', () => {
    const start = { lat: 51.47, lon: -0.45 }
    const end = destinationPoint(start.lat, start.lon, 63, 250_000)
    expect(greatCircleDistance(start.lat, start.lon, end.lat, end.lon)).toBeCloseTo(
      250_000,
      3
    )
    expect(initialBearing(start.lat, start.lon, end.lat, end.lon)).toBeCloseTo(63, 6)
  })

  it('wraps longitudes and angle differences', () => {
    expect(normalizeLongitude(190)).toBe(-170)
    expect(normalizeLongitude(-180)).toBe(-180)
    expect(angleDifference(350, 10)).toBe(20)
    expect(angleDifference(10, 350)).toBe(-20)
    expect(angleDifference(0, 180)).toBe(180)
  })
})
