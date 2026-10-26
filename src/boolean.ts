import pc from 'polygon-clipping'
import type { Pt } from './model'

// Pathfinder-style boolean operations on cut-line sets. polygon-clipping
// wants polygons as [outerRing, ...holeRings]; our cut lines are plain
// rings, so holes are recovered by containment depth: a ring sitting inside
// an odd number of other rings is a hole of the smallest ring around it.
type Ring = [number, number][]
type Poly = Ring[]
type Multi = Poly[]

const ringArea = (r: Ring) => {
  let a = 0
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i]
    const [x2, y2] = r[(i + 1) % r.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

function pointInRing(p: [number, number], r: Ring): boolean {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function toMulti(paths: Pt[][]): Multi {
  const rings: Ring[] = paths
    .map((p) => {
      const r = p.map((q) => [q.x, q.y] as [number, number])
      if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop()
      return r
    })
    .filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-6)
  const areas = rings.map((r) => Math.abs(ringArea(r)))
  const depth = rings.map((r, i) =>
    rings.reduce((d, o, j) => (j !== i && areas[j] > areas[i] && pointInRing(r[0], o) ? d + 1 : d), 0),
  )
  const polys: Multi = []
  const outer: number[] = []
  rings.forEach((r, i) => { if (depth[i] % 2 === 0) { polys.push([r]); outer.push(i) } })
  rings.forEach((r, i) => {
    if (depth[i] % 2 !== 1) return
    let best = -1, bestA = Infinity
    outer.forEach((oi, k) => { if (areas[oi] < bestA && pointInRing(r[0], rings[oi])) { bestA = areas[oi]; best = k } })
    if (best >= 0) polys[best].push(r)
  })
  return polys
}

// polygon-clipping can emit zero-width SPURS where operands share a
// collinear edge — unite a rectangle flush against a letter stem and the
// buried seam survives as a dangling edge. A spur tip is a vertex whose two
// edges double straight back (reversed direction, no area); removing it
// exposes the next spur vertex, so peel until the ring is clean.
function despur(ring: Ring): Ring {
  const out = [...ring]
  let changed = true
  while (changed && out.length > 3) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length]
      const b = out[i]
      const c = out[(i + 1) % out.length]
      const abx = b[0] - a[0], aby = b[1] - a[1]
      const bcx = c[0] - b[0], bcy = c[1] - b[1]
      const lab = Math.hypot(abx, aby)
      const lbc = Math.hypot(bcx, bcy)
      const cross = abx * bcy - aby * bcx
      const dot = abx * bcx + aby * bcy
      if (lab < 1e-9 || lbc < 1e-9 || (Math.abs(cross) <= 1e-6 * Math.max(1, lab * lbc) && dot < 0)) {
        out.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return out
}

export function fromMulti(m: Multi): Pt[][] {
  return m.flatMap((poly) =>
    poly
      .map(despur)
      .filter((ring) => ring.length >= 3 && Math.abs(ringArea(ring)) > 1e-6)
      .map((ring) => {
        const pts = ring.map(([x, y]) => ({ x, y }))
        const a = pts[0], b = pts[pts.length - 1]
        if (pts.length && (a.x !== b.x || a.y !== b.y)) pts.push({ x: a.x, y: a.y })
        return pts
      }),
  )
}

export type BoolOp = 'union' | 'difference' | 'intersection' | 'xor'

// operands[0] is the back object; difference subtracts every later operand
// from it (Illustrator's Minus Front with the back object as the keeper).
export function booleanPaths(op: BoolOp, operands: Pt[][][]): Pt[][] {
  const geoms = operands.map(toMulti).filter((m) => m.length)
  if (!geoms.length) return []
  const [first, ...rest] = geoms
  const out =
    op === 'union' ? pc.union(first, ...rest)
    : op === 'difference' ? pc.difference(first, ...rest)
    : op === 'intersection' ? pc.intersection(first, ...rest)
    : pc.xor(first, ...rest)
  return fromMulti(out as Multi)
}
