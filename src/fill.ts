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
  private map = new Map<string, Pt[]>()
  minDist: number
  constructor(minDist: number) {
    this.minDist = minDist
    this.cell = Math.max(minDist, 1)
  }
  private key(cx: number, cy: number) {
    return `${cx},${cy}`
  }
  canPlace(p: Pt): boolean {
    const cx = Math.floor(p.x / this.cell)
    const cy = Math.floor(p.y / this.cell)
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const b = this.map.get(this.key(gx, gy))
        if (!b) continue
        for (const o of b) if (Math.hypot(p.x - o.x, p.y - o.y) < this.minDist) return false
      }
    return true
  }
  add(p: Pt) {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell))
    const b = this.map.get(k)
    if (b) b.push(p)
    else this.map.set(k, [p])
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
  const path = new Path2D()
  for (const c of contours) {
    if (c.length < 3) continue
    path.moveTo(c[0].x * pxPerMm + pad, c[0].y * pxPerMm + pad)
    for (let i = 1; i < c.length; i++) path.lineTo(c[i].x * pxPerMm + pad, c[i].y * pxPerMm + pad)
    path.closePath()
  }
  ctx.fillStyle = '#000'
  ctx.fill(path, 'evenodd')
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
    // tiny path: try a single stone, midpoint first
    for (const s of [path.total / 2, 0, path.total]) {
      const p = pointAt(path, s)
      if (idx.canPlace(p)) {
        idx.add(p)
        return [p]
      }
    }
    return []
  }
  const ds = target / 12
  let best: Pt[] = []
  for (let ph = 0; ph < phases; ph++) {
    const offset = (ph / phases) * target
    const placed: Pt[] = []
    let arcSince = target // allow immediate first placement
    const end = closed ? offset + path.total : path.total
    for (let s = offset; s < end; s += ds) {
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
  const target = rhythm ?? pitch * 1.15
  if (info.fallback || !info.path) return
  for (const cn of info.corners) {
    if (banned?.(cn.apex)) continue
    if (!idx.canPlace(cn.apex)) continue
    idx.add(cn.apex)
    out.push(cn.apex)
    dbg('corner', [cn.apex])
  }
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
    out.push(...walkPoly(info.poly, true, pitch, idx))
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
      } else {
        const u = uAnch ? aArc + minSp : iv.u
        const v = vAnch ? rawEnd - minSp : iv.v
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
  const { labels, count } = labelComponents(bin, w, h)
  const maxD = new Float32Array(count + 1)
  for (let i = 0; i < w * h; i++) if (labels[i] && dt[i] > maxD[labels[i]]) maxD[labels[i]] = dt[i]
  const toMm = (p: Pt): Pt => ({ x: (p.x - padPx) / pxPerMm, y: (p.y - padPx) / pxPerMm })

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

  // An outline follows the font lines. The centerline fallback fires ONLY
  // when a stroke is physically too narrow for rows on both walls to coexist
  // (width under ~1.05×pitch) — or when the user forces single-line style.
  void wholeWord
  const isNarrow = (lbl: number) =>
    style === 'centerline' ||
    (style === 'auto' && lbl > 0 && 2 * (maxD[lbl] / pxPerMm) < pitch * 1.05)

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
        // reject clamp-border corner pockets: a REAL valley touching the
        // border (M baseline mouth) has letter on BOTH sides along it; the
        // pocket outside a rounded corner has letter on one side only
        let pocket = false
        for (const i of px) {
          const x = i % w
          const y = (i / w) | 0
          let dirs: [number, number][] | null = null
          if (y <= gy0 + 1 || y >= gy1 - 1) dirs = [[1, 0], [-1, 0]]
          else if (x <= gx0 + 1 || x >= gx1 - 1) dirs = [[0, 1], [0, -1]]
          if (!dirs) continue
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
          if (!both) { pocket = true; break }
        }
        if (pocket) continue
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
          if (chord < Math.max(2.2 * g90, pitch * 1.1)) continue
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
  const contourInfos = wallContours.map((c) => analyzeContour(c, pitch, rhythm))
  for (const info of contourInfos) placeContourCorners(info, pitch, idx, out, bannedTest, rhythm)
  for (const info of contourInfos) placeContourEdges(info, pitch, idx, out, insideTest, bannedTest, rhythm, uniformRhythm)

  if (narrowLbls.size) {
    const compMask = new Uint8Array(w * h)
    for (const lbl of narrowLbls) {
      for (let i = 0; i < w * h; i++) compMask[i] = labels[i] === lbl ? 1 : 0
      const skel = skeletonize(compMask, w, h)
      const paths = traceSkeleton(skel, w, h)
        .map((p) => smoothPath(p).map(toMm))
        .sort((a, b) => b.length - a.length)
      for (const p of paths) out.push(...placeOpenEven(p, pitch, idx, rhythm))
    }
  }
  return out
}


// ---------------------------------------------------------------------------
// Offset outline rows — the classic rhinestone design styles:
//   echo  = a second concentric row INSET inside the edge row ("double outline")
//   ghost = a row floated OUTSIDE the letter edge (fabric shows through)
// Both run through the full corner-aware, rhythm-harmonized pipeline.
// ---------------------------------------------------------------------------
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
    // a clean echo requires its ring's own two sides to clear the minimum:
    // drop components where the remaining depth can't separate the loop —
    // a thin-loop echo is zigzag garbage, and no echo beats a bad echo
    const comp = labelComponents(mask, w, h)
    if (comp.count) {
      const cMax = new Float32Array(comp.count + 1)
      for (let i = 0; i < w * h; i++)
        if (comp.labels[i] && dt[i] > cMax[comp.labels[i]]) cMax[comp.labels[i]] = dt[i]
      for (let i = 0; i < w * h; i++) {
        const l = comp.labels[i]
        if (l && 2 * (cMax[l] / pxPerMm - offsetMm) < pitch * 0.9) mask[i] = 0
      }
    }
  }
  const rings = marchingSquares(mask, w, h)
    // ghost mode: drop the grid-border frame contour
    .filter((c) => !c.some((p) => p.x < 2 || p.y < 2 || p.x > w - 3 || p.y > h - 3))
    .map((c) => c.map(toMm))
    .sort((a, b) => b.length - a.length)
  const out: Pt[] = []
  for (const ring of rings) {
    const info = analyzeContour(ring, pitch, rhythmMm)
    placeContourCorners(info, pitch, idx, out, undefined, rhythmMm)
    placeContourEdges(info, pitch, idx, out, undefined, undefined, rhythmMm, uniform)
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
  const med = widths[Math.floor(widths.length / 2)]
  const required = offsetMm + pitch * 0.45 // from 2*(maxD - offset) >= 0.9*pitch
  return { feasible: echoFeasible(grid, pitch, offsetMm), scale: Math.max(1, required / med) }
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
  const cMax = new Float32Array(comp.count + 1)
  for (let i = 0; i < w * h; i++)
    if (comp.labels[i] && dt[i] > cMax[comp.labels[i]]) cMax[comp.labels[i]] = dt[i]
  let kept = 0
  for (let i = 0; i < w * h; i++) {
    const l = comp.labels[i]
    if (l && 2 * (cMax[l] / pxPerMm - offsetMm) >= pitch * 0.9) kept++
  }
  // MOST of the echo territory must survive gating — a bulge here and there
  // is not a double outline
  return kept >= raw * 0.55
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


// Single fill rows phase-lock to the OUTLINE stones beside them: project the
// wall stones onto the spine, cluster their beats, and place fill stones ON
// the beats (grid) or BETWEEN them (brick) — the rung structure of a
// hand-set template.
function placePhaseLocked(
  poly: Pt[],
  walls: Pt[],
  pitch: number,
  rhythm: number,
  idx: SpacingIndex,
  brick: boolean,
  closed = false,
): Pt[] {
  const path = makePath(poly, closed)
  if (!path) return []
  const fallback = (why: string) => {
    dbg('fallback:' + why, [pointAt(path, path.total / 2)])
    return closed
      ? walkPoly(poly, true, pitch, idx, 5, rhythm)
      : placeRun(path, 0, path.total, pitch, idx, undefined, rhythm)
  }
  if (!walls.length) return fallback('nowalls')
  if (path.total < rhythm * 0.4) return fallback('short')
  const step = 0.4
  const n = Math.max(2, Math.ceil(path.total / step))
  const samples: Pt[] = []
  for (let i = 0; i <= n; i++) samples.push(pointAt(path, (i * path.total) / n))
  const arcs: number[] = []
  for (const w of walls) {
    let bi = 0
    let bd = 1e9
    for (let i = 0; i <= n; i++) {
      const d = Math.hypot(w.x - samples[i].x, w.y - samples[i].y)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    if (bd < rhythm * 2.4) arcs.push((bi * path.total) / n)
  }
  if (arcs.length < 2) return fallback('few-arcs')
  arcs.sort((a, b) => a - b)
  const clusters: number[] = []
  let acc: number[] = [arcs[0]]
  for (let i = 1; i < arcs.length; i++) {
    if (arcs[i] - arcs[i - 1] < rhythm * 0.45) acc.push(arcs[i])
    else {
      clusters.push(acc.reduce((a2, b2) => a2 + b2, 0) / acc.length)
      acc = [arcs[i]]
    }
  }
  clusters.push(acc.reduce((a2, b2) => a2 + b2, 0) / acc.length)
  const targets: number[] = []
  if (clusters.length === 1) {
    targets.push(
      brick ? Math.min(path.total, clusters[0] + rhythm / 2) : clusters[0],
    )
  } else if (brick) {
    for (let i = 1; i < clusters.length; i++) targets.push((clusters[i - 1] + clusters[i]) / 2)
    if (closed && clusters.length >= 2)
      targets.push(((clusters[clusters.length - 1] + clusters[0] + path.total) / 2) % path.total)
  } else {
    targets.push(...clusters)
  }
  const placed: Pt[] = []
  for (const t of targets) {
    for (const f of [0, 0.12, -0.12, 0.25, -0.25]) {
      const p = pointAt(path, t + f * rhythm)
      if (
        idx.canPlace(p) &&
        (!placed.length ||
          Math.hypot(p.x - placed[placed.length - 1].x, p.y - placed[placed.length - 1].y) >= pitch)
      ) {
        idx.add(p)
        placed.push(p)
        break
      }
    }
  }
  if (placed.length) { dbg('lock', placed); return placed }
  return fallback('none-placed')
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
  const rowPitch = rhythm * 0.87
  const minPx = startInsetMm * pxPerMm
  const toMm = (p: Pt): Pt => ({ x: (p.x - padPx) / pxPerMm, y: (p.y - padPx) / pxPerMm })

  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = dt[i] >= minPx ? 1 : 0
  const { labels, count } = labelComponents(mask, w, h)
  const maxD = new Float32Array(count + 1)
  for (let i = 0; i < w * h; i++) if (labels[i] && dt[i] > maxD[labels[i]]) maxD[labels[i]] = dt[i]

  const out: Pt[] = []
  const compMask = new Uint8Array(w * h)
  for (let lbl = 1; lbl <= count; lbl++) {
    for (let i = 0; i < w * h; i++) compMask[i] = labels[i] === lbl ? 1 : 0
    const spanMm = maxD[lbl] / pxPerMm - startInsetMm

    const walkSkeleton = (m: Uint8Array) => {
      const skel = skeletonize(m, w, h)
      const paths = traceSkeleton(skel, w, h)
        .map((p) => smoothPath(p).map(toMm))
        .sort((a, b) => b.length - a.length)
      for (const p of paths)
        out.push(...placePhaseLocked(p, fixedPts, pitch, rhythm, idx, brick))
    }

    if (spanMm < pitch * 0.55) {
      // The pocket is so shallow that an iso-loop's two sides would collide:
      // place a single centerline row on the pocket's skeleton.
      dbg(`skelcomp:span${spanMm.toFixed(1)}`, [{ x: -1, y: -1 }])
      walkSkeleton(compMask)
    } else {
      // Multiple rows: stretch spacing so the block exactly spans the depth
      // band (equal padding both sides); cap the stretch and re-center if the
      // stretched spacing would look sparse.
      let n = Math.floor(spanMm / rowPitch) + 1
      dbg(`ringcomp:n${n}:span${spanMm.toFixed(1)}`, [{ x: -1, y: -1 }])
      let s = n > 1 ? spanMm / (n - 1) : 0
      let start = startInsetMm
      if (n > 1 && s > rowPitch * 1.35) {
        s = rowPitch
        start = startInsetMm + (spanMm - (n - 1) * rowPitch) / 2
      }
      const levelMask = new Uint8Array(w * h)
      for (let k = 0; k < n; k++) {
        // n == 1: the single ring sits on the clearance line so BOTH walls of
        // the pocket get a row (the loop's sides are >= pitch apart there).
        let tMm = n > 1 ? start + k * s : startInsetMm
        tMm = Math.min(tMm, maxD[lbl] / pxPerMm - 0.3)
        tMm = Math.max(tMm, startInsetMm)
        const tPx = tMm * pxPerMm + 0.01 // epsilon keeps levels off grid samples
        for (let i = 0; i < w * h; i++) levelMask[i] = compMask[i] && dt[i] >= tPx ? 1 : 0
        if (tMm > maxD[lbl] / pxPerMm - pitch * 0.8) {
          // Thin band near the ridge: an iso-loop here zigzags. Collapse the
          // row to the band's skeleton (spine for strokes, dot for blobs).
          walkSkeleton(levelMask)
          continue
        }
        // LAW-COMPLIANT rings: single rings phase-lock DIRECTLY to the wall
        // stones (grid = on their beats, brick = between them); multi-ring
        // areas run the corner pipeline with alternating brick phase.
        const rings = marchingSquares(levelMask, w, h)
          .map((c) => c.map(toMm))
          .sort((a, b) => b.length - a.length)
        if (n === 1) {
          for (const ring of rings)
            out.push(...placePhaseLocked(ring, fixedPts, pitch, rhythm, idx, brick, true))
        } else {
          const phase = brick && k % 2 === 0 ? 0.5 : 0
          for (const ring of rings) {
            const info = analyzeContour(ring, pitch, rhythm)
            if (info.fallback) {
              // cornerless (stadium) ring: phase-lock directly to the walls —
              // even levels on the wall beats, odd brick levels between them
              out.push(
                ...placePhaseLocked(ring, fixedPts, pitch, rhythm, idx, brick && k % 2 === 0, true),
              )
              continue
            }
            placeContourCorners(info, pitch, idx, out, undefined, rhythm)
            placeContourEdges(info, pitch, idx, out, undefined, undefined, rhythm, false, phase)
          }
        }
      }
    }
  }

  // Peak seeding: deepest unfilled spots (i-dots, star tips, terminals).
  const peaks: { p: Pt; d: number }[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      const d = dt[i]
      let isMax = true
      for (let dy = -1; dy <= 1 && isMax; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          if (dt[(y + dy) * w + (x + dx)] > d) {
            isMax = false
            break
          }
        }
      if (isMax) peaks.push({ p: toMm({ x, y }), d })
    }
  }
  peaks.sort((a, b) => b.d - a.d)
  for (const { p } of peaks) {
    if (idx.canPlace(p)) {
      idx.add(p)
      out.push(p)
    }
  }

  // Law fill: everything placed deterministically above — no relaxation,
  // no gap-insertion. What the laws place is what ships.
  return out
}

