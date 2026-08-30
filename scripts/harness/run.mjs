// Offline placement harness: run the real outline pipeline on a font file
// and report quality metrics, no browser involved.
//
//   node scripts/harness/run.mjs <font.ttf> [text] [heightMm] [holeMm] [gapMm] [style]
//
// Metrics:
//   stones        total placed
//   floorViol     nearest-neighbour pairs under the legal floor
//   gapP50/P90    nearest-neighbour spacing percentiles (target ≈ rhythm)
//   bareP90/max   distance from narrow material to its nearest stone, in
//                 beats — >1.3 beats means a visible hole in the lettering
//   bareRuns      count of narrow-material blobs more than a beat from
//                 every stone (the "empty bowl" defect)
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'

const [fontPath, text = 'GLEE', heightMm = '50', holeMm = '3.4', gapMm = '0.8', style = 'auto'] =
  process.argv.slice(2)
if (!fontPath) {
  console.error('usage: node scripts/harness/run.mjs <font.ttf> [text] [height] [hole] [gap] [style]')
  process.exit(1)
}

const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, distanceTransform, outlineOrSpine, rasterizeContours, debugStones, capGaps } =
  await import('../../src/fill.ts')

const font = opentype.parse((await readFile(fontPath)).buffer)
const H = +heightMm
const hole = +holeMm
const gap = +gapMm
const pitch = hole + gap
const rhythm = hole + gap // App uses hole + gap (soft) as rhythm; hardGap == gap here

const { contours, widthMm } = textToContours(font, text, H, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(pitch)
const t0 = performance.now()
const out = outlineOrSpine(contours, grid, hole, gap, idx, style, true, rhythm, true)
const ms = performance.now() - t0

// --- metrics -------------------------------------------------------------
const { bin, w, h, pxPerMm, padPx } = grid
const dt = distanceTransform(grid)

// nearest-neighbour spacing
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
const pct = (arr, f) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : 0)
const floorViol = nn.filter((d) => d < pitch - 0.01).length

// bare narrow material: distance to nearest stone, for pixels whose stroke
// is narrow enough that stones belong there (own dt small)
const sBin = new Uint8Array(w * h).fill(1)
for (const q of out) {
  const px = Math.round(q.x * pxPerMm + padPx)
  const py = Math.round(q.y * pxPerMm + padPx)
  if (px >= 0 && py >= 0 && px < w && py < h) sBin[py * w + px] = 0
}
const dStone = distanceTransform({ bin: sBin, w, h, pxPerMm, padPx })
const bareDist = []
const bareMask = new Uint8Array(w * h)
for (let i = 0; i < w * h; i++) {
  if (!bin[i]) continue
  if (dt[i] / pxPerMm > pitch * 0.55) continue // deep inside a wide stroke: no stones expected (same cap as the sweep)
  // sub-stone shards (hairline drawing debris under ~0.8mm thick) are
  // deliberately unrepresented — the app filters them as debris — so they
  // don't count as bare either
  if (dt[i] / pxPerMm < 0.4) continue
  const d = dStone[i] / pxPerMm
  bareDist.push(d)
  if (d > rhythm * 1.15) bareMask[i] = 1
}
bareDist.sort((a, b) => a - b)
// connected bare blobs (simple 4-neighbour flood)
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
    if (members.length > (pitch * pxPerMm) ** 2 * 0.15) {
      bareRuns++
      // report where, in mm, so the defect can be found on the letterform
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const j of members) {
        const bx = (j % w - padPx) / pxPerMm
        const by = (Math.floor(j / w) - padPx) / pxPerMm
        if (bx < x0) x0 = bx
        if (bx > x1) x1 = bx
        if (by < y0) y0 = by
        if (by > y1) y1 = by
      }
      console.error(`bare blob ${bareRuns}: ${members.length}px  x ${x0.toFixed(1)}..${x1.toFixed(1)}  y ${y0.toFixed(1)}..${y1.toFixed(1)}`)
    }
  }
}

const cats = debugStones.reduce((m, s) => ((m[s.cat] = (m[s.cat] || 0) + 1), m), {})
console.log(
  JSON.stringify(
    {
      font: fontPath.split('/').pop(),
      text,
      heightMm: H,
      widthMm: Math.round(widthMm),
      ms: Math.round(ms),
      stones: out.length,
      cats,
      floorViol,
      gapP50: +pct(nn, 0.5).toFixed(2),
      gapP90: +pct(nn, 0.9).toFixed(2),
      bareP90beats: +(pct(bareDist, 0.9) / rhythm).toFixed(2),
      bareMaxBeats: +(pct(bareDist, 1) / rhythm).toFixed(2),
      bareRuns,
      capGaps: capGaps.length,
    },
    null,
    1,
  ),
)
