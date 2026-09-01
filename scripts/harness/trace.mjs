// Vector-fidelity tracing test: run the outline pipeline on one (font, word)
// and measure HOW CLOSE the trace sits to the original vector.
//
//   node scripts/harness/trace.mjs <font.ttf> [text] [heightMm] [hole] [gap] [style]
//
// The question each test asks: can this trace get closer to the original
// vector? Metrics:
//   vecP50/P90/Max  — wall-stone distance to the input contour, mm. A wall
//                     stone belongs ON the vector line; drift is trace error.
//   spineCtr        — spine stones' |dist-to-contour − halfWidth| p90: a
//                     centerline stone belongs mid-stroke.
//   floorViol/gapP50/gapP90/bareRuns — legality, rhythm, coverage (as run.mjs)
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'

const [fontPath, text = 'Glee', heightMm = '50', holeMm = '3.4', gapMm = '0.8', style = 'auto'] =
  process.argv.slice(2)

const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, distanceTransform, outlineOrSpine, rasterizeContours, debugStones } =
  await import('../../src/fill.ts')

const font = opentype.parse((await readFile(fontPath)).buffer)
const H = +heightMm
const hole = +holeMm
const gap = +gapMm
const pitch = hole + gap
const rhythm = pitch

const { contours, widthMm } = textToContours(font, text, H, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(pitch)
const t0 = performance.now()
const out = outlineOrSpine(contours, grid, hole, gap, idx, style, true, rhythm, true)
const ms = performance.now() - t0

// ---- distance to the INPUT VECTOR (segment-accurate) ----------------------
const segs = []
for (const c of contours)
  for (let k = 0; k < c.length; k++) {
    const a = c[k]
    const b = c[(k + 1) % c.length]
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) segs.push([a.x, a.y, b.x - a.x, b.y - a.y])
  }
const distToVec = (p) => {
  let m = Infinity
  for (const [ax, ay, vx, vy] of segs) {
    const L2 = vx * vx + vy * vy
    let t = ((p.x - ax) * vx + (p.y - ay) * vy) / L2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const d = Math.hypot(p.x - (ax + vx * t), p.y - (ay + vy * t))
    if (d < m) m = d
  }
  return m
}

// wall-ish stones must sit ON the vector; spines mid-stroke
const WALL = new Set(['corner', 'edge', 'patch', 'loop'])
const SPINE = new Set(['spine', 'partspine', 'narrowspine', 'line', 'taper', 'vectorline', 'rescue'])
const wallD = []
const spineErr = []
const { bin, w, h, pxPerMm, padPx } = grid
const dt = distanceTransform(grid)
const dtAt = (p) => {
  const xi = Math.round(p.x * pxPerMm + padPx)
  const yi = Math.round(p.y * pxPerMm + padPx)
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0
  return dt[yi * w + xi] / pxPerMm
}
// local stroke width (largest inscribed disk, stamped back): lets the metric
// accept a stone ON the wall (d≈0) OR centered on a hairline (d≈halfStroke) —
// anything between is a wobble off the trace line.
const strokeW = new Float32Array(w * h)
for (let y = 1; y < h - 1; y++)
  for (let x = 1; x < w - 1; x++) {
    const i2 = y * w + x
    if (!bin[i2]) continue
    const dvv = dt[i2]
    if (dvv <= 0) continue
    if (!(dvv >= dt[i2-1] && dvv >= dt[i2+1] && dvv >= dt[i2-w] && dvv >= dt[i2+w] &&
          dvv >= dt[i2-w-1] && dvv >= dt[i2-w+1] && dvv >= dt[i2+w-1] && dvv >= dt[i2+w+1])) continue
    const rr = dvv * dvv
    const val = (2 * dvv) / pxPerMm
    const r0 = Math.ceil(dvv)
    for (let yy = Math.max(0, y - r0); yy <= Math.min(h - 1, y + r0); yy++) {
      const dy2 = yy - y
      const sp2 = Math.floor(Math.sqrt(Math.max(0, rr - dy2 * dy2)))
      const row = yy * w
      for (let xx = Math.max(0, x - sp2); xx <= Math.min(w - 1, x + sp2); xx++)
        if (bin[row + xx] && strokeW[row + xx] < val) strokeW[row + xx] = val
    }
  }
const strokeWAt = (p) => {
  const xi = Math.round(p.x * pxPerMm + padPx)
  const yi = Math.round(p.y * pxPerMm + padPx)
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0
  return strokeW[yi * w + xi]
}
for (const s of debugStones) {
  const d = distToVec(s)
  if (WALL.has(s.cat)) {
    // width from the inscribed-disk field OR twice the stone's own depth —
    // the stamp can miss junction pixels and mislabel a centered stone
    const half = Math.max(strokeWAt(s) / 2, dtAt(s))
    // narrow stroke: mid-riding is the correct trace; wide: the wall is
    const err = half > 0 && half < 4.2 * 0.55 ? Math.min(d, Math.abs(d - half)) : d
    wallD.push(err)
  } else if (SPINE.has(s.cat)) spineErr.push(Math.abs(d - dtAt(s)) < 0.3 ? 0 : Math.abs(d - dtAt(s)))
}
wallD.sort((a, b) => a - b)
spineErr.sort((a, b) => a - b)
const pct = (arr, f) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : 0)

// ---- legality / rhythm / coverage (as run.mjs) ----------------------------
const nn = out.map((p) => {
  let m = Infinity
  for (const q of out) {
    if (q === p) continue
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < m) m = d
  }
  return m
})
nn.sort((a, b) => a - b)
const floorViol = nn.filter((d) => d < pitch - 0.01).length

const sBin = new Uint8Array(w * h).fill(1)
for (const q of out) {
  const px = Math.round(q.x * pxPerMm + padPx)
  const py = Math.round(q.y * pxPerMm + padPx)
  if (px >= 0 && py >= 0 && px < w && py < h) sBin[py * w + px] = 0
}
const dStone = distanceTransform({ bin: sBin, w, h, pxPerMm, padPx })
const bareMask = new Uint8Array(w * h)
for (let i = 0; i < w * h; i++) {
  if (!bin[i]) continue
  if (dt[i] / pxPerMm > pitch * 0.55) continue
  if (dt[i] / pxPerMm < 0.4) continue
  if (dStone[i] / pxPerMm > rhythm * 1.15) bareMask[i] = 1
}
let bareRuns = 0
{
  const seen = new Uint8Array(w * h)
  const stack = []
  for (let i = 0; i < w * h; i++) {
    if (!bareMask[i] || seen[i]) continue
    const members = []
    stack.push(i)
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()
      members.push(j)
      const x = j % w
      if (x > 0 && bareMask[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1) }
      if (x < w - 1 && bareMask[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1) }
      if (j >= w && bareMask[j - w] && !seen[j - w]) { seen[j - w] = 1; stack.push(j - w) }
      if (j < w * (h - 1) && bareMask[j + w] && !seen[j + w]) { seen[j + w] = 1; stack.push(j + w) }
    }
    if (members.length > (pitch * pxPerMm) ** 2 * 0.15) bareRuns++
  }
}

// CLUMP metric: a stone with 2+ neighbours near the legal floor whose
// directions are NOT opposite (a row has floor-ish neighbours only fore/aft;
// a knot has them at an angle). This is what the eye reads as clutter.
let clumps = 0
const onVec = (p) => distToVec(p) < 0.55
for (const p of out) {
  const nbr = []
  for (const q of out) {
    if (q === p) continue
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < pitch * 1.08) nbr.push({ q, x: (q.x - p.x) / d, y: (q.y - p.y) / d })
  }
  if (nbr.length < 2) continue
  let knot = false
  for (let a = 0; a < nbr.length && !knot; a++)
    for (let b = a + 1; b < nbr.length; b++) {
      const dot = nbr[a].x * nbr[b].x + nbr[a].y * nbr[b].y
      if (dot <= -0.2) continue // fore/aft or a shallow bend: a row
      // an angular meeting where all three ride the vector is a CORNER —
      // correct tracing, not clutter
      if (onVec(p) && onVec(nbr[a].q) && onVec(nbr[b].q)) continue
      knot = true
      break
    }
  if (knot) clumps++
}
const cats = debugStones.reduce((m, s) => ((m[s.cat] = (m[s.cat] || 0) + 1), m), {})
console.log(
  JSON.stringify({
    font: fontPath.split('/').pop(),
    text,
    ms: Math.round(ms),
    widthMm: Math.round(widthMm),
    stones: out.length,
    cats,
    wallN: wallD.length,
    vecP50: +pct(wallD, 0.5).toFixed(2),
    vecP90: +pct(wallD, 0.9).toFixed(2),
    vecMax: +pct(wallD, 1).toFixed(2),
    spineN: spineErr.length,
    spineCtrP90: +pct(spineErr, 0.9).toFixed(2),
    clumps,
    floorViol,
    gapP50: +pct(nn, 0.5).toFixed(2),
    gapP90: +pct(nn, 0.9).toFixed(2),
    bareRuns,
  }),
)
