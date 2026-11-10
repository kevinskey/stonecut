import type { Pt } from './model'

// CUBIC BÉZIER PATHS. A cut-line object's `base` stays the flattened polyline
// everything downstream cuts, beads and booleans; `bez` is the editable
// curve it came from — anchors with an in-handle and an out-handle, in the
// same base coordinates. Whenever bez exists, base === bezToBase(bez).
// Handles sitting on their anchor mean a straight corner, so a plain
// polyline is a BezPath too (polylineToBez), and the node tool edits
// every object the same way.
export interface BezAnchor { x: number; y: number; hi: Pt; ho: Pt; smooth: boolean }
export interface BezPath { a: BezAnchor[]; closed: boolean }

const HANDLE_EPS = 1e-4
export const anchorAt = (p: Pt): BezAnchor => ({ x: p.x, y: p.y, hi: { x: p.x, y: p.y }, ho: { x: p.x, y: p.y }, smooth: false })
export const hasHandle = (a: Pt, h: Pt): boolean => Math.hypot(h.x - a.x, h.y - a.y) > HANDLE_EPS
export const segCount = (p: BezPath): number => (p.closed ? p.a.length : Math.max(0, p.a.length - 1))
export const segEnds = (p: BezPath, i: number): [BezAnchor, BezAnchor] => [p.a[i], p.a[(i + 1) % p.a.length]]

export function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

// Flatten one segment, appending every point after `a` (b included).
// Step length 0.3 mm on curves: a 3 mm radius drawn that way sits 0.004 mm
// off the true arc, well under the cutter's 0.1 mm step.
function flattenSeg(a: BezAnchor, b: BezAnchor, out: Pt[]): void {
  if (!hasHandle(a, a.ho) && !hasHandle(b, b.hi)) { out.push({ x: b.x, y: b.y }); return }
  const ctrl = Math.hypot(a.ho.x - a.x, a.ho.y - a.y) + Math.hypot(b.hi.x - a.ho.x, b.hi.y - a.ho.y) + Math.hypot(b.x - b.hi.x, b.y - b.hi.y)
  const n = Math.max(4, Math.min(200, Math.round(ctrl / 0.3)))
  for (let k = 1; k <= n; k++) out.push(cubicAt(a, a.ho, b.hi, b, k / n))
}

// Polyline of a path; a closed path ends on a copy of its first point, the
// convention the rest of the app uses for rings.
export function flattenPath(p: BezPath): Pt[] {
  if (!p.a.length) return []
  const out: Pt[] = [{ x: p.a[0].x, y: p.a[0].y }]
  for (let i = 0; i < segCount(p); i++) { const [a, b] = segEnds(p, i); flattenSeg(a, b, out) }
  return out
}
export const bezToBase = (paths: BezPath[]): Pt[][] => paths.map(flattenPath)

// A polyline as corner anchors — exact, so node-editing an object that never
// had curves changes nothing until a handle is pulled.
export function polylineToBez(pl: Pt[]): BezPath {
  const n = pl.length
  const closed = n > 2 && Math.hypot(pl[0].x - pl[n - 1].x, pl[0].y - pl[n - 1].y) < 1e-6
  const pts = closed ? pl.slice(0, -1) : pl
  return { a: pts.map(anchorAt), closed }
}

export function transformBez(paths: BezPath[], fn: (p: Pt) => Pt): BezPath[] {
  return paths.map((p) => ({
    closed: p.closed,
    a: p.a.map((an) => { const q = fn(an); return { ...q, hi: fn(an.hi), ho: fn(an.ho), smooth: an.smooth } }),
  }))
}

// Smooth handles for anchor i from its neighbours (Catmull-Rom tangent, the
// curve the pen's "smooth" mode draws through every click).
export function autoSmooth(p: BezPath, i: number): BezAnchor {
  const n = p.a.length
  const cur = p.a[i]
  const prev = p.closed ? p.a[(i - 1 + n) % n] : p.a[Math.max(0, i - 1)]
  const next = p.closed ? p.a[(i + 1) % n] : p.a[Math.min(n - 1, i + 1)]
  let tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6
  // open ends: lean toward the one neighbour
  if (!p.closed && (i === 0 || i === n - 1)) { tx = (next.x - prev.x) / 3; ty = (next.y - prev.y) / 3 }
  return { x: cur.x, y: cur.y, hi: { x: cur.x - tx, y: cur.y - ty }, ho: { x: cur.x + tx, y: cur.y + ty }, smooth: true }
}
export function smoothThroughPts(pts: Pt[], closed: boolean): BezPath {
  const p: BezPath = { a: pts.map(anchorAt), closed }
  if (p.a.length < 3) return p
  p.a = p.a.map((_, i) => autoSmooth(p, i))
  return p
}

// Insert an anchor on segment `seg` at parameter t (de Casteljau), keeping
// the curve's shape exactly.
export function splitAt(p: BezPath, seg: number, t: number): BezPath {
  const [a, b] = segEnds(p, seg)
  const straight = !hasHandle(a, a.ho) && !hasHandle(b, b.hi)
  const lerp = (u: Pt, v: Pt): Pt => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t })
  const p01 = lerp(a, a.ho), p12 = lerp(a.ho, b.hi), p23 = lerp(b.hi, b)
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23)
  const m = lerp(p012, p123)
  const na: BezAnchor = { ...a, ho: straight ? { x: a.x, y: a.y } : p01 }
  const mid: BezAnchor = straight ? anchorAt(m) : { x: m.x, y: m.y, hi: p012, ho: p123, smooth: true }
  const nb: BezAnchor = { ...b, hi: straight ? { x: b.x, y: b.y } : p23 }
  const out = p.a.slice()
  out[seg] = na
  out[(seg + 1) % p.a.length] = nb
  out.splice(seg + 1, 0, mid)
  return { a: out, closed: p.closed }
}

// Closest point on the path to q (same coordinate space). Sampled, then
// refined by bisection around the best sample.
export function nearestOnPath(p: BezPath, q: Pt, maxD: number): { seg: number; t: number; d: number; q: Pt } | null {
  let best: { seg: number; t: number; d: number; q: Pt } | null = null
  for (let s = 0; s < segCount(p); s++) {
    const [a, b] = segEnds(p, s)
    const at = (t: number) => cubicAt(a, a.ho, b.hi, b, t)
    let bt = 0, bd = Infinity
    const N = 24
    for (let k = 0; k <= N; k++) { const r = at(k / N); const d = Math.hypot(r.x - q.x, r.y - q.y); if (d < bd) { bd = d; bt = k / N } }
    let lo = Math.max(0, bt - 1 / N), hi = Math.min(1, bt + 1 / N)
    for (let it = 0; it < 20; it++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3
      const r1 = at(m1), r2 = at(m2)
      if (Math.hypot(r1.x - q.x, r1.y - q.y) < Math.hypot(r2.x - q.x, r2.y - q.y)) hi = m2; else lo = m1
    }
    const t = (lo + hi) / 2
    const r = at(t)
    const d = Math.hypot(r.x - q.x, r.y - q.y)
    if (d < maxD && (!best || d < best.d)) best = { seg: s, t, d, q: r }
  }
  return best
}

// Shape check for a saved project (untrusted input).
export function validBez(x: unknown): x is BezPath[] {
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e7
  const pt = (v: unknown) => !!v && typeof v === 'object' && fin((v as Pt).x) && fin((v as Pt).y)
  if (!Array.isArray(x) || x.length > 10000) return false
  for (const p of x) {
    if (!p || typeof p !== 'object' || typeof (p as BezPath).closed !== 'boolean' || !Array.isArray((p as BezPath).a)) return false
    if ((p as BezPath).a.length > 200000) return false
    for (const a of (p as BezPath).a) if (!pt(a) || !pt((a as BezAnchor).hi) || !pt((a as BezAnchor).ho) || typeof (a as BezAnchor).smooth !== 'boolean') return false
  }
  return true
}

// SVG path data -> Bézier paths, so an Illustrator or Inkscape curve keeps
// its handles after import. Returns null when the data uses something this
// parser does not model (elliptical arcs), and the caller samples instead.
export function svgPathToBez(d: string): BezPath[] | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null
  const out: BezPath[] = []
  let cur: BezPath | null = null
  let x = 0, y = 0, sx = 0, sy = 0
  // declared via assertion, not annotation: TS would otherwise narrow the
  // initial null and never see the assignments the closures below make
  let lastC = null as Pt | null
  let lastQ = null as Pt | null
  let i = 0
  let cmd = ''
  const num = (): number => { const v = parseFloat(tokens[i++]); if (!Number.isFinite(v)) throw new Error('bad number'); return v }
  const isNum = () => i < tokens.length && /^[-+.\d]/.test(tokens[i])
  const begin = (px: number, py: number) => { cur = { a: [anchorAt({ x: px, y: py })], closed: false }; out.push(cur); sx = px; sy = py }
  const ensure = () => { if (!cur) begin(x, y) }
  const lineTo = (px: number, py: number) => { ensure(); cur!.a.push(anchorAt({ x: px, y: py })); x = px; y = py; lastC = lastQ = null }
  const curveTo = (c1: Pt, c2: Pt, px: number, py: number) => {
    ensure()
    const last = cur!.a[cur!.a.length - 1]
    last.ho = { ...c1 }
    cur!.a.push({ x: px, y: py, hi: { ...c2 }, ho: { x: px, y: py }, smooth: false })
    x = px; y = py; lastC = c2; lastQ = null
  }
  const quadTo = (q: Pt, px: number, py: number) => {
    const c1 = { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) }
    const c2 = { x: px + (2 / 3) * (q.x - px), y: py + (2 / 3) * (q.y - py) }
    curveTo(c1, c2, px, py)
    lastQ = q; lastC = null
  }
  const close = () => {
    if (!cur) return
    const a = cur.a
    if (a.length > 1 && Math.hypot(a[0].x - a[a.length - 1].x, a[0].y - a[a.length - 1].y) < 1e-6) {
      a[0].hi = a[a.length - 1].hi
      a.pop()
    }
    cur.closed = true
    cur = null
    x = sx; y = sy; lastC = lastQ = null
  }
  try {
    while (i < tokens.length) {
      const tk = tokens[i]
      if (/^[A-Za-z]$/.test(tk)) { cmd = tk; i++ } else if (!cmd) return null
      const rel = cmd === cmd.toLowerCase()
      const C = cmd.toUpperCase()
      if (C === 'A') return null
      if (C === 'Z') { close(); continue }
      // a command letter followed by nothing is a no-op; repeated coordinate
      // groups repeat the command (M repeats as L)
      do {
        if (C === 'M') {
          const px = num(), py = num()
          x = rel ? x + px : px; y = rel ? y + py : py
          begin(x, y); lastC = lastQ = null
          cmd = rel ? 'l' : 'L'
        } else if (C === 'L') {
          const px = num(), py = num()
          lineTo(rel ? x + px : px, rel ? y + py : py)
        } else if (C === 'H') { const px = num(); lineTo(rel ? x + px : px, y) }
        else if (C === 'V') { const py = num(); lineTo(x, rel ? y + py : py) }
        else if (C === 'C') {
          const ox = x, oy = y
          const c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() }, px = num(), py = num()
          if (rel) { c1.x += ox; c1.y += oy; c2.x += ox; c2.y += oy }
          curveTo(c1, c2, rel ? ox + px : px, rel ? oy + py : py)
        } else if (C === 'S') {
          const ox = x, oy = y
          const c1 = lastC ? { x: 2 * ox - lastC.x, y: 2 * oy - lastC.y } : { x: ox, y: oy }
          const c2 = { x: num(), y: num() }, px = num(), py = num()
          if (rel) { c2.x += ox; c2.y += oy }
          curveTo(c1, c2, rel ? ox + px : px, rel ? oy + py : py)
        } else if (C === 'Q') {
          const ox = x, oy = y
          const q = { x: num(), y: num() }, px = num(), py = num()
          if (rel) { q.x += ox; q.y += oy }
          quadTo(q, rel ? ox + px : px, rel ? oy + py : py)
        } else if (C === 'T') {
          const ox = x, oy = y
          const q = lastQ ? { x: 2 * ox - lastQ.x, y: 2 * oy - lastQ.y } : { x: ox, y: oy }
          const px = num(), py = num()
          quadTo(q, rel ? ox + px : px, rel ? oy + py : py)
        } else return null
      } while (isNum())
    }
  } catch { return null }
  // drop degenerate subpaths and mark anchors whose handles are collinear
  // and opposite as smooth, so dragging one handle keeps the other in line
  const paths = out.filter((p) => p.a.length >= (p.closed ? 2 : 2))
  for (const p of paths) {
    for (const a of p.a) {
      if (!hasHandle(a, a.hi) || !hasHandle(a, a.ho)) continue
      const ux = a.hi.x - a.x, uy = a.hi.y - a.y, vx = a.ho.x - a.x, vy = a.ho.y - a.y
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
      const cos = (ux * vx + uy * vy) / (lu * lv)
      a.smooth = cos < -0.995
    }
  }
  return paths.length ? paths : null
}
