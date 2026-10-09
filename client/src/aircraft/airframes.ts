import {
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  ExtrudeGeometry,
  LatheGeometry,
  Shape,
  Vector2,
  type BufferGeometry
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Procedural low-poly airframes. Model space follows glTF conventions so
 * dropped-in glTF models line up: +Z forward (nose), +Y up, +X left wing.
 * Units are meters; the origin is roughly the center of gravity (on the
 * fuselage axis, around the wing root).
 */

export type AircraftClass =
  | 'narrowbody'
  | 'widebody'
  | 'regional'
  | 'turboprop'
  | 'bizjet'
  | 'helicopter'
  | 'light'
  | 'generic'

export interface AirframeParams {
  length: number
  /** Height of the fuselage axis above the ground when standing on the gear. */
  groundClearance: number
  fuselageRadius: number
  wingSpan: number
  wingRootChord: number
  wingTipChord: number
  /** Leading-edge sweep, degrees. */
  wingSweep: number
  /** Wing root leading edge, meters forward of the origin. */
  wingRootZ: number
  /** Wing vertical position relative to the fuselage axis (−1 low … +1 high). */
  wingMount: number
  /** Wing dihedral, degrees. */
  wingDihedral: number
  wingThickness: number
  engines: {
    /** Spanwise positions (|x|), one per side; empty for none. */
    stations: number[]
    radius: number
    length: number
    /** Engines mounted on the rear fuselage instead of under the wing. */
    rearMounted?: boolean
    /** Propeller disc instead of a turbofan nacelle. */
    propeller?: boolean
  }
  tailSpan: number
  tailChord: number
  finHeight: number
  finChord: number
  /** Horizontal tail on top of the fin. */
  tTail: boolean
  /** Main rotor diameter; makes the airframe a helicopter (no wings). */
  rotorDiameter?: number
}

export const AIRFRAMES: Record<AircraftClass, AirframeParams> = {
  // A320 / B737 family.
  narrowbody: {
    groundClearance: 3.6,
    length: 38,
    fuselageRadius: 1.98,
    wingSpan: 35.8,
    wingRootChord: 7,
    wingTipChord: 1.6,
    wingSweep: 27,
    wingRootZ: 3,
    wingMount: -0.55,
    wingDihedral: 5,
    wingThickness: 0.6,
    engines: { stations: [5.8], radius: 1.05, length: 4.4 },
    tailSpan: 12.5,
    tailChord: 3.6,
    finHeight: 6.2,
    finChord: 5.5,
    tTail: false
  },
  // B777 / A350.
  widebody: {
    groundClearance: 5.4,
    length: 70,
    fuselageRadius: 3.1,
    wingSpan: 64.8,
    wingRootChord: 12,
    wingTipChord: 2.4,
    wingSweep: 31,
    wingRootZ: 6,
    wingMount: -0.55,
    wingDihedral: 6,
    wingThickness: 1,
    engines: { stations: [9.7], radius: 1.8, length: 7 },
    tailSpan: 21.5,
    tailChord: 6,
    finHeight: 10.5,
    finChord: 9,
    tTail: false
  },
  // E175 / CRJ900.
  regional: {
    groundClearance: 2.8,
    length: 31.7,
    fuselageRadius: 1.5,
    wingSpan: 26,
    wingRootChord: 5,
    wingTipChord: 1.3,
    wingSweep: 25,
    wingRootZ: 2.5,
    wingMount: -0.55,
    wingDihedral: 5,
    wingThickness: 0.45,
    engines: { stations: [4.5], radius: 0.75, length: 3.3 },
    tailSpan: 10,
    tailChord: 2.8,
    finHeight: 5.5,
    finChord: 4.5,
    tTail: false
  },
  // ATR 72 / Dash 8.
  turboprop: {
    groundClearance: 2.6,
    length: 27.2,
    fuselageRadius: 1.4,
    wingSpan: 27,
    wingRootChord: 2.6,
    wingTipChord: 1.4,
    wingSweep: 3,
    wingRootZ: 2.5,
    wingMount: 0.85,
    wingDihedral: 2,
    wingThickness: 0.35,
    engines: { stations: [4.1], radius: 0.55, length: 3.2, propeller: true },
    tailSpan: 7.3,
    tailChord: 2,
    finHeight: 4.8,
    finChord: 3.6,
    tTail: true
  },
  // Gulfstream / Challenger.
  bizjet: {
    groundClearance: 2.2,
    length: 28,
    fuselageRadius: 1.25,
    wingSpan: 28.5,
    wingRootChord: 4.6,
    wingTipChord: 1.1,
    wingSweep: 33,
    wingRootZ: 0.5,
    wingMount: -0.6,
    wingDihedral: 4,
    wingThickness: 0.4,
    engines: { stations: [2.2], radius: 0.6, length: 3.5, rearMounted: true },
    tailSpan: 9.5,
    tailChord: 2.2,
    finHeight: 4.6,
    finChord: 3.8,
    tTail: true
  },
  helicopter: {
    groundClearance: 1.6,
    length: 13,
    fuselageRadius: 1.1,
    wingSpan: 0,
    wingRootChord: 0,
    wingTipChord: 0,
    wingSweep: 0,
    wingRootZ: 0,
    wingMount: 0,
    wingDihedral: 0,
    wingThickness: 0,
    engines: { stations: [], radius: 0, length: 0 },
    tailSpan: 2.2,
    tailChord: 0.6,
    finHeight: 1.6,
    finChord: 1,
    tTail: false,
    rotorDiameter: 11
  },
  // Cessna 172 / Piper.
  light: {
    groundClearance: 1.3,
    length: 8.3,
    fuselageRadius: 0.62,
    wingSpan: 11,
    wingRootChord: 1.6,
    wingTipChord: 1.2,
    wingSweep: 0,
    wingRootZ: 1.6,
    wingMount: 0.95,
    wingDihedral: 1.5,
    wingThickness: 0.18,
    engines: { stations: [0], radius: 0.5, length: 1.4, propeller: true },
    tailSpan: 3.4,
    tailChord: 1,
    finHeight: 1.5,
    finChord: 1.3,
    tTail: false
  },
  generic: {
    groundClearance: 3.4,
    length: 36,
    fuselageRadius: 1.9,
    wingSpan: 34,
    wingRootChord: 6.5,
    wingTipChord: 1.6,
    wingSweep: 25,
    wingRootZ: 3,
    wingMount: -0.5,
    wingDihedral: 5,
    wingThickness: 0.55,
    engines: { stations: [5.5], radius: 1, length: 4.2 },
    tailSpan: 12,
    tailChord: 3.5,
    finHeight: 6,
    finChord: 5.2,
    tTail: false
  }
}

const RAD = Math.PI / 180

function fuselage(p: AirframeParams, segments: number): BufferGeometry {
  const r = p.fuselageRadius
  const half = p.length / 2
  const isHeli = p.rotorDiameter != null
  // Profile along Y from tail (−) to nose (+); lathe axis is Y.
  const profile = isHeli
    ? [
        [0.15, -half],
        [0.25, -half * 0.2],
        [r * 0.85, -half * 0.05],
        [r, half * 0.35],
        [r * 0.8, half * 0.6],
        [r * 0.3, half * 0.7],
        [0, half * 0.72]
      ]
    : [
        [r * 0.12, -half],
        [r * 0.55, -half * 0.82],
        [r * 0.95, -half * 0.5],
        [r, -half * 0.35],
        [r, half * 0.62],
        [r * 0.88, half * 0.8],
        [r * 0.55, half * 0.94],
        [0, half]
      ]
  const geometry = new LatheGeometry(
    profile.map(([x, y]) => new Vector2(x, y)),
    segments
  )
  // Y axis → +Z forward.
  geometry.rotateX(Math.PI / 2)
  return geometry
}

/**
 * A tapered, swept panel in the XZ plane, extruded along −Y by `thickness`.
 * `from`/`to` select a chordwise strip (0 = leading edge, 1 = trailing edge).
 */
function panel(
  span: number,
  rootChord: number,
  tipChord: number,
  sweepDeg: number,
  thickness: number,
  from = 0,
  to = 1
): BufferGeometry {
  const sweep = Math.tan(sweepDeg * RAD) * span
  const shape = new Shape()
  // Shape coordinates: x = spanwise, y = forward.
  shape.moveTo(0, -from * rootChord)
  shape.lineTo(span, -sweep - from * tipChord)
  shape.lineTo(span, -sweep - to * tipChord)
  shape.lineTo(0, -to * rootChord)
  shape.closePath()
  const geometry = new ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false
  })
  // Shape y → +Z (forward); extrusion → −Y.
  geometry.rotateX(Math.PI / 2)
  geometry.translate(0, thickness / 2, 0)
  return geometry
}

function mirrored(make: () => BufferGeometry): BufferGeometry[] {
  const left = make()
  const right = make()
  right.scale(-1, 1, 1)
  // Mirroring flips the winding; restore it for correct face culling.
  const index = right.getIndex()
  if (index != null) {
    const array = index.array
    for (let i = 0; i < array.length; i += 3) {
      const t = array[i + 1]!
      array[i + 1] = array[i + 2]!
      array[i + 2] = t
    }
  } else {
    const nonIndexed = right
    const pos = nonIndexed.getAttribute('position')
    for (let i = 0; i < pos.count; i += 3) {
      const x = pos.getX(i + 1)
      const y = pos.getY(i + 1)
      const z = pos.getZ(i + 1)
      pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2))
      pos.setXYZ(i + 2, x, y, z)
    }
  }
  return [left, right]
}

/** Base albedo per part (sRGB hex), multiplied by the instance color. */
const PAINT = {
  fuselage: 0xf1f1ef,
  wing: 0xc3c8ce,
  // Bare-metal leading edge slats and lighter flaps give the wing structure
  // in the window view.
  leadingEdge: 0x8e949c,
  flap: 0xd6d9dd,
  tail: 0xe6e7e8,
  engine: 0xa7abb1,
  propeller: 0x2f3134,
  gear: 0x55585c,
  tire: 0x1e1f21
} as const

type Paint = keyof typeof PAINT

/** Non-indexed copy with only position + a constant linear vertex color. */
function painted(geometry: BufferGeometry, paint: Paint): BufferGeometry {
  const g = geometry.index != null ? geometry.toNonIndexed() : geometry
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name)
  }
  const color = new Color(PAINT[paint])
  const count = g.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; ++i) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return g
}

function merge(parts: Array<[BufferGeometry, Paint]>): BufferGeometry {
  const merged = mergeGeometries(
    parts.map(([geometry, paint]) => painted(geometry, paint)),
    false
  )
  for (const [part] of parts) part.dispose()
  if (merged == null) throw new Error('Failed to merge airframe geometry')
  merged.computeVertexNormals()
  merged.computeBoundingSphere()
  return merged
}

export interface AirframeOptions {
  /** Radial segments of round parts; lower for distant markers. */
  segments?: number
}

/**
 * Builds a low-poly airframe: fuselage, wings, tail, engines (or rotor).
 * Flat-shaded normals; position, normal and per-part vertex colors.
 */
export function buildAirframe(
  p: AirframeParams,
  { segments = 8 }: AirframeOptions = {}
): BufferGeometry {
  const parts: Array<[BufferGeometry, Paint]> = [[fuselage(p, segments), 'fuselage']]
  const add = (paint: Paint, ...geometries: BufferGeometry[]): void => {
    for (const geometry of geometries) parts.push([geometry, paint])
  }
  const r = p.fuselageRadius
  const half = p.length / 2

  if (p.wingSpan > 0) {
    const semiSpan = p.wingSpan / 2 - r * 0.6
    const strips: Array<[Paint, number, number]> = [
      ['leadingEdge', 0, 0.12],
      ['wing', 0.12, 0.78],
      ['flap', 0.78, 1]
    ]
    for (const [paint, from, to] of strips) {
      add(
        paint,
        ...mirrored(() => {
          const wing = panel(
            semiSpan,
            p.wingRootChord,
            p.wingTipChord,
            p.wingSweep,
            p.wingThickness,
            from,
            to
          )
          wing.rotateZ(p.wingDihedral * RAD)
          wing.translate(r * 0.6, p.wingMount * r * 0.85, p.wingRootZ)
          return wing
        })
      )
    }
  }

  // Horizontal tail.
  const tailZ = -half * 0.78
  const tailY = p.tTail ? p.finHeight + r * 0.5 : r * 0.25
  add(
    'wing',
    ...mirrored(() => {
      const tail = panel(
        p.tailSpan / 2,
        p.tailChord,
        p.tailChord * 0.45,
        p.wingSweep * 1.1,
        Math.max(0.12, p.wingThickness * 0.5)
      )
      tail.translate(0, tailY, tailZ + p.tailChord * 0.6)
      return tail
    })
  )

  // Vertical fin: a panel rotated into the YZ plane.
  const fin = panel(
    p.finHeight,
    p.finChord,
    p.finChord * 0.45,
    p.wingSweep * 1.3 + 10,
    Math.max(0.12, p.wingThickness * 0.5)
  )
  fin.rotateZ(Math.PI / 2)
  fin.translate(0, r * 0.6, -half * 0.68 + p.finChord * 0.5)
  add('tail', fin)

  // Engines.
  const e = p.engines
  for (const station of e.stations) {
    const sides = station === 0 ? [0] : [station, -station]
    for (const x of sides) {
      if (e.propeller) {
        if (station !== 0) {
          const nacelle = new CylinderGeometry(e.radius * 0.6, e.radius * 0.5, e.length, segments)
          nacelle.rotateX(Math.PI / 2)
          nacelle.translate(x, p.wingMount * r * 0.85, p.wingRootZ + e.length * 0.3)
          add('engine', nacelle)
        }
        const disc = new CylinderGeometry(e.radius * 3.3, e.radius * 3.3, 0.05, segments * 2)
        disc.rotateX(Math.PI / 2)
        const z = station === 0 ? half + 0.05 : p.wingRootZ + e.length * 0.8
        disc.translate(x, station === 0 ? 0 : p.wingMount * r * 0.85, z)
        add('propeller', disc)
        continue
      }
      const nacelle = new CylinderGeometry(e.radius, e.radius * 0.8, e.length, segments)
      nacelle.rotateX(Math.PI / 2)
      if (e.rearMounted) {
        nacelle.translate(
          Math.sign(x) * (r + e.radius * 0.9),
          r * 0.35,
          -half * 0.45
        )
      } else {
        const sweep = Math.tan(p.wingSweep * RAD) * (Math.abs(x) - r * 0.6)
        nacelle.translate(
          x,
          p.wingMount * r * 0.85 - e.radius * 1.2,
          p.wingRootZ - sweep + e.length * 0.45
        )
      }
      add('engine', nacelle)
    }
  }

  if (p.rotorDiameter != null) {
    const rotor = new CylinderGeometry(p.rotorDiameter / 2, p.rotorDiameter / 2, 0.08, segments * 2)
    rotor.translate(0, r * 1.25, half * 0.2)
    const mast = new CylinderGeometry(0.15, 0.15, r * 0.5, 6)
    mast.translate(0, r * 1.0, half * 0.2)
    add('propeller', rotor)
    add('engine', mast)
  }

  return merge(parts)
}

/**
 * Landing gear (struts and wheels) reaching from the airframe down to
 * `groundClearance` below the fuselage axis; skids for helicopters. A
 * separate geometry so it can be shown only on the ground / on approach.
 */
export function buildGear(p: AirframeParams, { segments = 10 }: AirframeOptions = {}): BufferGeometry {
  const parts: Array<[BufferGeometry, Paint]> = []
  const r = p.fuselageRadius
  const half = p.length / 2
  const bottom = -p.groundClearance
  const wheelRadius = Math.max(0.2, p.groundClearance * 0.16)
  const wheel = (x: number, z: number): void => {
    const tire = new CylinderGeometry(wheelRadius, wheelRadius, wheelRadius * 0.7, segments)
    tire.rotateZ(Math.PI / 2)
    tire.translate(x, bottom + wheelRadius, z)
    parts.push([tire, 'tire'])
  }
  const strut = (x: number, z: number, top: number): void => {
    const height = top - (bottom + wheelRadius)
    const leg = new CylinderGeometry(wheelRadius * 0.22, wheelRadius * 0.22, height, 6)
    leg.translate(x, bottom + wheelRadius + height / 2, z)
    parts.push([leg, 'gear'])
  }

  if (p.rotorDiameter != null) {
    for (const x of [r * 0.8, -r * 0.8]) {
      const skid = new CylinderGeometry(0.06, 0.06, p.length * 0.35, 6)
      skid.rotateX(Math.PI / 2)
      skid.translate(x, bottom + 0.06, half * 0.2)
      parts.push([skid, 'gear'])
      strut(x * 0.8, half * 0.3, -r * 0.6)
      strut(x * 0.8, half * 0.05, -r * 0.6)
    }
    return merge(parts)
  }

  const noseZ = half * 0.78
  strut(0, noseZ, -r * 0.7)
  wheel(wheelRadius * 0.4, noseZ)
  wheel(-wheelRadius * 0.4, noseZ)
  // Mains just behind the wing root (high-wing aircraft: from the fuselage).
  const mainZ = p.wingRootZ - p.wingRootChord * 0.7
  const mainX = p.wingMount > 0.5 ? r * 1.1 : r * 0.9
  const mainTop = p.wingMount > 0.5 ? -r * 0.6 : p.wingMount * r * 0.85
  for (const x of [mainX, -mainX]) {
    strut(x, mainZ, mainTop)
    wheel(x + Math.sign(x) * wheelRadius * 0.45, mainZ)
    wheel(x - Math.sign(x) * wheelRadius * 0.45, mainZ)
  }
  return merge(parts)
}
