import type { Pt } from './model'

// Geometric primitives as flattened contours, in the same Pt[][] form
// textToContours produces — so shapes feed the identical outline/fill
// pipeline that text and images already use. Origin is (0,0) top-left.
export type ShapeKind =
  | 'circle' | 'ellipse' | 'square' | 'rect' | 'triangle'
  | 'diamond' | 'star5' | 'heart' | 'hexagon' | 'octagon'

export const SHAPE_NAMES: { kind: ShapeKind; label: string }[] = [
  { kind: 'circle', label: 'Circle' },
  { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'square', label: 'Square' },
  { kind: 'rect', label: 'Rectangle' },
  { kind: 'triangle', label: 'Triangle' },
  { kind: 'diamond', label: 'Diamond' },
  { kind: 'star5', label: 'Star (5)' },
  { kind: 'heart', label: 'Heart' },
  { kind: 'hexagon', label: 'Hexagon' },
  { kind: 'octagon', label: 'Octagon' },
]

// Enough segments that the outline tracer sees a smooth curve rather than a
// polygon; the tracer resamples anyway, so this only has to beat its pitch.
const CURVE_STEPS = 160

const polygon = (n: number, w: number, h: number, rot = -Math.PI / 2): Pt[] => {
  const cx = w / 2, cy = h / 2
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2
    return { x: cx + cx * Math.cos(a), y: cy + cy * Math.sin(a) }
  })
}

const ellipse = (w: number, h: number): Pt[] =>
  Array.from({ length: CURVE_STEPS }, (_, i) => {
    const a = (i / CURVE_STEPS) * Math.PI * 2
    return { x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) }
  })

const star = (points: number, w: number, h: number, innerRatio = 0.4): Pt[] => {
  const cx = w / 2, cy = h / 2
  const out: Pt[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2
    const k = i % 2 === 0 ? 1 : innerRatio
    out.push({ x: cx + cx * k * Math.cos(a), y: cy + cy * k * Math.sin(a) })
  }
  return out
}

// Classic parametric heart. Left unnormalised — fit() sizes it like the rest.
const heart = (): Pt[] =>
  Array.from({ length: CURVE_STEPS }, (_, i) => {
    const t = (i / CURVE_STEPS) * Math.PI * 2
    return {
      x: 16 * Math.sin(t) ** 3,
      y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    }
  })

// Translate + scale a polygon so it exactly fills the requested box. Without
// this an inscribed polygon (triangle, square-on-point) only touches the box
// at its vertices, so a 50x30 triangle came out 43x22 and the size fields lied.
const fit = (poly: Pt[], w: number, h: number): Pt[] => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const sx = maxX > minX ? w / (maxX - minX) : 1
  const sy = maxY > minY ? h / (maxY - minY) : 1
  return poly.map((p) => ({ x: (p.x - minX) * sx, y: (p.y - minY) * sy }))
}

export function shapeToContours(
  kind: ShapeKind,
  widthMm: number,
  heightMm: number,
): { contours: Pt[][]; widthMm: number; heightMm: number } {
  const w = Math.max(1, widthMm)
  const h = Math.max(1, heightMm)
  // circle and square stay square: they are defined by the shorter side
  const sq = Math.min(w, h)
  let poly: Pt[]
  switch (kind) {
    case 'circle': poly = fit(ellipse(sq, sq), sq, sq); break
    case 'ellipse': poly = fit(ellipse(w, h), w, h); break
    case 'square': poly = [{ x: 0, y: 0 }, { x: sq, y: 0 }, { x: sq, y: sq }, { x: 0, y: sq }]; break
    case 'rect': poly = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]; break
    case 'triangle': poly = fit(polygon(3, w, h), w, h); break
    case 'diamond': poly = fit(polygon(4, w, h), w, h); break
    case 'star5': poly = fit(star(5, w, h), w, h); break
    case 'heart': poly = fit(heart(), w, h); break
    case 'hexagon': poly = fit(polygon(6, w, h), w, h); break
    case 'octagon': poly = fit(polygon(8, w, h), w, h); break
  }
  // close the ring — the tracer expects the first point repeated at the end
  const closed = [...poly, poly[0]]
  let maxX = 0, maxY = 0
  for (const p of closed) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  return { contours: [closed], widthMm: maxX, heightMm: maxY }
}
