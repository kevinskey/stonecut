import pc from 'polygon-clipping'
import type { Pt } from './model'
import { fromMulti, toMulti } from './boolean'

// Inkscape-style path offset (Ctrl+( / Ctrl+)) on flattened polyline shapes.
// Grow = union of the shape with a band swept along its boundary (per-edge
// rectangles + a disc at every vertex — a Minkowski sum with a radius-d
// disc). Shrink = the same band subtracted instead. polygon-clipping does
// the self-intersection cleanup, and toMulti/fromMulti keep letter holes
// behaving as holes (a grown O keeps its counter, a shrunk one widens it).

type Ring = [number, number][]
type Poly = Ring[]
type Multi = Poly[]

const DISC_SEGS = 16

// The disc is drawn a hair OVER radius and its sampling is rotated by an
// arbitrary phase: at exactly r with phase 0, disc vertices land exactly on
// the edge rectangles' corners and polygon-clipping's sweep line dies on the
// degenerate tangency ("Unable to find segment in SweepLine tree").
function discRing(c: Pt, r: number): Ring {
  const out: Ring = []
  const rr = r * 1.003
  for (let i = 0; i < DISC_SEGS; i++) {
    const a = 0.3781 + (i / DISC_SEGS) * Math.PI * 2
    out.push([c.x + rr * Math.cos(a), c.y + rr * Math.sin(a)])
  }
  return out
}

// One polygon per edge/vertex of every ring in the shape, all radius d.
function boundaryBand(m: Multi, d: number): Multi {
  const band: Multi = []
  for (const poly of m) {
    for (const ring of poly) {
      const n = ring.length
      for (let i = 0; i < n; i++) {
        const [ax, ay] = ring[i]
        const [bx, by] = ring[(i + 1) % n]
        band.push([discRing({ x: ax, y: ay }, d)])
        const dx = bx - ax, dy = by - ay
        const len = Math.hypot(dx, dy)
        if (len < 1e-6) continue
        const nx = (-dy / len) * d, ny = (dx / len) * d
        band.push([[
          [ax + nx, ay + ny],
          [bx + nx, by + ny],
          [bx - nx, by - ny],
          [ax - nx, ay - ny],
        ]])
      }
    }
  }
  return band
}

// Offset a closed shape outward (delta > 0) or inward (delta < 0) by |delta|
// mm. Returns the new boundary as closed polylines; [] when an inset
// swallows the whole shape.
export function offsetPaths(paths: Pt[][], delta: number): Pt[][] {
  const m = toMulti(paths)
  if (!m.length || !delta) return paths
  const band = boundaryBand(m, Math.abs(delta))
  const out =
    delta > 0
      ? pc.union(m, ...band)
      : pc.difference(m, ...band)
  return fromMulti(out as Multi)
}
