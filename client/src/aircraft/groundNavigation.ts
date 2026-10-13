import { DEG } from '@windowseat/shared'
import { metersPerRadian, type KinematicState, type MotionSample } from './motion'

export interface GroundPath { kind: 'runway' | 'taxiway'; points: [lon: number, lat: number][] }
interface Node { lon: number; lat: number; edges: Edge[] }
interface Edge { a: Node; b: Node; length: number; kind: GroundPath['kind'] }
interface Step { from: Node; to: Node; length: number }
interface Route { steps: Step[]; offset: number; speed: number }

/** Bounded by the streamed tile window, not the number of aircraft ever seen. */
export class GroundNavigation {
  private tiles = new Map<string, GroundPath[]>()
  private edges: Edge[] = []
  private dirty = false
  private routes = new WeakMap<MotionSample, Route | null>()

  setTile(key: string, paths: GroundPath[]): void {
    this.tiles.set(key, paths)
    this.invalidate()
  }
  removeTile(key: string): void {
    if (this.tiles.delete(key)) this.invalidate()
  }
  clear(): void { this.tiles.clear(); this.invalidate() }
  private invalidate(): void {
    this.dirty = true
    this.routes = new WeakMap()
  }

  private rebuild(): void {
    if (!this.dirty) return
    this.dirty = false
    this.edges = []
    const nodes = new Map<string, Node>()
    const node = ([lon, lat]: [number, number]): Node => {
      const key = `${Math.round(lon * 1e5)},${Math.round(lat * 1e5)}`
      let n = nodes.get(key)
      if (!n) { n = { lon, lat, edges: [] }; nodes.set(key, n) }
      return n
    }
    const seen = new Set<string>()
    for (const paths of this.tiles.values()) for (const path of paths) {
      for (let i = 1; i < path.points.length; ++i) {
        const a = node(path.points[i - 1]!), b = node(path.points[i]!)
        const keys = [ `${a.lon},${a.lat}`, `${b.lon},${b.lat}` ].sort()
        const key = keys.join('/')
        const length = distance(a, b)
        if (length < 1 || seen.has(key)) continue
        seen.add(key)
        const edge = { a, b, length, kind: path.kind }
        this.edges.push(edge); a.edges.push(edge); b.edges.push(edge)
      }
    }
  }

  private match(sample: MotionSample): Route | null {
    const speed = Math.hypot(sample.vn, sample.ve)
    if (speed < 2.5) return null // don't route parked or very slow apron traffic
    const m = metersPerRadian(sample.lat)
    let best = Infinity
    let selected: Step | null = null
    let offset = 0
    for (const edge of this.edges) {
      const ax = (edge.a.lon - sample.lon) * DEG * m.east
      const ay = (edge.a.lat - sample.lat) * DEG * m.north
      const dx = (edge.b.lon - edge.a.lon) * DEG * m.east
      const dy = (edge.b.lat - edge.a.lat) * DEG * m.north
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
      const lateral = Math.hypot(ax + t * dx, ay + t * dy)
      const alignment = (dx * sample.ve + dy * sample.vn) / (edge.length * speed)
      if (lateral > (edge.kind === 'runway' ? 30 : 18) || Math.abs(alignment) < 0.8) continue
      const score = lateral + (1 - Math.abs(alignment)) * 30
      if (score >= best) continue
      best = score
      selected = alignment > 0 ? { from: edge.a, to: edge.b, length: edge.length } :
        { from: edge.b, to: edge.a, length: edge.length }
      offset = (alignment > 0 ? t : 1 - t) * edge.length
    }
    if (!selected) return null
    const steps = [selected]
    const visited = new Set<Node>([selected.from])
    let total = selected.length - offset
    // A short conservative horizon. Unknown branches stop prediction even
    // when one branch is straighter: ADS-B doesn't tell us the cleared route.
    while (total < 2000 && steps.length < 128) {
      const previous = steps[steps.length - 1]!
      const at = previous.to
      visited.add(at)
      const choices = at.edges.filter(e => (e.a === at ? e.b : e.a) !== previous.from)
      if (choices.length !== 1) break
      const e = choices[0]!, to = e.a === at ? e.b : e.a
      if (visited.has(to)) break
      const m = metersPerRadian(at.lat)
      const ix = (at.lon - previous.from.lon) * m.east, iy = (at.lat - previous.from.lat) * m.north
      const ox = (to.lon - at.lon) * m.east, oy = (to.lat - at.lat) * m.north
      const alignment = (ix * ox + iy * oy) / Math.hypot(ix, iy) / Math.hypot(ox, oy)
      if (alignment < (speed > 35 ? 0.98 : 0.34)) break
      steps.push({ from: at, to, length: e.length }); total += e.length
    }
    return { steps, offset, speed }
  }

  /** Only modifies extrapolation; live samples/interpolation stay authoritative. */
  constrain(sample: MotionSample, out: KinematicState): boolean {
    if (!sample.onGround || !out.onGround || out.extrapolation <= 0) return false
    this.rebuild()
    let route = this.routes.get(sample)
    if (route === undefined) { route = this.match(sample); this.routes.set(sample, route) }
    if (!route) return false
    // Slow taxi traffic may follow bends; high-speed runway rolls do not
    // invent an exit during a feed gap. Both stop after eight seconds.
    let travel = route.offset + route.speed * Math.min(8, out.extrapolation)
    let step = route.steps[0]!
    for (let i = 0; i < route.steps.length; ++i) {
      step = route.steps[i]!
      if (travel <= step.length || i === route.steps.length - 1) break
      travel -= step.length
    }
    const terminal = step === route.steps[route.steps.length - 1]
    const stop = Math.max(0, step.length - (terminal ? 3 : 0))
    const held = travel >= stop || out.extrapolation >= 8
    const t = Math.min(stop, travel) / step.length
    // Ease lateral correction over two seconds instead of teleporting onto
    // the centerline as soon as the newest timestamp has passed.
    const weight = Math.min(1, out.extrapolation / 2)
    const m = metersPerRadian(sample.lat)
    const first = route.steps[0]!
    const initialT = route.offset / first.length
    const errorLat = sample.lat - (first.from.lat + (first.to.lat - first.from.lat) * initialT)
    const errorLon = sample.lon - (first.from.lon + (first.to.lon - first.from.lon) * initialT)
    out.lat = step.from.lat + (step.to.lat - step.from.lat) * t + errorLat * (1 - weight)
    out.lon = step.from.lon + (step.to.lon - step.from.lon) * t + errorLon * (1 - weight)
    out.vn = held ? 0 : (step.to.lat - step.from.lat) * DEG * m.north / step.length * route.speed
    out.ve = held ? 0 : (step.to.lon - step.from.lon) * DEG * m.east / step.length * route.speed
    return true
  }
}

function distance(a: Node, b: Node): number {
  const m = metersPerRadian(a.lat)
  return Math.hypot((b.lat - a.lat) * DEG * m.north, (b.lon - a.lon) * DEG * m.east)
}
