import type { Pt } from './model'

// ---------------------------------------------------------------------------
// Centered variable-grid stone fill.
//
// The shape is rasterized, an exact Euclidean distance transform is computed,
// and each connected pocket of interior space is measured and filled on its
// own terms:
//   - narrow pockets (room for one row) get a single centerline row placed on
//     the pocket's skeleton — a true spine, never a zigzag iso-loop
//   - wider pockets get concentric rows whose spacing is stretched-to-fit so
//     the row block exactly spans the available depth band (capped at 1.35×
//     ideal pitch, falling back to a centered block) — centered padding AND
//     maximum density
//   - after all rows, unfilled local maxima of the distance field get a seed
//     stone (i-dots, star tips, letter terminals)
// A global spatial index enforces the minimum center-to-center distance
// everywhere; blocked stones slide forward along their row until they fit.
// ---------------------------------------------------------------------------

// diagnostic registry: every stone tagged by the subsystem that placed it
export const debugStones: { cat: string; x: number; y: number }[] = []
export const debugSpans: { at: string; chords: number[]; r?: number; m0?: number; mFinal?: number; Lc?: number; E?: number; need?: number; att?: string }[] = []
function dbg(cat: string, pts: Pt[]) {
  for (const p of pts) debugStones.push({ cat, x: p.x, y: p.y })
}

export interface Grid {
  bin: Uint8Array
  w: number
  h: number
  pxPerMm: number
  padPx: number // grid pixels of padding before mm-origin
}

// Spatial index enforcing a minimum center-to-center distance.
export class SpacingIndex {
  private cell: number
  private map = new Map<string, { x: number; y: number; r: number }[]>()
  minDist: number
  gap: number
  defaultR: number
  private useRadii: boolean
  /**
   * Legacy mode — new SpacingIndex(minDist) — enforces one uniform minimum.
   * Radius mode — new SpacingIndex(minDist, gap, defaultRadius) — enforces
   * radiusA + radiusB + gap per pair, so mixed stone sizes get the right
   * clearance: two small fill stones may sit closer than a fill stone may
   * sit to a big outline stone.
   */
  constructor(minDist: number, gap?: number, defaultRadius?: number) {
    this.minDist = minDist
    this.gap = gap ?? 0
    this.defaultR = defaultRadius ?? minDist / 2
    this.useRadii = gap !== undefined && defaultRadius !== undefined
    this.cell = Math.max(minDist * 1.5, 1)
  }
  private key(cx: number, cy: number) {
    return `${cx},${cy}`
  }
  canPlace(p: Pt, r: number = this.defaultR): boolean {
    const cx = Math.floor(p.x / this.cell)
    const cy = Math.floor(p.y / this.cell)
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const b = this.map.get(this.key(gx, gy))
        if (!b) continue
        for (const o of b) {
          const need = this.useRadii ? r + o.r + this.gap : this.minDist
          // epsilon: a hex lattice places every neighbour at EXACTLY the
          // minimum, so an exact comparison rejects ~half of them to
          // floating-point noise and shreds the pattern
          if (Math.hypot(p.x - o.x, p.y - o.y) < need - 1e-6) return false
        }
      }
    return true
  }
  /** Everything already placed within `r` of p. Lets a caller ask for more
   *  clearance than the physical floor without being bound by it. */
  within(p: Pt, r: number): { x: number; y: number }[] {
    const cx = Math.floor(p.x / this.cell)
    const cy = Math.floor(p.y / this.cell)
    const span = Math.ceil(r / this.cell)
    const hit: { x: number; y: number }[] = []
    for (let gx = cx - span; gx <= cx + span; gx++)
      for (let gy = cy - span; gy <= cy + span; gy++) {
        const b = this.map.get(this.key(gx, gy))
        if (!b) continue
        for (const o of b) if (Math.hypot(p.x - o.x, p.y - o.y) < r - 1e-6) hit.push(o)
      }
    return hit
  }
  /** Take a stone back out — used when a pass places one and then finds it
   *  illegal, so the space is not left reserved. */
  remove(p: Pt) {
    const b = this.map.get(this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)))
    if (!b) return
    const i = b.findIndex((o) => Math.abs(o.x - p.x) < 1e-9 && Math.abs(o.y - p.y) < 1e-9)
    if (i >= 0) b.splice(i, 1)
  }
  add(p: Pt, r: number = this.defaultR) {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell))
    const e = { x: p.x, y: p.y, r }
    const b = this.map.get(k)
    if (b) b.push(e)
    else this.map.set(k, [e])
  }
}

// Rasterize closed contours (mm) into a binary grid using canvas even-odd fill.
export function rasterizeContours(contours: Pt[][], pxPerMm = 6, padMm = 0): Grid {
  let maxX = 0
  let maxY = 0
  for (const c of contours)
    for (const p of c) {
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  const pad = 2 + Math.ceil(padMm * pxPerMm)
  const w = Math.ceil(maxX * pxPerMm) + pad * 2
  const h = Math.ceil(maxY * pxPerMm) + pad * 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  // A counter is a contour that sits INSIDE another one; overlapping shapes do
  // not. That distinction is what the fill rule cannot express on its own.
  //
  // Even-odd alone punches a phantom hole wherever two same-winding contours
  // overlap — an E drawn as a C-shape plus a separate middle-arm bar lost 78mm^2
  // out of its middle, and the outline traced the hole. Nonzero alone fills a
  // real counter whenever its loop happens to be wound the same way as its
  // outer, which is how Google Sans draws a lowercase e: one self-intersecting
  // contour, 41 grid points that nonzero calls solid and even-odd calls a hole.
  // Stones then landed inside the counter.
  //
  // So: union everything that is not contained, then subtract the contained
  // ones. Overlaps merge, counters stay holes, whichever way they are wound.
  const polys = contours.filter((c) => c.length >= 3)
  const pathOf = (c: Pt[]) => {
    const p = new Path2D()
    p.moveTo(c[0].x * pxPerMm + pad, c[0].y * pxPerMm + pad)
    for (let i = 1; i < c.length; i++) p.lineTo(c[i].x * pxPerMm + pad, c[i].y * pxPerMm + pad)
    p.closePath()
    return p
  }
  const box = polys.map((c) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of c) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
    }
    return { x0, y0, x1, y1 }
  })
  // even-odd point test, so a self-intersecting outline reports its own hole
  const insidePoly = (c: Pt[], q: Pt) => {
    let inside = false
    for (let i = 0, k = c.length - 1; i < c.length; k = i++) {
      const a = c[i]
      const b = c[k]
      if ((a.y > q.y) !== (b.y > q.y) && q.x < a.x + ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y))
        inside = !inside
    }
    return inside
  }
  const contained = polys.map((c, i) =>
    polys.some((o, j) => {
      if (i === j) return false
      if (box[i].x0 < box[j].x0 || box[i].x1 > box[j].x1) return false
      if (box[i].y0 < box[j].y0 || box[i].y1 > box[j].y1) return false
      // a vertex of i, and its centroid, both inside j
      const cx = c.reduce((s, p) => s + p.x, 0) / c.length
      const cy = c.reduce((s, p) => s + p.y, 0) / c.length
      return insidePoly(o, c[0]) && insidePoly(o, { x: cx, y: cy })
    }),
  )
  ctx.fillStyle = '#000'
  for (let i = 0; i < polys.length; i++)
    if (!contained[i]) ctx.fill(pathOf(polys[i]), 'evenodd')
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < polys.length; i++)
    if (contained[i]) ctx.fill(pathOf(polys[i]), 'evenodd')
  ctx.globalCompositeOperation = 'source-over'
  const data = ctx.getImageData(0, 0, w, h).data
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = data[i * 4 + 3] > 127 ? 1 : 0
  return { bin, w, h, pxPerMm, padPx: pad }
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
// Returns distance in px from each inside pixel to the nearest outside pixel.
export function distanceTransform(grid: Grid): Float32Array {
  const { bin, w, h } = grid
  const INF = 1e12
  const f = new Float64Array(Math.max(w, h))
  const d = new Float64Array(Math.max(w, h))
  const v = new Int32Array(Math.max(w, h))
  const z = new Float64Array(Math.max(w, h) + 1)
  const dist = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) dist[i] = bin[i] ? INF : 0

  const dt1d = (n: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = dist[y * w + x]
    dt1d(w)
    for (let x = 0; x < w; x++) dist[y * w + x] = d[x]
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = dist[y * w + x]
    dt1d(h)
    for (let y = 0; y < h; y++) dist[y * w + x] = d[y]
  }
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(dist[i])
  return out
}

// Marching squares over a binary grid; returns closed pixel-space contours.
export function marchingSquares(bin: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? bin[y * w + x] : 0)
  const visited = new Set<number>()
  const edgeId = (x: number, y: number, d: number) => (y * (w + 1) + x) * 4 + d
  const contours: Pt[][] = []
  const caseOf = (x: number, y: number) =>
    (at(x, y) << 3) | (at(x + 1, y) << 2) | (at(x + 1, y + 1) << 1) | at(x, y + 1)
  const table: Record<number, number[][]> = {
    1: [[2, 3]], 2: [[1, 2]], 3: [[1, 3]], 4: [[0, 1]],
    5: [[0, 3], [2, 1]], 6: [[0, 2]], 7: [[0, 3]],
    8: [[3, 0]], 9: [[2, 0]], 10: [[3, 2], [1, 0]],
    11: [[1, 0]], 12: [[3, 1]], 13: [[2, 1]], 14: [[3, 2]],
  }
  const mid = (x: number, y: number, d: number): Pt => {
    switch (d) {
      case 0: return { x: x + 0.5, y }
      case 1: return { x: x + 1, y: y + 0.5 }
      case 2: return { x: x + 0.5, y: y + 1 }
      default: return { x, y: y + 0.5 }
    }
  }
  const step = (x: number, y: number, d: number): [number, number, number] => {
    switch (d) {
      case 0: return [x, y - 1, 2]
      case 1: return [x + 1, y, 3]
      case 2: return [x, y + 1, 0]
      default: return [x - 1, y, 1]
    }
  }
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const segs = table[caseOf(x, y)]
      if (!segs) continue
      for (const [, exit0] of segs) {
        const id = edgeId(x + 1, y + 1, exit0)
        if (visited.has(id)) continue
        const contour: Pt[] = []
        let cx = x, cy = y, cExit = exit0
        let guard = w * h * 4
        while (guard-- > 0) {
          const vid = edgeId(cx + 1, cy + 1, cExit)
          if (visited.has(vid)) break
          visited.add(vid)
          contour.push(mid(cx, cy, cExit))
          const [nx, ny, nEntry] = step(cx, cy, cExit)
          const nsegs = table[caseOf(nx, ny)]
          if (!nsegs) break
          const seg = nsegs.find((s) => s[0] === nEntry) ?? nsegs[0]
          cx = nx
          cy = ny
          cExit = seg[1]
        }
        if (contour.length > 4) contours.push(contour)
      }
    }
  }
  return contours
}

// ---------------------------------------------------------------------------
// Greedy path walker (open paths and closed rings)
// ---------------------------------------------------------------------------

interface Path {
  pts: Pt[]
  cum: number[]
  total: number
  closed: boolean
}

function norm(v: Pt): Pt {
  const l = Math.hypot(v.x, v.y) || 1
  return { x: v.x / l, y: v.y / l }
}

function pointInPoly(poly: Pt[], p: Pt): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function makePath(poly: Pt[], closed: boolean): Path | null {
  const pts = [...poly]
  if (closed) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (a.x !== b.x || a.y !== b.y) pts.push(a)
  }
  const cum = [0]
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const total = cum[cum.length - 1]
  if (total <= 0) return null
  return { pts, cum, total, closed }
}

function pointAt(path: Path, s: number): Pt {
  if (path.closed) s = ((s % path.total) + path.total) % path.total
  else s = Math.max(0, Math.min(path.total, s))
  let lo = 0
  let hi = path.cum.length - 1
  while (lo + 1 < hi) {
    const m = (lo + hi) >> 1
    if (path.cum[m] <= s) lo = m
    else hi = m
  }
  const a = path.pts[lo]
  const b = path.pts[lo + 1]
  const seg = path.cum[lo + 1] - path.cum[lo]
  const t = seg === 0 ? 0 : (s - path.cum[lo]) / seg
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

// Walk a path, placing stones >= pitch apart along the arc AND >= minDist
// from every already-placed stone (chord distance matters on tight curves).
// A blocked stone slides forward until it fits. Several start phases are
// tried; the densest placement is committed to idx.
function walkPoly(poly: Pt[], closed: boolean, pitch: number, idx: SpacingIndex, phases = 5, rhythm?: number): Pt[] {
  const target = rhythm ?? pitch
  const path = makePath(poly, closed)
  if (!path) return []
  if (path.total < target * 1.2) {
    for (const s of [path.total / 2, 0, path.total]) {
      const p = pointAt(path, s)
      if (idx.canPlace(p)) {
        idx.add(p)
        return [p]
      }
    }
    return []
  }

  // CLOSED loop: divide the circumference into equal parts. Walking it
  // greedily leaves the remainder at the seam — an O came out with 28 gaps
  // of 4.54mm and one of 7.86mm.
  if (closed) {
    let m = Math.max(3, Math.round(path.total / target))
    while (m > 3 && path.total / m < pitch) m--
    const sp = path.total / m
    let best: Pt[] = []
    for (let ph = 0; ph < phases; ph++) {
      const offset = (ph / phases) * sp
      const placed: Pt[] = []
      for (let i = 0; i < m; i++) {
        const p = pointAt(path, offset + i * sp)
        let ok = idx.canPlace(p)
        if (ok)
          for (const q of placed)
            if (Math.hypot(p.x - q.x, p.y - q.y) < pitch - 1e-6) {
              ok = false
              break
            }
        if (ok) placed.push(p)
      }
      if (placed.length > best.length) best = placed
    }
    for (const p of best) idx.add(p)
    return best
  }

  const ds = target / 12
  let best: Pt[] = []
  for (let ph = 0; ph < phases; ph++) {
    const offset = (ph / phases) * target
    const placed: Pt[] = []
    let arcSince = target
    for (let s = offset; s < path.total; s += ds) {
      if (arcSince < target) {
        arcSince += ds
        continue
      }
      const p = pointAt(path, s)
      if (!idx.canPlace(p)) continue
      let ok = true
      for (const o of placed) {
        if (Math.hypot(p.x - o.x, p.y - o.y) < idx.minDist) {
          ok = false
          break
        }
      }
      if (!ok) continue
      placed.push(p)
      arcSince = 0
    }
    if (placed.length > best.length) best = placed
  }
  for (const p of best) idx.add(p)
  return best
}

export function placeRing(poly: Pt[], pitch: number, idx: SpacingIndex, phases = 5, rhythm?: number): Pt[] {
  return walkPoly(poly, true, pitch, idx, phases, rhythm)
}

// Place a run of stones between two arc positions on a path. The run is laid
// out evenly, blocked stones are nudged to legal spots, then the WHOLE run
// relaxes — every stone pulled toward the midpoint of its neighbors — so an
// obstacle bends the spacing smoothly instead of leaving one crammed pair
// next to one big gap.
function placeRun(
  path: Path,
  sLo: number,
  sHi: number,
  pitch: number,
  idx: SpacingIndex,
  inside?: (p: Pt) => boolean,
  rhythm?: number,
): Pt[] {
  const target = rhythm ?? pitch * 1.15
  void inside
  const span = sHi - sLo
  if (span < 0) return []
  {
    const even = tryEvenLayout(path, sLo, sHi, true, pitch, target, idx)
    if (even) return even
  }
  if (span < pitch) {
    // short edges get a CENTERED stone or none — off-center fallback singles
    // read as mistakes and make identical features render differently
    for (const f of [0.5, 0.47, 0.53]) {
      const p = pointAt(path, sLo + f * span)
      if (idx.canPlace(p)) {
        idx.add(p)
        return [p]
      }
    }
    // NEVER off the line — no stone beats a bent stone
    return []
  }
  let m = Math.max(2, Math.round(span / target) + 1)
  while (m > 2 && span / (m - 1) < pitch * 1.02) m--

  // If a run can't legally hold its stone count (tight curve, external
  // blockers), retry the WHOLE run with one fewer stone — an even run with
  // fewer stones beats a dropped stone's hole.
  let s: number[] = []
  let pt: Pt[] = []
  for (let attempt = 0; attempt < 4; attempt++) {
    const sp = span / (m - 1)
    s = []
    for (let i = 0; i < m; i++) s.push(sLo + i * sp)
    pt = s.map((v) => pointAt(path, v))

    // free externally-blocked stones (scan outward for nearest legal arc,
    // reaching up to just short of the neighboring stones so one stuck stone
    // never forces the whole run to drop a stone)
    for (let i = 0; i < m; i++) {
      if (idx.canPlace(pt[i])) continue
      const loLim = i > 0 ? s[i - 1] + 0.4 : sLo
      const hiLim = i < m - 1 ? s[i + 1] - 0.4 : sHi
      outer: for (let d = 0.1; d <= sp * 1.2; d += 0.1) {
        for (const sign of [1, -1]) {
          const cand = s[i] + sign * d
          if (cand < loLim || cand > hiLim) continue
          const p = pointAt(path, cand)
          if (idx.canPlace(p)) {
            s[i] = cand
            pt[i] = p
            break outer
          }
        }
      }
    }

    // equal-gap relaxation with obstacle respect
    for (let it = 0; it < 40; it++) {
      let moved = false
      for (let i = 0; i < m; i++) {
        const target = i === 0 ? sLo : i === m - 1 ? sHi : (s[i - 1] + s[i + 1]) / 2
        let step = (target - s[i]) * 0.5
        if (Math.abs(step) < 0.02) continue
        for (let k = 0; k < 3; k++) {
          let cand = s[i] + step
          if (i > 0) cand = Math.max(cand, s[i - 1] + sp * 0.25)
          if (i < m - 1) cand = Math.min(cand, s[i + 1] - sp * 0.25)
          cand = Math.max(sLo, Math.min(sHi, cand))
          const p = pointAt(path, cand)
          const okPrev = i === 0 || Math.hypot(p.x - pt[i - 1].x, p.y - pt[i - 1].y) >= pitch
          const okNext = i === m - 1 || Math.hypot(p.x - pt[i + 1].x, p.y - pt[i + 1].y) >= pitch
          if (okPrev && okNext && idx.canPlace(p)) {
            s[i] = cand
            pt[i] = p
            moved = true
            break
          }
          step *= 0.4
        }
      }
      if (!moved) break
    }

    // run is valid only if every stone is placeable and clears its neighbor
    let ok = true
    for (let i = 0; i < m && ok; i++) {
      if (!idx.canPlace(pt[i])) ok = false
      else if (i > 0 && Math.hypot(pt[i].x - pt[i - 1].x, pt[i].y - pt[i - 1].y) < pitch * 0.995) ok = false
    }
    if (ok || m <= 2) break
    m--
  }

  const placed: Pt[] = []
  let last: Pt | null = null
  for (let i = 0; i < m; i++) {
    const p = pt[i]
    if (idx.canPlace(p) && (!last || Math.hypot(p.x - last.x, p.y - last.y) >= pitch * 0.98)) {
      idx.add(p)
      placed.push(p)
      last = p
    }
  }
  return placed
}

// Open runs (skeleton spines, stroke centerlines) are spans end-to-end.
function placeOpenEven(poly: Pt[], pitch: number, idx: SpacingIndex, rhythm?: number): Pt[] {
  const path = makePath(poly, false)
  if (!path) return []
  return placeRun(path, 0, path.total, pitch, idx, undefined, rhythm)
}

// Place interior stones between two ALREADY-PLACED corner anchors so that
// every gap — corner→stone, stone→stone, stone→corner — is equal. The corner
// stones are part of the row's rhythm, not obstacles at its ends.

/**
 * Try to lay a span out as EQUAL parts that also clear the rhythm against
 * everything already placed. Returns null if no stone count achieves it.
 *
 * This is the preferred layout, tried before the older placers. Those handle
 * a blocked stone by nudging it off its beat, which is what puts a cluster at
 * a junction: a run meets a corner or another run and its end stones bunch
 * while its middle stays even. Re-dividing with one fewer stone keeps the run
 * even instead.
 *
 * Returning null rather than an empty layout matters. Demanding rhythm-width
 * clearance everywhere starves any feature that legitimately runs close to
 * another -- a counter beside a stem, a converging channel -- and the feature
 * comes out bare. The caller falls back to the older behaviour there, so the
 * worst case is exactly what we had before.
 */
function tryEvenLayout(
  path: Path,
  aArc: number,
  bArc: number,
  includeEnds: boolean,
  pitch: number,
  rhythm: number,
  idx: SpacingIndex,
): Pt[] | null {
  const L = bArc - aArc
  if (L <= 1e-9) return null
  const wantSep = rhythm * 0.93
  const tangentAt = (s: number) => {
    const e = Math.min(0.5, Math.max(0.05, L / 20))
    const p0 = pointAt(path, Math.max(0, s - e))
    const p1 = pointAt(path, s + e)
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const l = Math.hypot(dx, dy)
    return l < 1e-9 ? null : { x: dx / l, y: dy / l }
  }
  // Crowding is stones too close ALONG a run. Two rows running parallel — a
  // stroke's two walls — are normal and often closer than a rhythm.
  // Never demand more clearance than the layout itself provides. A span
  // shorter than two beats divides into gaps smaller than the rhythm — an E
  // arm's end cap is 8.5mm, so its one stone sits 4.25mm from each corner —
  // and judging that against a rhythm-width bar would reject the only correct
  // answer. The bar is for FOREIGN stones intruding on a run, never for the
  // run's own even spacing.
  const fits = (pts: Pt[], arcs: number[], sp: number) => {
    const minSep = Math.min(wantSep, sp)
    for (let i = 0; i < pts.length; i++) {
      if (!idx.canPlace(pts[i])) return false
      const t = tangentAt(arcs[i])
      if (t)
        for (const o of idx.within(pts[i], minSep)) {
          const dx = o.x - pts[i].x
          const dy = o.y - pts[i].y
          const l = Math.hypot(dx, dy)
          if (l < 1e-9) return false
          if (Math.abs((dx / l) * t.x + (dy / l) * t.y) > 0.7) return false
        }
      for (let j = 0; j < i; j++)
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < pitch - 1e-6) return false
    }
    return true
  }
  const ideal = includeEnds
    ? Math.max(2, Math.round(L / rhythm) + 1)
    : Math.max(0, Math.round(L / rhythm) - 1)
  // Accept only if the rhythm-clearance costs at most ONE stone. Where a run
  // sits close to another for its whole length — a spine beside its own wall,
  // two converging walls — no dense layout ever clears, and the first one that
  // does is far too sparse: a V dropped from 47 stones at 4.97mm to 37 at
  // 6.99mm. Better to hand those back to the older placer untouched.
  const floor = Math.max(includeEnds ? 2 : 1, ideal - 1)
  for (let m = ideal; m >= floor; m--) {
    const arcs: number[] = []
    const sp = includeEnds ? L / (m - 1) : L / (m + 1)
    if (sp < pitch * 1.005) continue
    if (includeEnds) for (let i = 0; i < m; i++) arcs.push(aArc + i * sp)
    else for (let i = 1; i <= m; i++) arcs.push(aArc + i * sp)
    const pts = arcs.map((s) => pointAt(path, s))
    if (!fits(pts, arcs, sp)) continue
    for (const p of pts) idx.add(p)
    return pts
  }
  return null
}

function placeBetweenAnchors(
  path: Path,
  aArc: number,
  bArc: number,
  minSp: number,
  pitch: number,
  idx: SpacingIndex,
  inside?: (p: Pt) => boolean,
  targetR?: number,
  chordE?: number,
  phase = 0, // 0 = rows anchored to corners; 0.5 = half-offset (brick)
): Pt[] {
  void inside
  const E = bArc - aArc
  if (E <= 0) return []
  const need = Math.max(minSp, pitch * 1.005)
  const r = targetR ?? pitch * 1.15
  {
    const even = tryEvenLayout(path, aArc, bArc, false, pitch, r, idx)
    if (even) return even
  }
  {
    // A sharp corner demands its neighbours keep an offset. Making the WHOLE
    // span re-divide to honour that collapses the count -- a 35mm span wanting
    // 6 stones dropped to 3, an 8.75mm rhythm against the letter's 4.8mm, and
    // the run read as half empty. Inset the span by the offset and divide THAT
    // evenly instead: the ends sit exactly where the corner allows and the
    // interior keeps the beat.
    if (minSp > 0 && bArc - aArc > 2 * minSp + pitch) {
      const even2 = tryEvenLayout(path, aArc + minSp, bArc - minSp, true, pitch, r, idx)
      if (even2) return even2
    }
  }
  const Lc = chordE ?? E
  const aPt = pointAt(path, aArc)
  const bPt = pointAt(path, bArc)

  // one full layout attempt at a given stone count; nothing committed
  const attempt = (m: number): { pt: Pt[]; ok: boolean; spread: number; why?: string } => {
    const sp = phase === 0 ? E / (m + 1) : E / m
    const s: number[] = []
    for (let i = 0; i < m; i++) s.push(aArc + (phase === 0 ? (i + 1) * sp : (i + 0.5) * sp))
    const pt = s.map((v) => pointAt(path, v))
    // free blocked stones
    for (let i = 0; i < m; i++) {
      if (idx.canPlace(pt[i])) continue
      const loLim = (i > 0 ? s[i - 1] : aArc) + 0.4
      const hiLim = (i < m - 1 ? s[i + 1] : bArc) - 0.4
      outer: for (let d = 0.1; d <= sp; d += 0.1) {
        for (const sign of [1, -1]) {
          const cand = s[i] + sign * d
          if (cand < loLim || cand > hiLim) continue
          const p = pointAt(path, cand)
          if (idx.canPlace(p)) {
            s[i] = cand
            pt[i] = p
            break outer
          }
        }
      }
    }
    // if even seeding left stones in blocked spots, greedy-search the span
    // for ANY legal arrangement of the full count, then relax to even —
    // only surrender a stone when no arrangement exists at all
    {
      let blocked = false
      for (let i = 0; i < m; i++) if (!idx.canPlace(pt[i])) blocked = true
      if (blocked) {
        const gs: number[] = []
        const gp: Pt[] = []
        let cursor = aArc + 0.4
        while (gs.length < m && cursor <= bArc - 0.4) {
          const p = pointAt(path, cursor)
          const prevOk = gs.length === 0
            ? Math.hypot(p.x - aPt.x, p.y - aPt.y) >= minSp * 0.9
            : Math.hypot(p.x - gp[gp.length - 1].x, p.y - gp[gp.length - 1].y) >= pitch
          if (prevOk && idx.canPlace(p)) {
            gs.push(cursor)
            gp.push(p)
            cursor += pitch * 0.9
          } else cursor += 0.15
        }
        if (gs.length === m && Math.hypot(bPt.x - gp[m - 1].x, bPt.y - gp[m - 1].y) >= minSp * 0.9) {
          for (let i = 0; i < m; i++) {
            s[i] = gs[i]
            pt[i] = gp[i]
          }
        }
      }
    }
    // equal-CHORD relaxation with anchors as fixed neighbors
    for (let it = 0; it < 60; it++) {
      let moved = false
      for (let i = 0; i < m; i++) {
        const prevS = i === 0 ? aArc : s[i - 1]
        const nextS = i === m - 1 ? bArc : s[i + 1]
        const prevPt = i === 0 ? aPt : pt[i - 1]
        const nextPt = i === m - 1 ? bPt : pt[i + 1]
        const cPrev = Math.hypot(pt[i].x - prevPt.x, pt[i].y - prevPt.y)
        const cNext = Math.hypot(pt[i].x - nextPt.x, pt[i].y - nextPt.y)
        let step = (cNext - cPrev) * 0.45
        if (Math.abs(step) < 0.02) continue
        for (let k = 0; k < 3; k++) {
          let cand = s[i] + step
          cand = Math.max(prevS + sp * 0.3, Math.min(nextS - sp * 0.3, cand))
          const p = pointAt(path, cand)
          const okPrev = i === 0 || Math.hypot(p.x - pt[i - 1].x, p.y - pt[i - 1].y) >= pitch
          const okNext = i === m - 1 || Math.hypot(p.x - pt[i + 1].x, p.y - pt[i + 1].y) >= pitch
          if (okPrev && okNext && idx.canPlace(p)) {
            s[i] = cand
            pt[i] = p
            moved = true
            break
          }
          step *= 0.4
        }
      }
      if (!moved) break
    }
    // judge: every stone placeable, consecutive chords legal, spread of the
    // full anchor-to-anchor chain
    const chain = [aPt, ...pt, bPt]
    let ok = true
    let why = ''
    for (let i = 0; i < m; i++) if (!idx.canPlace(pt[i])) { ok = false; why += `place${i};` }
    const chords: number[] = []
    for (let i = 1; i < chain.length; i++)
      chords.push(Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y))
    for (let i = 1; i <= m - 1; i++) if (chords[i] < pitch) { ok = false; why += `chord${i}=${chords[i].toFixed(2)};` }
    const spread = Math.max(...chords) - Math.min(...chords)
    const mean = chords.reduce((a2, b2) => a2 + b2, 0) / chords.length
    // score = internal evenness AND fidelity to the design rhythm — an even
    // row at the wrong beat must lose to an even row at the right beat
    const score = spread * 2 + Math.abs(mean - r)
    return { pt, ok, spread: score, why }
  }

  let m0 = phase === 0 ? Math.round(Lc / r) - 1 : Math.round(Lc / r)
  while (m0 > 0 && Lc / (m0 + (phase === 0 ? 1 : 0)) < need) m0--
  if (m0 <= 0) {
    for (const f of [0.5, 0.47, 0.53]) {
      const p = pointAt(path, aArc + f * E)
      if (idx.canPlace(p)) {
        idx.add(p)
        {
          const chords = [
            +Math.hypot(p.x - aPt.x, p.y - aPt.y).toFixed(2),
            +Math.hypot(bPt.x - p.x, bPt.y - p.y).toFixed(2),
          ]
          debugSpans.push({
            at: `${aPt.x.toFixed(0)},${aPt.y.toFixed(0)}`,
            chords,
            r: +r.toFixed(2),
            m0,
            Lc: +Lc.toFixed(2),
            E: +E.toFixed(2),
            need: +need.toFixed(2),
          })
        }
        return [p]
      }
    }
    return []
  }

  // try the ideal count and its neighbors; commit the cleanest legal layout
  const cands: number[] = [m0]
  if (m0 + 1 >= 1 && E / (m0 + 2) >= pitch * 1.0) cands.push(m0 + 1)
  if (m0 - 1 >= 1) cands.push(m0 - 1)
  let best: { pt: Pt[]; ok: boolean; spread: number; why?: string } | null = null
  const attLog: string[] = []
  for (const m of cands) {
    const a = attempt(m)
    attLog.push(`${m}:${a.ok ? 'ok' : a.why}`)
    if (!best) best = a
    else if (a.ok && !best.ok) best = a
    else if (a.ok === best.ok && a.spread < best.spread - 1e-9) best = a
  }
  // NEVER commit a layout with holes: if no candidate count is fully legal,
  // descend until one is — fewer stones evenly spaced beat a silent gap
  if (best && !best.ok) {
    for (let m = m0 - 2; m >= 1; m--) {
      const a = attempt(m)
      if (a.ok) {
        best = a
        break
      }
    }
  }
  if (!best) return []

  const placed: Pt[] = []
  let last: Pt | null = null
  for (const p of best.pt) {
    if (idx.canPlace(p) && (!last || Math.hypot(p.x - last.x, p.y - last.y) >= pitch * 0.999)) {
      idx.add(p)
      placed.push(p)
      last = p
    }
  }
  {
    const chain = [aPt, ...placed, bPt]
    const chords: number[] = []
    for (let i = 1; i < chain.length; i++)
      chords.push(+Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y).toFixed(2))
    debugSpans.push({ at: `${aPt.x.toFixed(0)},${aPt.y.toFixed(0)}`, chords, r: +r.toFixed(2), m0, mFinal: placed.length, att: attLog.join(' | ') })
  }
  return placed
}


interface ContourCorner {
  arc: number
  off: number
  alpha: number
  apex: Pt
  key: boolean // sharp, shape-defining corner — harmonization span boundary
}
interface ContourInfo {
  poly: Pt[]
  path: Path | null
  corners: ContourCorner[]
  fallback: boolean
}

// Phase 0: detect corners on a contour — no stones placed yet.

/**
 * Drop contour detail finer than a stone.
 *
 * A notch or step smaller than the stone cannot be represented by stones at
 * all, so tracing it only makes the row jog sideways and then come back — a
 * straight stem picks up a visible kink where the letterform has a small step.
 * Douglas-Peucker at a third of the hole diameter removes those while leaving
 * every corner the eye actually reads.
 */
function simplifyContour(poly: Pt[], tol: number): Pt[] {
  if (poly.length < 4) return poly
  const keep = new Uint8Array(poly.length)
  keep[0] = 1
  keep[poly.length - 1] = 1
  const stack: [number, number][] = [[0, poly.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    const pa = poly[a]
    const pb = poly[b]
    const L = Math.hypot(pb.x - pa.x, pb.y - pa.y)
    let worst = -1
    let wi = -1
    for (let i = a + 1; i < b; i++) {
      const p = poly[i]
      const d =
        L < 1e-9
          ? Math.hypot(p.x - pa.x, p.y - pa.y)
          : Math.abs((pb.x - pa.x) * (pa.y - p.y) - (pa.x - p.x) * (pb.y - pa.y)) / L
      if (d > worst) {
        worst = d
        wi = i
      }
    }
    if (worst > tol && wi > 0) {
      keep[wi] = 1
      stack.push([a, wi], [wi, b])
    }
  }
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) if (keep[i]) out.push(poly[i])
  return out.length >= 3 ? out : poly
}

function analyzeContour(poly: Pt[], pitch: number, rhythm?: number): ContourInfo {
  const target = rhythm ?? pitch * 1.15
  const path = makePath(poly, true)
  if (!path || path.total < pitch * 2.5) return { poly, path, corners: [], fallback: true }
  const step = 0.3
  const n = Math.max(16, Math.round(path.total / step))
  const ds = path.total / n
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) pts.push(pointAt(path, i * ds))
  const wrap = (i: number) => ((i % n) + n) % n
  const win = Math.max(1, Math.round((pitch * 0.7) / ds))
  const turns = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = pts[wrap(i - win)]
    const b = pts[i]
    const c = pts[wrap(i + win)]
    const d1 = Math.atan2(b.y - a.y, b.x - a.x)
    const d2 = Math.atan2(c.y - b.y, c.x - b.x)
    let t = d2 - d1
    while (t > Math.PI) t -= 2 * Math.PI
    while (t < -Math.PI) t += 2 * Math.PI
    turns[i] = t
  }
  const CORNER_TURN = 0.9
  const cand: number[] = []
  for (let i = 0; i < n; i++) if (Math.abs(turns[i]) > CORNER_TURN) cand.push(i)
  cand.sort((a, b) => Math.abs(turns[b]) - Math.abs(turns[a]))
  // significance: a corner must change direction AT STONE SCALE. Measured
  // across a ~1.5-pitch window, a real corner's net turn stays large; a
  // micro-bump (like a 2mm font spur) returns to course — net turn ~0 —
  // and gets no stone: the row runs straight through it.
  const W2 = Math.max(win + 1, Math.round((target * 2.0) / ds))
  const significant = (i: number): boolean => {
    const a = pts[wrap(i - W2)]
    const b = pts[i]
    const c = pts[wrap(i + W2)]
    const d1 = Math.atan2(b.y - a.y, b.x - a.x)
    const d2 = Math.atan2(c.y - b.y, c.x - b.x)
    let t = d2 - d1
    while (t > Math.PI) t -= 2 * Math.PI
    while (t < -Math.PI) t += 2 * Math.PI
    return Math.abs(t) > 0.55
  }
  const kept: number[] = []
  for (const i of cand) {
    if (!significant(i)) continue
    let ok = true
    for (const j of kept) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < pitch * 1.05) { ok = false; break }
      let arc = Math.abs(i - j) * ds
      arc = Math.min(arc, path.total - arc)
      if (arc < pitch * 0.6) { ok = false; break }
    }
    if (ok) kept.push(i)
  }
  if (!kept.length) return { poly, path, corners: [], fallback: true }
  kept.sort((a, b) => a - b)
  const corners: ContourCorner[] = []
  for (const i of kept) {
    const a = pts[wrap(i - win)]
    const c = pts[wrap(i + win)]
    const chordLen = Math.hypot(c.x - a.x, c.y - a.y) || 1
    let best = i
    let bestD = -1
    for (let j = i - win; j <= i + win; j++) {
      const p = pts[wrap(j)]
      const d = Math.abs((c.x - a.x) * (a.y - p.y) - (a.x - p.x) * (c.y - a.y)) / chordLen
      if (d > bestD) { bestD = d; best = j }
    }
    const apex = pts[wrap(best)]
    const alpha = Math.max(0.35, Math.PI - Math.abs(turns[i]))
    const off = Math.min(target * 2.5, Math.max(pitch * 1.02, (pitch * 1.08) / (2 * Math.sin(alpha / 2))))
    corners.push({ arc: wrap(best) * ds, off, alpha, apex, key: Math.abs(turns[i]) >= 1.2 })
  }
  corners.sort((a, b) => a.arc - b.arc)
  return { poly, path, corners, fallback: false }
}

// Phase 1: corner anchors — highest authority after detail lines. A corner
// that cannot hold a stone STAYS in the corner list as a hard boundary:
// edges never run across a corner, so straight never reads chamfered.
function placeContourCorners(
  info: ContourInfo,
  pitch: number,
  idx: SpacingIndex,
  out: Pt[],
  banned?: (p: Pt) => boolean,
  rhythm?: number,
) {
  void rhythm
  void pitch
  if (info.fallback || !info.path) return
  for (const cn of info.corners) {
    if (banned?.(cn.apex)) continue
    if (!idx.canPlace(cn.apex)) continue
    idx.add(cn.apex)
    out.push(cn.apex)
    dbg('corner', [cn.apex])
  }
}

/**
 * Tip spines: a short run in along the bisector of a sharp convex corner, so a
 * narrow tip reads as filled rather than as a single point.
 *
 * Placed AFTER every wall, deliberately. Run before them it cannot see what is
 * coming, and at a sharp corner the walls then arrive one beat along each edge
 * and land a floor-width from it — corner, tip spine and first wall stone in a
 * knot, which is what a V's apex and top corners looked like. Placed last it
 * simply declines where there is no room.
 */
function placeContourTipSpines(
  info: ContourInfo,
  pitch: number,
  idx: SpacingIndex,
  out: Pt[],
  banned?: (p: Pt) => boolean,
  rhythm?: number,
) {
  const target = rhythm ?? pitch * 1.15
  void banned
  if (info.fallback || !info.path) return
  // tip spines at sharp convex corners
  for (const cn of info.corners) {
    if (cn.alpha > 1.31) continue
    const q1 = pointAt(info.path, cn.arc + cn.off * 0.7)
    const q2 = pointAt(info.path, cn.arc - cn.off * 0.7)
    const e1 = norm({ x: q1.x - cn.apex.x, y: q1.y - cn.apex.y })
    const e2 = norm({ x: q2.x - cn.apex.x, y: q2.y - cn.apex.y })
    const bis = norm({ x: e1.x + e2.x, y: e1.y + e2.y })
    if (!isFinite(bis.x)) continue
    const probe = { x: cn.apex.x + bis.x * pitch * 0.8, y: cn.apex.y + bis.y * pitch * 0.8 }
    if (!pointInPoly(info.poly, probe)) continue
    const halfSin = Math.sin(cn.alpha / 2)
    for (let s = target * 1.02; s * halfSin < target * 0.95 && s < target * 6.3; s += target * 1.02) {
      const p = { x: cn.apex.x + bis.x * s, y: cn.apex.y + bis.y * s }
      if (!pointInPoly(info.poly, p)) break
      // clear the RHYTHM from the walls, not merely the floor
      if (idx.within(p, target * 0.93).length) continue
      if (idx.canPlace(p)) {
        idx.add(p)
        out.push(p)
        dbg('spine', [p])
      }
    }
  }
}

// Usable length of an arc segment at stone scale: stones consume CHORD
// distance, so on curves the effective length is the sum of pitch-sized
// chords, not the arc length.
function chordLength(path: Path, aArc: number, bArc: number, pitch: number): number {
  const E = bArc - aArc
  if (E <= pitch) return Math.hypot(
    pointAt(path, bArc).x - pointAt(path, aArc).x,
    pointAt(path, bArc).y - pointAt(path, aArc).y,
  )
  let sum = 0
  let s = aArc
  while (s < bArc) {
    const e = Math.min(s + pitch, bArc)
    const p1 = pointAt(path, s)
    const p2 = pointAt(path, e)
    sum += Math.hypot(p2.x - p1.x, p2.y - p1.y)
    s = e
  }
  return sum
}

// Phase 2: edges — equal division between corner boundaries (placed or not).
function placeContourEdges(
  info: ContourInfo,
  pitch: number,
  idx: SpacingIndex,
  out: Pt[],
  inside?: (p: Pt) => boolean,
  banned?: (p: Pt) => boolean,
  rhythm?: number,
  uniform = false, // one shared beat for the whole contour (edges match)
  phase = 0,
) {
  const target = rhythm ?? pitch * 1.15
  if (info.fallback || !info.path) {
    // no usable corner analysis: walk the loop at an even division
    const got = walkPoly(info.poly, true, pitch, idx)
    dbg('loop', got)
    out.push(...got)
    return
  }
  const path = info.path
  const corners = info.corners
  // Harmonization: segments run anchor-to-anchor (every frozen stone is a
  // KNOWN node), but the RHYTHM is chosen per key-to-key span group — the
  // beat flows straight through frozen minor corners instead of colliding
  // with them.
  const segs: { aArc: number; rawEnd: number; minSp: number; Lc: number; group: number }[] = []
  let groupId = 0
  const hasKeys = corners.some((c) => c.key)
  for (let ci = 0; ci < corners.length; ci++) {
    const a = corners[ci]
    const b = corners[(ci + 1) % corners.length]
    const rawEnd = ci + 1 < corners.length ? b.arc : b.arc + path.total
    const minSp = Math.max(a.alpha < 1.05 ? a.off : 0, b.alpha < 1.05 ? b.off : 0)
    segs.push({ aArc: a.arc, rawEnd, minSp, Lc: chordLength(path, a.arc, rawEnd, target), group: groupId })
    if (!hasKeys || b.key) groupId++
  }
  if (hasKeys && segs.length && !corners[0].key) {
    const lastG = segs[segs.length - 1].group
    for (const sg of segs) if (sg.group === lastG) sg.group = 0
  }
  // per-group minimax rhythm: the eye judges the WORST gap in a span.
  // uniform mode: ALL spans share one group → one beat across the letter.
  if (uniform) for (const sg of segs) sg.group = 0
  const groupR = new Map<number, number>()
  for (const gid of [...new Set(segs.map((sg) => sg.group))]) {
    const gsegs = segs.filter((sg) => sg.group === gid)
    let gr = target
    let bestWorst = Infinity
    let bestSum = Infinity
    const rLo = Math.max(pitch * 1.03, target * 0.88)
    const rHi = Math.max(rLo + pitch * 0.02, target * 1.12)
    for (let r = rLo; r <= rHi; r += (rHi - rLo) / 30) {
      let worst = 0
      let sum = 0
      for (const sg of gsegs) {
        let m = Math.max(0, Math.round(sg.Lc / r) - 1)
        while (m > 0 && sg.Lc / (m + 1) < pitch * 1.005) m--
        const sp = sg.Lc / (m + 1)
        const dev = Math.abs(sp - r)
        if (dev > worst) worst = dev
        sum += dev
      }
      if (worst < bestWorst - 1e-9 || (Math.abs(worst - bestWorst) < 1e-9 && sum < bestSum)) {
        bestWorst = worst
        bestSum = sum
        gr = r
      }
    }
    groupR.set(gid, gr)
  }
  for (let ci = 0; ci < segs.length; ci++) {
    const { aArc, rawEnd, minSp, Lc, group } = segs[ci]
    const bestR = groupR.get(group) ?? target
    if (!banned) {
      const got = placeBetweenAnchors(path, aArc, rawEnd, minSp, pitch, idx, inside, bestR, Lc, phase)
      dbg('edge', got)
      out.push(...got)
      continue
    }
    const scan = 0.5
    const free: { u: number; v: number }[] = []
    let cur: { u: number; v: number } | null = null
    for (let sPos = aArc; sPos <= rawEnd; sPos += scan) {
      if (!banned(pointAt(path, sPos))) {
        if (cur) cur.v = sPos
        else cur = { u: sPos, v: sPos }
      } else if (cur) {
        free.push(cur)
        cur = null
      }
    }
    if (cur) free.push(cur)
    for (const iv of free) {
      const uAnch = iv.u <= aArc + scan
      const vAnch = iv.v >= rawEnd - scan
      if (uAnch && vAnch) {
        const got = placeBetweenAnchors(path, aArc, rawEnd, minSp, pitch, idx, inside, bestR, Lc)
        dbg('edge', got)
        out.push(...got)
      } else if (uAnch || vAnch) {
        // Anchored at one end: divide the free stretch EVENLY from that
        // anchor. Starting one minimum-offset away and then marching at the
        // target puts a floor-width gap right beside an oversized one at
        // every corner where a wall meets a banned zone — the tops of a K, a
        // V, an N, which is where the eye lands first.
        const u2 = uAnch ? aArc : iv.u
        const v2 = vAnch ? rawEnd : iv.v
        if (v2 - u2 > 0.3) {
          const got = placeBetweenAnchors(
            path, u2, v2, minSp, pitch, idx, inside, bestR,
            chordLength(path, u2, v2, target),
          )
          dbg('edge', got)
          out.push(...got)
        }
      } else {
        const u = iv.u
        const v = iv.v
        if (v - u > 0.3) {
          const got = placeRun(path, u, v, pitch, idx, inside, target)
          dbg('edge', got)
          out.push(...got)
        }
      }
    }
  }
}

// Outline that understands stroke width: shape regions too narrow for stone
// rows on both walls render as a single centerline run (the single-line
// rhinestone lettering style); wide regions get true wall outlines.
export type OutlineStyle = 'auto' | 'walls' | 'centerline'

export function outlineOrSpine(
  contours: Pt[][],
  grid: Grid,
  holeMm: number,
  gapMm: number,
  idx: SpacingIndex,
  style: OutlineStyle = 'auto',
  wholeWord = false, // text: one narrow letter switches the whole word
  rhythmMm?: number, // design target spacing (center-to-center); pitch stays the legal floor
  uniformRhythm = false,
): Pt[] {
  debugStones.length = 0
  debugSpans.length = 0
  const { bin, w, h, pxPerMm, padPx } = grid
  const pitch = holeMm + gapMm
  const rhythm = rhythmMm ?? pitch * 1.15
  const dt = distanceTransform(grid)
  const toMm = (p: Pt): Pt => ({ x: (p.x - padPx) / pxPerMm, y: (p.y - padPx) / pxPerMm })
  const { labels, count } = labelComponents(bin, w, h)
  const maxD = new Float32Array(count + 1)
  for (let i = 0; i < w * h; i++) if (labels[i] && dt[i] > maxD[labels[i]]) maxD[labels[i]] = dt[i]

  // which component does a contour bound?
  const labelOf = (c: Pt[]): number => {
    for (const v of [c[0], c[Math.floor(c.length / 2)]]) {
      const px = Math.round(v.x * pxPerMm + padPx)
      const py = Math.round(v.y * pxPerMm + padPx)
      for (let r = 0; r <= 3; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const x = px + dx
            const y = py + dy
            if (x < 0 || y < 0 || x >= w || y >= h) continue
            if (labels[y * w + x]) return labels[y * w + x]
          }
    }
    return 0
  }

  // An outline follows the font lines; the centreline fallback fires when a
  // stroke can't carry two readable rows.
  void wholeWord
  void maxD
  // Judge a letter by its TYPICAL stroke width, not its fattest point. The
  // max distance-to-edge sits at a junction (where an E's stem meets an arm),
  // so using it declares the whole letter "wide" and leaves thin stems with
  // two wall rows crammed at the bare minimum. The median distance along the
  // medial axis is the real stroke half-width.
  const typicalHalf = ridgeWidthsByLabel(labels, count, dt, w, h)
  for (let lbl = 1; lbl <= count; lbl++) if (!typicalHalf[lbl]) typicalHalf[lbl] = maxD[lbl]
  // Two wall rows need room to READ as two rows. At ~1.05x pitch they are
  // legal but sit at the bare minimum — holes nearly touching, with a
  // fragile strip of template between them down the whole stroke. Below
  // 1.5x pitch a single centred spine is both cleaner and stronger.
  // Whole-letter narrowness is only an explicit choice now. Deciding it
  // automatically from ONE median stroke width per component cannot describe a
  // high-contrast face: Playfair's hairlines genuinely cannot hold two wall
  // rows while its stems easily can, and judging the letter as a whole drew
  // 51% of a word as skeleton centrelines. Thin PARTS are handled below.
  const isNarrow = (lbl: number) => style === 'centerline' && lbl > 0
  void typicalHalf

  const out: Pt[] = []
  const narrowLbls = new Set<number>()
  const wallContours: Pt[][] = []
  for (const c of contours) {
    const lbl = labelOf(c)
    if (isNarrow(lbl)) narrowLbls.add(lbl)
    else wallContours.push(c)
  }
  // -------------------------------------------------------------------------
  // Detail lines: internal channels too narrow for rows on both walls render
  // as ONE stone row along the channel's medial line — the way condensed
  // M/W valleys, serif brackets, and script hairlines are done by hand.
  // Placed FIRST so walls re-space around them.
  // -------------------------------------------------------------------------
  let bannedTest: ((p: Pt) => boolean) | undefined
  if (style === 'auto') {
    const inv = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) inv[i] = bin[i] ? 0 : 1
    const dtInv = distanceTransform({ bin: inv, w, h, pxPerMm, padPx })
    // candidate channels: any internal gap under ~1.95×pitch. Which ones
    // become detail lines is decided per channel from the gap PROFILE:
    // tapered wedges (M/W valleys) are lines end-to-end; parallel-walled
    // counters (E notches) keep their wall rows, which align naturally.
    // clamp channels to the glyph band: valleys that open at the baseline end
    // AT the baseline instead of wrapping through the sea to letter gaps.
    // Letter gaps themselves stay whole — flanked by two letters, rejected.
    let gy0 = h, gy1 = 0, gx0 = w, gx1 = 0
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (labels[y * w + x]) {
          if (y < gy0) gy0 = y
          if (y > gy1) gy1 = y
          if (x < gx0) gx0 = x
          if (x > gx1) gx1 = x
        }
    const tightMask = new Uint8Array(w * h)
    for (let y = gy0 + 1; y < gy1; y++)
      for (let x = gx0 + 1; x < gx1; x++) {
        const i = y * w + x
        tightMask[i] =
          inv[i] && dtInv[i] > 0.5 && (2 * dtInv[i]) / pxPerMm < pitch * 1.95 ? 1 : 0
      }
    // A COUNTER IS A HOLE — outline it, never thread it. The detail-line
    // machinery exists for a narrow channel that opens outward (an E's notch
    // between its arms). An enclosed counter is not that: putting a centre
    // line through it drops stones inside the hole, which is what filled the
    // middle of a lowercase e. Flood the outside; whatever the flood cannot
    // reach is a counter.
    const reachable = new Uint8Array(w * h)
    {
      const stack: number[] = []
      const push = (i: number) => {
        if (!reachable[i] && inv[i]) {
          reachable[i] = 1
          stack.push(i)
        }
      }
      for (let x = 0; x < w; x++) {
        push(x)
        push((h - 1) * w + x)
      }
      for (let y = 0; y < h; y++) {
        push(y * w)
        push(y * w + w - 1)
      }
      while (stack.length) {
        const i = stack.pop() as number
        const x = i % w
        if (x > 0) push(i - 1)
        if (x < w - 1) push(i + 1)
        if (i >= w) push(i - w)
        if (i < w * (h - 1)) push(i + w)
      }
    }
    const ch = labelComponents(tightMask, w, h)
    if (ch.count) {
      // one pass: which letter(s) flank each channel + px membership
      const flank = new Int32Array(ch.count + 1)
      const multi = new Uint8Array(ch.count + 1)
      const members = new Map<number, number[]>()
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          const l = ch.labels[i]
          if (!l) continue
          const arr = members.get(l)
          if (arr) arr.push(i)
          else members.set(l, [i])
          for (let dy2 = -1; dy2 <= 1; dy2++)
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue
              const sl = labels[(y + dy2) * w + (x + dx2)]
              if (!sl) continue
              if (!flank[l]) flank[l] = sl
              else if (sl !== flank[l]) multi[l] = 1
            }
        }
      }
      const chMask = new Uint8Array(w * h)
      const acceptedMask = new Uint8Array(w * h)
      let anyAccepted = false
      for (const [lbl, px] of members) {
        // a detail line lives INSIDE one letter; letter-to-letter gaps have
        // two flanking letters and are left alone
        if (multi[lbl] || !flank[lbl] || px.length < 6) continue
        // enclosed by the letter on every side: a counter, so leave it to the
        // wall placer to outline
        if (!px.some((i) => reachable[i])) continue
        // reject clamp-border corner pockets: a REAL valley touching the
        // border (M baseline mouth) has letter on BOTH sides along it; the
        // pocket outside a rounded corner has letter on one side only
        // Judge by PROPORTION, not a single-pixel veto. One border pixel
        // whose scan happens to miss the letter condemned the whole channel,
        // which is why every wedge in KEVIN was rejected and its two walls
        // both got stoned into a zigzag.
        let borderPx = 0
        let openPx = 0
        for (const i of px) {
          const x = i % w
          const y = (i / w) | 0
          let dirs: [number, number][] | null = null
          if (y <= gy0 + 1 || y >= gy1 - 1) dirs = [[1, 0], [-1, 0]]
          else if (x <= gx0 + 1 || x >= gx1 - 1) dirs = [[0, 1], [0, -1]]
          if (!dirs) continue
          borderPx++
          const reach = Math.ceil(2 * dtInv[i]) + 6
          let both = true
          for (const [dx2, dy2] of dirs) {
            let found = false
            for (let k = 1; k <= reach; k++) {
              const nx = x + dx2 * k
              const ny = y + dy2 * k
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) break
              if (labels[ny * w + nx]) { found = true; break }
            }
            if (!found) { both = false; break }
          }
          if (!both) openPx++
        }
        // ALL one-sided, not ANY. A real valley touching the border has letter
        // on both sides of it SOMEWHERE along its length; the pocket outside a
        // rounded corner never does. Rejecting on any single one-sided pixel
        // condemned every wedge in a K, V or N — both walls then got stoned
        // and their stones interleaved into a zigzag down the taper.
        if (borderPx && openPx === borderPx) continue
        chMask.fill(0)
        for (const i of px) chMask[i] = 1
        const skel = skeletonize(chMask, w, h)
        // gap profile measured along the CENTERLINE (skeleton) — wall-hugging
        // pixels always read near zero and would fake a taper. Uniformly thin
        // OR strongly tapered => line; constant medium width (parallel
        // counter like an E notch or G counter) => leave walls alone.
        const gaps: number[] = []
        for (let i = 0; i < w * h; i++) if (skel[i]) gaps.push((2 * dtInv[i]) / pxPerMm)
        if (gaps.length < 3) continue
        gaps.sort((g1, g2) => g1 - g2)
        const g50 = gaps[Math.floor(0.5 * (gaps.length - 1))]
        const g90 = gaps[Math.floor(0.9 * (gaps.length - 1))]
        const thin = g90 < pitch * 1.3
        const wedge = g50 < pitch * 1.1 && g90 >= pitch * 1.3
        if (!thin && !wedge) continue
        // a detail line must be LINE-shaped: much longer than wide. Square-ish
        // pockets (E notches) have X-shaped spur skeletons that fake both
        // thinness and taper — elongation is the unfakeable test.
        {
          const probe = traceSkeleton(skel, w, h)
            .map((p) => smoothPath(p).map(toMm))
            .sort((p1, p2) => p2.length - p1.length)[0]
          if (!probe) continue
          let arcLen = 0
          for (let k = 1; k < probe.length; k++)
            arcLen += Math.hypot(probe[k].x - probe[k - 1].x, probe[k].y - probe[k - 1].y)
          // CHORD, not arc: an X-shaped pocket skeleton traced through its
          // junctions has a long arc but a short end-to-end chord. A true
          // detail line is long end-to-end AND reasonably straight.
          const chord = Math.hypot(
            probe[probe.length - 1].x - probe[0].x,
            probe[probe.length - 1].y - probe[0].y,
          )
          // Measure a WEDGE against its median width, not its widest. g90 of a
          // taper is its mouth, so a V's or K's inner notch has to be absurdly
          // long to clear the bar — it gets rejected, both its walls get
          // stoned, and where they converge the stones interleave into a
          // zigzag instead of running down the middle.
          if (chord < Math.max(2.2 * (wedge ? g50 : g90), pitch * 1.1)) continue
          if (arcLen > 0 && chord / arcLen < 0.65) continue
        }
        // pixel skeletons of tapered slivers staircase — near-straight lines
        // snap to their chord so the stone row runs true
        const straighten = (p: Pt[]): Pt[] => {
          if (p.length < 3) return p
          const a = p[0]
          const b = p[p.length - 1]
          const L = Math.hypot(b.x - a.x, b.y - a.y)
          if (L < 1) return p
          let maxDev = 0
          for (const q of p) {
            const d = Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / L
            if (d > maxDev) maxDev = d
          }
          return maxDev < Math.max(1.3, L * 0.07) ? [a, b] : p
        }
        const paths = traceSkeleton(skel, w, h)
          .map((p) => straighten(smoothPath(p, 4).map(toMm)))
          .sort((a, b) => b.length - a.length)
        let placedAny = false
        for (const p of paths) {
          let len = 0
          for (let k = 1; k < p.length; k++) len += Math.hypot(p[k].x - p[k - 1].x, p[k].y - p[k - 1].y)
          if (len < pitch * 1.1) continue // concave-corner slivers aren't detail lines
          // one primary line per channel; skeleton branch stubs (Y-forks at
          // wedge mouths) only qualify if they're substantial lines themselves
          if (placedAny && len < pitch * 2.2) continue
          const got = placeOpenEven(p, pitch, idx, rhythm)
          dbg('line', got)
          out.push(...got)
          if (got.length) placedAny = true
        }
        if (placedAny) {
          anyAccepted = true
          for (const i of px) acceptedMask[i] = 1
        }
      }
      // walls are BANNED near detail lines — they end cleanly at the zone
      // edge instead of interleaving zigzag stones between line stones
      if (anyAccepted) {
        const inv2 = new Uint8Array(w * h)
        for (let i = 0; i < w * h; i++) inv2[i] = acceptedMask[i] ? 0 : 1
        const dtToLine = distanceTransform({ bin: inv2, w, h, pxPerMm, padPx })
        const rBan = Math.min(rhythm, pitch * 1.5) * 0.55 * pxPerMm
        bannedTest = (p: Pt): boolean => {
          const px2 = Math.round(p.x * pxPerMm + padPx)
          const py2 = Math.round(p.y * pxPerMm + padPx)
          if (px2 < 0 || py2 < 0 || px2 >= w || py2 >= h) return false
          return dtToLine[py2 * w + px2] < rBan
        }
      }
    }
  }

  // THIN PARTS GET A CENTRE LINE; the rest of the letter keeps its walls.
  //
  // Two wall rows need the stroke wide enough that a stone on one wall clears a
  // stone on the other: their centres sit (W - hole - 0.2) apart and that has
  // to reach the rhythm. Below it the walls collide and the stroke fills with
  // interleaved junk. Decided per PART, because a serif letter is thin and
  // thick at once.
  const spinedMask = new Uint8Array(w * h)
  {
    // Spine only where two rows CANNOT fit, not merely where they would be
    // tighter than the rhythm. A lowercase e's bar is about 8mm: its two wall
    // rows would sit 4.4mm apart, above the floor, so it should be outlined.
    // Judging it against the rhythm instead sent it to a centre line and put
    // stones down the middle of the bar while its own outline stayed bare --
    // which reads as extra interior holes in outline mode.
    const needW = holeMm + 0.2 + pitch
    const wide = new Float32Array(w * h)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i2 = y * w + x
        if (!labels[i2]) continue
        const dv = dt[i2]
        if (dv <= 0) continue
        if (
          !(dv >= dt[i2 - 1] && dv >= dt[i2 + 1] && dv >= dt[i2 - w] && dv >= dt[i2 + w] &&
            dv >= dt[i2 - w - 1] && dv >= dt[i2 - w + 1] &&
            dv >= dt[i2 + w - 1] && dv >= dt[i2 + w + 1])
        )
          continue
        const rr = dv * dv
        const val = (2 * dv) / pxPerMm
        const r0 = Math.ceil(dv)
        for (let yy = Math.max(0, y - r0); yy <= Math.min(h - 1, y + r0); yy++) {
          const dy2 = yy - y
          const sp2 = Math.floor(Math.sqrt(Math.max(0, rr - dy2 * dy2)))
          const row = yy * w
          for (let xx = Math.max(0, x - sp2); xx <= Math.min(w - 1, x + sp2); xx++)
            if (labels[row + xx] && wide[row + xx] < val) wide[row + xx] = val
        }
      }
    const thin = new Uint8Array(w * h)
    for (let i2 = 0; i2 < w * h; i2++)
      thin[i2] = labels[i2] && wide[i2] > 0 && wide[i2] < needW ? 1 : 0
    const tp = labelComponents(thin, w, h)
    if (tp.count) {
      const area = new Int32Array(tp.count + 1)
      for (let i2 = 0; i2 < w * h; i2++) if (tp.labels[i2]) area[tp.labels[i2]]++
      const minArea = (rhythm * pxPerMm) ** 2 * 0.5
      const part = new Uint8Array(w * h)
      for (let r2 = 1; r2 <= tp.count; r2++) {
        if (area[r2] < minArea) continue
        for (let i2 = 0; i2 < w * h; i2++) part[i2] = tp.labels[i2] === r2 ? 1 : 0
        const skel = skeletonize(part, w, h)
        const paths = traceSkeleton(skel, w, h)
          .map((p) => smoothPath(p, 3).map(toMm))
          .sort((a, b) => b.length - a.length)
        let placedAny = false
        for (const pth of paths) {
          let len = 0
          for (let k = 1; k < pth.length; k++)
            len += Math.hypot(pth[k].x - pth[k - 1].x, pth[k].y - pth[k - 1].y)
          // a spine is a LINE; skeleton spurs at junctions are not
          if (len < rhythm * 1.6) continue
          // A skeleton runs out to the boundary at a stroke's end, so its last
          // stones land ON the edge — measured at 0.05mm from the contour,
          // half the stone hanging off the letter. Every stone has to sit at
          // least its own radius inside, the same rule as everywhere else.
          const deep = (q: Pt) => {
            const xi = Math.round(q.x * pxPerMm + padPx)
            const yi = Math.round(q.y * pxPerMm + padPx)
            if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false
            return dt[yi * w + xi] / pxPerMm >= holeMm / 2 + 0.1
          }
          const got = placeOpenEven(pth, pitch, idx, rhythm).filter((q) => {
            if (deep(q)) return true
            idx.remove(q)
            return false
          })
          if (got.length) {
            dbg('partspine', got)
            out.push(...got)
            placedAny = true
          }
        }
        if (placedAny) for (let i2 = 0; i2 < w * h; i2++) if (part[i2]) spinedMask[i2] = 1
      }
    }
  }
  {
    const prev = bannedTest
    const inSpined = (p: Pt): boolean => {
      const px2 = Math.round(p.x * pxPerMm + padPx)
      const py2 = Math.round(p.y * pxPerMm + padPx)
      if (px2 < 0 || py2 < 0 || px2 >= w || py2 >= h) return false
      return spinedMask[py2 * w + px2] === 1
    }
    bannedTest = prev ? (p: Pt) => prev(p) || inSpined(p) : inSpined
  }

  // interior test for the dip-inward fallback: hole must stay in material
  const insideTest = (p: Pt): boolean => {
    const px = Math.round(p.x * pxPerMm + padPx)
    const py = Math.round(p.y * pxPerMm + padPx)
    if (px < 0 || py < 0 || px >= w || py >= h) return false
    return dt[py * w + px] / pxPerMm >= holeMm / 2 + 0.1
  }
  wallContours.sort((a, b) => b.length - a.length)
  // corners FIRST across the entire design, then edges — corner anchors
  // never lose their spot to an edge stone from a neighboring contour
  const contourInfos = wallContours.map((c) =>
    analyzeContour(simplifyContour(c, holeMm / 6), pitch, rhythm),
  )
  // MERGE THE SHAPES before stoning. Glyphs are drawn as overlapping
  // contours, so a contour can run straight through the interior of the
  // merged silhouette (an E's middle-arm bar crossing the stem). Stones
  // belong on the silhouette only — 44 of 407 were landing on interior
  // edges. A true boundary point has distance-to-edge ~0; interior segments
  // sit deep inside, so the distance field separates them cleanly.
  const interiorTest = (p: Pt): boolean => {
    const px = Math.round(p.x * pxPerMm + padPx)
    const py = Math.round(p.y * pxPerMm + padPx)
    if (px < 0 || py < 0 || px >= w || py >= h) return false
    return dt[py * w + px] / pxPerMm > 0.7
  }
  const gate: (p: Pt) => boolean = bannedTest
    ? (p) => bannedTest(p) || interiorTest(p)
    : interiorTest
  for (const info of contourInfos) placeContourCorners(info, pitch, idx, out, gate, rhythm)
  for (const info of contourInfos) placeContourEdges(info, pitch, idx, out, insideTest, gate, rhythm, uniformRhythm)
  for (const info of contourInfos) placeContourTipSpines(info, pitch, idx, out, gate, rhythm)

  if (narrowLbls.size) {
    const compMask = new Uint8Array(w * h)
    for (const lbl of narrowLbls) {
      for (let i = 0; i < w * h; i++) compMask[i] = labels[i] === lbl ? 1 : 0
      const skel = skeletonize(compMask, w, h)
      const paths = traceSkeleton(skel, w, h)
        .map((p) => smoothPath(p).map(toMm))
        .sort((a, b) => b.length - a.length)
      for (const p of paths) {
        const got = placeOpenEven(p, pitch, idx, rhythm)
        dbg('narrowspine', got)
        out.push(...got)
      }
    }
  }

  // FILL BARE CONTOUR. Stretches of outline can end up with no stone on them
  // at all: a notch too narrow for a stone inset from each wall falls between
  // the wall placer (which needs room for two) and the detail-line machinery
  // (which never sees it, because the channel it belongs to opens outward and
  // reads as exterior). The outline then visibly stops and restarts — an E's
  // middle-arm notch, a K's arm junctions.
  //
  // This only ADDS, and only where a legal position exists: inset from the
  // edge, inside the shape, and clear of every stone already placed. It cannot
  // move or remove anything.
  {
    const step = 1
    const inset = holeMm / 2 + 0.1
    const covered = rhythm * 0.95
    const added: Pt[] = []
    for (const ct of contours) {
      // walk the contour, collecting runs with nothing near them
      const samples: { p: Pt; nx: number; ny: number }[] = []
      for (let k = 0; k < ct.length; k++) {
        const a = ct[k]
        const b = ct[(k + 1) % ct.length]
        const L = Math.hypot(b.x - a.x, b.y - a.y)
        if (L < 1e-9) continue
        const nx = -(b.y - a.y) / L
        const ny = (b.x - a.x) / L
        for (let t = 0; t < L; t += step)
          samples.push({ p: { x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L }, nx, ny })
      }
      let run: typeof samples = []
      const flush = () => {
        // Only patch a run that is roughly STRAIGHT. A bare stretch that wraps
        // around a notch -- the step where an E's middle arm meets its stem --
        // is not a missing piece of edge, and filling it walks stones around
        // the notch and off the stem's line. Measured on an E: the inner edge
        // sits at x=9.43 while three patches landed at 6.24, 7.63 and 5.47.
        if (run.length >= 3) {
          const a = run[0].p
          const b = run[run.length - 1].p
          const chord = Math.hypot(b.x - a.x, b.y - a.y)
          let arc = 0
          for (let i = 1; i < run.length; i++)
            arc += Math.hypot(run[i].p.x - run[i - 1].p.x, run[i].p.y - run[i - 1].p.y)
          if (arc > 0 && chord / arc < 0.93) {
            run = []
            return
          }
        }
        // and only a SUBSTANTIAL missing stretch. A short bare run near a
        // junction is not a hole in an edge, it is the edge ending; filling it
        // drops a stray beside the line rather than on it.
        if (run.length >= Math.round(rhythm * 1.6)) {
          const n = Math.max(1, Math.round((run.length * step) / rhythm) - 1)
          for (let i = 1; i <= n; i++) {
            const s = run[Math.round((i * run.length) / (n + 1))]
            if (!s) continue
            for (const sgn of [1, -1]) {
              const q = { x: s.p.x + s.nx * inset * sgn, y: s.p.y + s.ny * inset * sgn }
              if (!insideTest(q)) continue
              if (!idx.canPlace(q)) continue
              if (added.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < pitch - 1e-6)) continue
              idx.add(q)
              added.push(q)
              break
            }
          }
        }
        run = []
      }
      for (const s of samples) {
        let m = Infinity
        for (const o of out) {
          const dd = Math.hypot(s.p.x - o.x, s.p.y - o.y)
          if (dd < m) m = dd
        }
        if (m > covered) run.push(s)
        else flush()
      }
      flush()
    }
    if (added.length) {
      dbg('patch', added)
      out.push(...added)
    }
  }

  // NOTHING DELETES STONES AFTER PLACEMENT.
  //
  // There used to be a pass here that dropped "crowded" pairs and then healed
  // the gaps it made. Three definitions of crowded were tried and every one
  // deleted correctly-placed stones: against the design median it removed 19%
  // of a word, against a stone's second-nearest neighbour it punched a hole in
  // an E's middle arm, and against the spacing floor it emptied every arm's
  // end cap and left the ends reading open. Each fix exposed the next.
  //
  // Crowding is prevented where it happens instead: divideSpan re-divides a
  // span when a stone would land too near a foreign one, so a junction ends up
  // with fewer, evenly spaced stones rather than a jammed pair to clean up.

  return out
}


// ---------------------------------------------------------------------------
// Offset outline rows — the classic rhinestone design styles:
//   echo  = a second concentric row INSET inside the edge row ("double outline")
//   ghost = a row floated OUTSIDE the letter edge (fabric shows through)
// Both run through the full corner-aware, rhythm-harmonized pipeline.
// ---------------------------------------------------------------------------

// A rasterised medial axis staircases, and it bends toward every branch at a
// junction — so a straight stem's centre row comes out wandering. Snap a
// near-linear path to its chord so straight reads straight.
export function straightenPath(p: Pt[]): Pt[] {
  if (p.length < 3) return p
  const a = p[0]
  const b = p[p.length - 1]
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  if (L < 1) return p
  let maxDev = 0
  for (const q of p) {
    const d = Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / L
    if (d > maxDev) maxDev = d
  }
  return maxDev < Math.max(1.3, L * 0.07) ? [a, b] : p
}



// One pass for EVERY region at once. A per-region scan called in a loop
// re-walks the whole grid N times — on a six-letter design that was ~6.6M
// iterations of 8-neighbour tests, and the UI froze. Ridge pixels (local
// maxima of the distance field) lie on the medial axis, so this gives each
// region's typical stroke half-width without iterative thinning.
function ridgeWidthsByLabel(
  labels: Int32Array,
  count: number,
  dt: Float32Array,
  w: number,
  h: number,
): Float32Array {
  const buckets: number[][] = Array.from({ length: count + 1 }, () => [])
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = labels[i]
      if (!l) continue
      const d = dt[i]
      if (d <= 0) continue
      if (
        d >= dt[i - 1] && d >= dt[i + 1] && d >= dt[i - w] && d >= dt[i + w] &&
        d >= dt[i - w - 1] && d >= dt[i - w + 1] && d >= dt[i + w - 1] && d >= dt[i + w + 1]
      )
        buckets[l].push(d)
    }
  }
  const out = new Float32Array(count + 1)
  for (let l = 1; l <= count; l++) {
    const b = buckets[l]
    if (!b.length) continue
    b.sort((p, q) => p - q)
    out[l] = b[Math.floor(b.length / 2)]
  }
  return out
}

export function offsetRows(
  grid: Grid,
  holeMm: number,
  gapMm: number,
  idx: SpacingIndex,
  rhythmMm: number,
  offsetMm: number,
  outside: boolean,
  uniform = false,
): Pt[] {
  const { bin, w, h, pxPerMm, padPx } = grid
  const pitch = holeMm + gapMm
  const toMm = (p: Pt): Pt => ({ x: (p.x - padPx) / pxPerMm, y: (p.y - padPx) / pxPerMm })
  let dt: Float32Array
  if (outside) {
    const inv = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) inv[i] = bin[i] ? 0 : 1
    dt = distanceTransform({ bin: inv, w, h, pxPerMm, padPx })
  } else {
    dt = distanceTransform(grid)
  }
  const offPx = offsetMm * pxPerMm
  const mask = new Uint8Array(w * h)
  if (outside) {
    for (let i = 0; i < w * h; i++) mask[i] = !bin[i] && dt[i] >= offPx ? 1 : 0
  } else {
    for (let i = 0; i < w * h; i++) mask[i] = bin[i] && dt[i] >= offPx ? 1 : 0
  }

  const out: Pt[] = []
  // Per region: a full echo RING needs its own two sides to clear the
  // minimum. Where the stroke is only wide enough for one inner row, the
  // ring collapses to the medial axis — a CENTRED row, equidistant from both
  // walls. Walking the degenerate ring instead produced a lopsided line
  // (measured 6.60mm from one wall, 5.31mm from the other).
  const comp = labelComponents(mask, w, h)
  const cMax = new Float32Array(comp.count + 1)
  for (let i = 0; i < w * h; i++)
    if (comp.labels[i] && dt[i] > cMax[comp.labels[i]]) cMax[comp.labels[i]] = dt[i]
  const ringMask = new Uint8Array(w * h)
  const ridgeW = ridgeWidthsByLabel(comp.labels, comp.count, dt, w, h)
  let anyRing = false
  for (let l = 1; l <= comp.count; l++) {
    // TYPICAL width, not the fattest point: judging by the max lets one
    // junction declare a region ring-capable, and the ring then forms with
    // its two sides below the minimum, surviving only by zig-zagging.
    const typical = ridgeW[l] || cMax[l]
    const ringCapable = outside || 2 * (typical / pxPerMm - offsetMm) >= pitch * 0.9
    // A region that can't hold a ring gets NOTHING. Substituting a single
    // centred row seemed reasonable but the medial axis fragments at every
    // junction: the row came out wandering ~2.2mm and dropped a 24mm gap
    // mid-stem. Feasibility refuses the design instead, and says what size
    // would work.
    if (!ringCapable) continue
    for (let i = 0; i < w * h; i++) if (comp.labels[i] === l) ringMask[i] = 1
    anyRing = true
  }
  const rings = anyRing
    ? marchingSquares(ringMask, w, h)
        .filter((c) => !c.some((p) => p.x < 2 || p.y < 2 || p.x > w - 3 || p.y > h - 3))
        .map((c) => c.map(toMm))
        .sort((a, b) => b.length - a.length)
    : []
  for (const ring of rings) {
    const info = analyzeContour(ring, pitch, rhythmMm)
    placeContourCorners(info, pitch, idx, out, undefined, rhythmMm)
    placeContourEdges(info, pitch, idx, out, undefined, undefined, rhythmMm, uniform)
    placeContourTipSpines(info, pitch, idx, out, undefined, rhythmMm)
  }
  return out
}


// Can this design geometrically support a clean double-outline echo?
// Returns feasibility plus the scale factor that WOULD make it work — the
// standard design-software pattern: name the fix, don't just refuse.
export function echoRequirement(
  grid: Grid,
  pitch: number,
  offsetMm: number,
): { feasible: boolean; scale: number } {
  const { bin, w, h, pxPerMm } = grid
  const dt = distanceTransform(grid)
  const shape = labelComponents(bin, w, h)
  const areas = new Float32Array(shape.count + 1)
  const sMax = new Float32Array(shape.count + 1)
  for (let i = 0; i < w * h; i++) {
    const l = shape.labels[i]
    if (!l) continue
    areas[l]++
    if (dt[i] > sMax[l]) sMax[l] = dt[i]
  }
  const minArea = (pitch * pxPerMm) ** 2
  const widths: number[] = []
  for (let l = 1; l <= shape.count; l++) if (areas[l] >= minArea) widths.push(sMax[l] / pxPerMm)
  if (!widths.length) return { feasible: false, scale: 2 }
  widths.sort((a, b) => a - b)
  // Stone sizes don't scale with the design, so scaling by s scales every
  // stroke half-width by s. Size from the 15th-percentile stroke, not the
  // median, so MOST strokes clear the bar (matching the 0.85 majority rule) —
  // sizing off the median leaves the thin strokes still failing.
  const w15 = widths[Math.floor(0.15 * (widths.length - 1))]
  const required = offsetMm + pitch * 0.45 // from 2*(maxD - offset) >= 0.9*pitch
  return {
    feasible: echoFeasible(grid, pitch, offsetMm),
    scale: Math.max(1, (required / w15) * 1.05),
  }
}

export function echoFeasible(grid: Grid, pitch: number, offsetMm: number): boolean {
  const { bin, w, h, pxPerMm } = grid
  const dt = distanceTransform(grid)
  const offPx = offsetMm * pxPerMm
  const mask = new Uint8Array(w * h)
  let raw = 0
  for (let i = 0; i < w * h; i++) {
    mask[i] = bin[i] && dt[i] >= offPx ? 1 : 0
    if (mask[i]) raw++
  }
  if (!raw) return false
  const comp = labelComponents(mask, w, h)
  let kept = 0
  const ridgeW = ridgeWidthsByLabel(comp.labels, comp.count, dt, w, h)
  for (let l = 1; l <= comp.count; l++) {
    const typical = ridgeW[l]
    if (typical <= 0) continue
    if (2 * (typical / pxPerMm - offsetMm) >= pitch * 0.9)
      for (let i = 0; i < w * h; i++) if (comp.labels[i] === l) kept++
  }
  // near-total: a double outline that only forms on part of the design is
  // fragments, which read as mistakes
  return kept >= raw * 0.9
}

// ---------------------------------------------------------------------------
// Component labeling, skeletonization, skeleton tracing
// ---------------------------------------------------------------------------

function labelComponents(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h)
  let count = 0
  const stack: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue
    count++
    labels[i] = count
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()!
      const x = j % w
      const y = (j / w) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const k = ny * w + nx
        if (mask[k] && !labels[k]) {
          labels[k] = count
          stack.push(k)
        }
      }
    }
  }
  return { labels, count }
}

// Zhang-Suen thinning to a 1px skeleton.
function skeletonize(mask: Uint8Array, w: number, h: number): Uint8Array {
  // Thinning is iterative, so running it over the FULL grid for every small
  // region is what made the UI freeze: a six-letter design re-walked ~1M
  // pixels per region, per pass. Crop to the region's bounding box, thin
  // there, and write back.
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (x < bx0) bx0 = x
        if (y < by0) by0 = y
        if (x > bx1) bx1 = x
        if (y > by1) by1 = y
      }
  if (bx1 < 0) return new Uint8Array(w * h)
  bx0 = Math.max(0, bx0 - 1); by0 = Math.max(0, by0 - 1)
  bx1 = Math.min(w - 1, bx1 + 1); by1 = Math.min(h - 1, by1 + 1)
  const cw = bx1 - bx0 + 1
  const ch = by1 - by0 + 1
  if (cw < w || ch < h) {
    const sub = new Uint8Array(cw * ch)
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) sub[y * cw + x] = mask[(y + by0) * w + (x + bx0)]
    const thinned = skeletonizeFull(sub, cw, ch)
    const out = new Uint8Array(w * h)
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) out[(y + by0) * w + (x + bx0)] = thinned[y * cw + x]
    return out
  }
  return skeletonizeFull(mask, w, h)
}

function skeletonizeFull(mask: Uint8Array, w: number, h: number): Uint8Array {
  const img = Uint8Array.from(mask)
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? img[y * w + x] : 0)
  let changed = true
  const toClear: number[] = []
  while (changed) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      toClear.length = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y)
          const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1)
          const p8 = at(x - 1, y), p9 = at(x - 1, y - 1)
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (B < 2 || B > 6) continue
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let A = 0
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++
          if (A !== 1) continue
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
          }
          toClear.push(y * w + x)
        }
      }
      if (toClear.length) {
        changed = true
        for (const i of toClear) img[i] = 0
      }
    }
  }
  return img
}

// Trace a 1px skeleton into polylines (px coords). Endpoints first, then cycles.
function traceSkeleton(skel: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? skel[y * w + x] : 0)
  const deg = (x: number, y: number) => {
    let n = 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        n += at(x + dx, y + dy)
      }
    return n
  }
  const visited = new Uint8Array(w * h)
  const paths: Pt[][] = []
  const walk = (sx: number, sy: number) => {
    const path: Pt[] = []
    let x = sx
    let y = sy
    for (;;) {
      visited[y * w + x] = 1
      path.push({ x, y })
      let nx = -1
      let ny = -1
      for (let dy = -1; dy <= 1 && nx < 0; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const cx = x + dx
          const cy = y + dy
          if (at(cx, cy) && !visited[cy * w + cx]) {
            nx = cx
            ny = cy
            break
          }
        }
      if (nx < 0) break
      x = nx
      y = ny
    }
    if (path.length >= 2) paths.push(path)
  }
  // endpoints first so open strokes trace end-to-end
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (skel[y * w + x] && !visited[y * w + x] && deg(x, y) === 1) walk(x, y)
  // remaining loops / junction leftovers
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (skel[y * w + x] && !visited[y * w + x]) walk(x, y)
  return paths
}

// Light smoothing to take the pixel staircase out of skeleton polylines.
function smoothPath(poly: Pt[], passes = 2): Pt[] {
  let pts = poly
  for (let p = 0; p < passes; p++) {
    const out: Pt[] = [pts[0]]
    for (let i = 1; i < pts.length - 1; i++) {
      out.push({
        x: (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4,
        y: (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4,
      })
    }
    out.push(pts[pts.length - 1])
    pts = out
  }
  return pts
}


// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------


export function fillStones(
  grid: Grid,
  holeMm: number,
  gapMm: number,
  startInsetMm: number,
  idx: SpacingIndex,
  fixedPts: Pt[] = [], // outline stones (already in idx)
  rhythmMm?: number,
  brick = false, // alternate rows half-offset (brick) vs corner-anchored (grid)
): Pt[] {
  const { w, h, pxPerMm, padPx } = grid
  const dt = distanceTransform(grid)
  const pitch = holeMm + gapMm
  const rhythm = rhythmMm ?? pitch * 1.15
  const minPx = startInsetMm * pxPerMm

  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = dt[i] >= minPx ? 1 : 0

  // Subtract the outline stones' clearance from the fillable area.
  //
  // Without this the mask only knows the glyph edge, so a row running just
  // inside the outline is "fillable" everywhere while individual stones on it
  // still fail the outline clearance — and which ones fail depends on how each
  // lattice column happens to line up with the outline stones beneath it. The
  // row survives in scattered pieces: three stones, a double gap, two more.
  //
  // Clear along the outline PATH, not one disk per stone. Disks alone leave a
  // scalloped boundary that bulges inward between stones, and the lattice
  // samples that ripple as a column flickering in and out row by row. Filling
  // in each stone's gap to its nearest neighbours makes the boundary a smooth
  // offset, so a row is either there across a run or not there at all.
  if (fixedPts.length) {
    const clear = idx.minDist * pxPerMm
    const cr = Math.ceil(clear)
    const crr = clear * clear
    const stamp = (xMm: number, yMm: number) => {
      const cx = Math.round(xMm * pxPerMm + padPx)
      const cy = Math.round(yMm * pxPerMm + padPx)
      for (let yy = Math.max(0, cy - cr); yy <= Math.min(h - 1, cy + cr); yy++) {
        const dy = yy - cy
        const span = Math.floor(Math.sqrt(Math.max(0, crr - dy * dy)))
        const row = yy * w
        for (let xx = Math.max(0, cx - span); xx <= Math.min(w - 1, cx + span); xx++)
          mask[row + xx] = 0
      }
    }
    for (const a of fixedPts) {
      stamp(a.x, a.y)
      // the two nearest outline stones are its neighbours along the path
      const near = fixedPts
        .filter((b) => b !== a)
        .map((b) => ({ b, d: Math.hypot(b.x - a.x, b.y - a.y) }))
        .sort((p, q) => p.d - q.d)
        .slice(0, 2)
      for (const { b } of near)
        for (const t of [0.25, 0.5]) stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    }
  }

  const { labels, count } = labelComponents(mask, w, h)
  const maxD = new Float32Array(count + 1)
  for (let i = 0; i < w * h; i++) if (labels[i] && dt[i] > maxD[labels[i]]) maxD[labels[i]] = dt[i]

  // ONE LATTICE FOR THE WHOLE SHAPE.
  //
  // Deriving each row from the edge it sits beside makes every region pick its
  // own phase: an H's two stems stop sharing columns, an E's arms stop lining
  // up with its stem, an O's fill spirals with the curve. The result reads as
  // speckle even when every individual row is evenly spaced.
  //
  // Fill instead is a single lattice laid across the whole shape. A stone goes
  // wherever a lattice point falls far enough inside the outline. Columns are
  // then dead straight everywhere by construction, junctions need no
  // negotiation, and a letter's lighter limbs inherit the same lines as its
  // stems.
  const out: Pt[] = []

  const toMmX = (px: number) => (px - padPx) / pxPerMm
  const toMmY = (py: number) => (py - padPx) / pxPerMm
  const fillable = (xi: number, yi: number) => {
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false
    return mask[yi * w + xi] === 1
  }

  // Decide each stone ANALYTICALLY, not by looking up one pixel.
  //
  // A rounded pixel lookup resolves to 1/6 mm here, and the two sides of a
  // symmetric letter are not bit-identical — Anton's H mirrors to 0.085mm,
  // which is half a pixel. That is enough to flip the lookup on one stem and
  // not the other, and a stone appears in one stem with no partner opposite.
  // Interpolating the distance field and measuring the real distance to the
  // outline decides both sides the same way.
  const dtAt = (xMm: number, yMm: number) => {
    const fx = xMm * pxPerMm + padPx
    const fy = yMm * pxPerMm + padPx
    const x0i = Math.floor(fx)
    const y0i = Math.floor(fy)
    if (x0i < 0 || y0i < 0 || x0i + 1 >= w || y0i + 1 >= h) return -1
    const tx = fx - x0i
    const ty = fy - y0i
    const a = dt[y0i * w + x0i]
    const b = dt[y0i * w + x0i + 1]
    const c2 = dt[(y0i + 1) * w + x0i]
    const d = dt[(y0i + 1) * w + x0i + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c2 * (1 - tx) + d * tx) * ty
  }
  // the outline as a path: each stone joined to its two nearest neighbours, so
  // clearance is measured to the LINE, not to each bead. Measuring to the
  // beads alone leaves a boundary that scallops inward between them, and the
  // lattice samples that ripple as a column flickering in and out row by row.
  const segs: [Pt, Pt][] = []
  for (const a of fixedPts) {
    const near = fixedPts
      .filter((b) => b !== a)
      .map((b) => ({ b, d: Math.hypot(b.x - a.x, b.y - a.y) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
    for (const { b } of near) if (a.x < b.x || (a.x === b.x && a.y < b.y)) segs.push([a, b])
  }
  const clearOfOutline = (p: Pt) => {
    const need = idx.minDist - 1e-6
    for (const s of fixedPts)
      if (Math.hypot(p.x - s.x, p.y - s.y) < need) return false
    for (const [a, b] of segs) {
      const vx = b.x - a.x
      const vy = b.y - a.y
      const len2 = vx * vx + vy * vy
      if (len2 < 1e-12) continue
      let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      if (Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)) < need) return false
    }
    return true
  }

  // bounds of everything a stone could occupy
  let minX = w
  let maxX = -1
  let minY = h
  let maxY = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (fillable(x, y)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
  if (maxX < 0) return []

  const stepX = rhythm
  // brick rows sit closer together so a stone keeps the same distance to the
  // two it nests between as to the two beside it
  const stepY = brick ? (rhythm * Math.sqrt(3)) / 2 : rhythm

  // Centre the lattice on the shape so the margins match on both sides —
  // anchoring it at a corner leaves a fat gap on one edge and a shaved row on
  // the other. Centring is also what keeps identical letters identical: the
  // anchor comes from the glyph's own extent, never from where it sits in the
  // word.
  const spanX = toMmX(maxX) - toMmX(minX)
  const spanY = toMmY(maxY) - toMmY(minY)
  const nCols = Math.max(1, Math.floor(spanX / stepX) + 1)
  const nRows = Math.max(1, Math.floor(spanY / stepY) + 1)
  const baseX = toMmX(minX) + (spanX - (nCols - 1) * stepX) / 2
  const baseY = toMmY(minY) + (spanY - (nRows - 1) * stepY) / 2

  // Walk the lattice at a given offset. `exact` decides each stone the slow,
  // accurate way; the cheap pixel test is only ever used to SCORE offsets
  // against each other, never to place a stone.
  const walk = (dx: number, dy: number, exact: boolean): Pt[] => {
    const got: Pt[] = []
    for (let r = -1; r <= nRows; r++) {
      const yMm = baseY + dy + r * stepY
      // a brick row is offset half a step; both need a spare candidate at each
      // end so the offset cannot shorten the row
      const shift = brick && ((r % 2) + 2) % 2 === 1 ? stepX / 2 : 0
      for (let c = -1; c <= nCols; c++) {
        const xMm = baseX + dx + c * stepX + shift
        if (!exact) {
          if (!fillable(Math.round(xMm * pxPerMm + padPx), Math.round(yMm * pxPerMm + padPx)))
            continue
          got.push({ x: xMm, y: yMm })
          continue
        }
        const p = { x: xMm, y: yMm }
        if (dtAt(xMm, yMm) < minPx) continue
        if (!clearOfOutline(p)) continue
        if (!idx.canPlace(p)) continue
        got.push(p)
      }
    }
    return got
  }

  // Centring gives even margins but pins the lattice's phase, and a pocket
  // that could hold a row or column can miss it by less than a step — a B's
  // outer bowl comes out a column short, an R's leg gets one column where it
  // has room for two. Slide the lattice, as one rigid piece, to whichever
  // offset seats the most stones. Every row and column stays aligned; only
  // where the pattern sits changes.
  //
  // Scored on the pixel mask, which is ~200x cheaper than the exact test:
  // scoring 36 offsets exactly locks the UI for seconds on a long word.
  const STEPS = 6
  const scored: { dx: number; dy: number; n: number }[] = []
  for (let iy = 0; iy < STEPS; iy++)
    for (let ix = 0; ix < STEPS; ix++) {
      const dx = (ix / STEPS) * stepX
      const dy = (iy / STEPS) * stepY
      scored.push({ dx, dy, n: walk(dx, dy, false).length })
    }
  // The cheap score can rank an offset the exact test then dislikes, so
  // re-check the leading few exactly and keep the real winner.
  scored.sort((a, b) => b.n - a.n)
  let best: Pt[] = []
  for (const s of scored.slice(0, 4)) {
    const got = walk(s.dx, s.dy, true)
    if (got.length > best.length) best = got
  }
  for (const p of best) {
    idx.add(p)
    out.push(p)
  }

  // Law fill: everything placed deterministically above — no relaxation,
  // no gap-insertion. What the laws place is what ships.
  //
  // Except lonely stones: a fill stone with no fill neighbour nearby isn't
  // part of a pattern, it reads as a mistake. That happens when the strokes
  // are too light for a fill and only tiny pockets survive the edge inset.
  const near = rhythm * 1.6
  const keep = out.filter((p) =>
    out.some((q) => q !== p && Math.hypot(p.x - q.x, p.y - q.y) <= near),
  )
  return keep
}


// ---------------------------------------------------------------------------
// Per-glyph fill — determinism fix.
//
// The outline works from exact vector contours, but the fill works from a
// raster. Rasterizing a whole word at once lands each glyph on a different
// sub-pixel phase of the grid, so identical letters get slightly different
// distance fields and therefore different fill decisions.
//
// Filling each glyph in its OWN local frame (bbox translated to the origin)
// normalizes that phase: identical glyphs rasterize identically and fill
// identically. Results are translated back and validated against the global
// index so cross-glyph spacing still holds.
// ---------------------------------------------------------------------------
export function fillByGlyph(
  contours: Pt[][],
  holeMm: number,
  gapMm: number,
  startInsetMm: number,
  idx: SpacingIndex,
  fixedPts: Pt[],
  rhythmMm: number,
  brick = false,
): Pt[] {
  interface Group {
    minX: number
    minY: number
    maxX: number
    maxY: number
    cs: Pt[][]
  }
  const groups: Group[] = []
  for (const c of contours) {
    if (c.length < 3) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of c) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    // attach to any group whose bbox overlaps (a counter sits inside its glyph)
    const hit = groups.find((g) => !(maxX < g.minX || minX > g.maxX || maxY < g.minY || minY > g.maxY))
    if (hit) {
      hit.minX = Math.min(hit.minX, minX)
      hit.minY = Math.min(hit.minY, minY)
      hit.maxX = Math.max(hit.maxX, maxX)
      hit.maxY = Math.max(hit.maxY, maxY)
      hit.cs.push(c)
    } else groups.push({ minX, minY, maxX, maxY, cs: [c] })
  }

  // The outline stones are bigger than the fill stones; recover their radius
  // from the mixed-size minimum the caller built the index with.
  const outlineR = Math.max(idx.defaultR, idx.minDist - idx.gap - idx.defaultR)

  const out: Pt[] = []
  for (const g of groups) {
    const ox = g.minX
    const oy = g.minY
    const local = g.cs.map((c) => c.map((p) => ({ x: p.x - ox, y: p.y - oy })))
    const grid = rasterizeContours(local)
    // outline stones near this glyph, in the glyph's local frame
    const pad = rhythmMm * 3
    const localFixed = fixedPts
      .filter((p) => p.x >= g.minX - pad && p.x <= g.maxX + pad && p.y >= g.minY - pad && p.y <= g.maxY + pad)
      .map((p) => ({ x: p.x - ox, y: p.y - oy }))
    // Mirror the caller's per-radius mode. Built with one argument the local
    // index falls back to a single uniform minimum — the FILL-to-OUTLINE
    // distance — and then demands it between two small fill stones as well.
    // That rejects every second lattice point and leaves the fill
    // checkerboarded, with obvious unfilled space inside every stroke.
    const localIdx = new SpacingIndex(idx.minDist, idx.gap, idx.defaultR)
    for (const p of localFixed) localIdx.add(p, outlineR)
    const placed = fillStones(grid, holeMm, gapMm, startInsetMm, localIdx, localFixed, rhythmMm, brick)
    for (const p of placed) {
      const q = { x: p.x + ox, y: p.y + oy }
      // cross-glyph legality still enforced against the global index
      if (idx.canPlace(q)) {
        idx.add(q)
        out.push(q)
      }
    }
  }
  return out
}
