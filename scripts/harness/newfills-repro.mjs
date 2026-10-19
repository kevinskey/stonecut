// Concentric & radial fill check: legality (pairwise floor, inside shape,
// outline clearance) + sane counts on a solid disk, a ring band, and a star.
import './canvas-stub.mjs'
const { SpacingIndex, marchingSquares, outlineOrSpine, fillStones, distanceTransform } =
  await import('../../src/fill.ts')

const hole = 3.4, gap = 0.8, pitch = hole + gap, pxPerMm = 6
const fHole = 2.5, fGap = 0.8, fPitch = fHole + fGap

function makeGrid(fn, sizeMm) {
  const W = Math.round(sizeMm * pxPerMm)
  const bin = new Uint8Array(W * W)
  const c = W / 2
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++)
      bin[y * W + x] = fn((x - c) / pxPerMm, (y - c) / pxPerMm) ? 1 : 0
  return { grid: { bin, w: W, h: W, pxPerMm, padPx: 0 }, W }
}

const star = (x, y) => {
  const r = Math.hypot(x, y)
  const th = Math.atan2(y, x)
  const rMax = 16 + 9 * Math.cos(5 * th)
  return r <= rMax
}

const shapes = [
  ['solid-disk-40', (x, y) => Math.hypot(x, y) <= 20, 48],
  ['ring-band-8mm', (x, y) => { const d = Math.hypot(x, y); return d <= 20 && d >= 12 }, 48],
  ['star-5', star, 56],
]

let fail = 0
for (const [name, fn, size] of shapes) {
  const { grid, W } = makeGrid(fn, size)
  const dt = distanceTransform(grid)
  const contours = marchingSquares(grid.bin, W, W).map((ct) =>
    ct.map((p) => ({ x: p.x / pxPerMm, y: p.y / pxPerMm })))
  for (const style of ['brick', 'concentric', 'radial']) {
    const idx = new SpacingIndex(pitch)
    const outline = outlineOrSpine(contours, grid, hole, gap, idx, 'auto', false, pitch, true)
    const fIdx = new SpacingIndex(Math.max(fPitch, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
    const fill = fillStones(grid, fHole, fGap, fHole / 2 + 0.1, fIdx, outline, fPitch, style, hole)
    // legality: pairwise floor among fill stones
    let minPair = Infinity
    for (let i = 0; i < fill.length; i++)
      for (let j = i + 1; j < fill.length; j++) {
        const d = Math.hypot(fill[i].x - fill[j].x, fill[i].y - fill[j].y)
        if (d < minPair) minPair = d
      }
    // legality: fill-to-outline clearance
    let minOut = Infinity
    for (const p of fill)
      for (const o of outline) {
        const d = Math.hypot(p.x - o.x, p.y - o.y)
        if (d < minOut) minOut = d
      }
    // inside the shape with half a hole of clearance
    let worstEdge = Infinity
    for (const p of fill) {
      const v = dt[Math.round(p.y * pxPerMm) * W + Math.round(p.x * pxPerMm)] / pxPerMm
      if (v < worstEdge) worstEdge = v
    }
    const needPair = fPitch - 0.02
    const needOut = hole / 2 + fHole / 2 + 0.5 - 0.02 // engine uses the 0.5mm template floor to the outline
    const needEdge = fHole / 2 - 0.2 // half a raster pixel of grace
    const bad =
      (fill.length && minPair < needPair) ||
      (fill.length && outline.length && minOut < needOut) ||
      (fill.length && worstEdge < needEdge) ||
      fill.length === 0
    if (bad) fail++
    console.log(
      `${name.padEnd(16)} ${style.padEnd(11)} fill=${String(fill.length).padStart(3)}` +
      ` minPair=${minPair === Infinity ? '—' : minPair.toFixed(2)}` +
      ` minOutline=${minOut === Infinity ? '—' : minOut.toFixed(2)}` +
      ` edge=${worstEdge === Infinity ? '—' : worstEdge.toFixed(2)}` +
      (bad ? '  *** FAIL' : '  ok'),
    )
  }
}
process.exit(fail ? 1 : 0)
