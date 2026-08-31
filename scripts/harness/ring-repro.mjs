// Repro: image-path outline on a ring (outer circle + inner hole).
// Reports how many stones trace the outer vs inner boundary.
//   node scripts/harness/ring-repro.mjs [outerMm] [innerMm] [style]
import './canvas-stub.mjs'

const [outerMm = '40', innerMm = '25', style = 'auto'] = process.argv.slice(2)
const { SpacingIndex, marchingSquares, outlineOrSpine } = await import('../../src/fill.ts')

const hole = 3.4
const gap = 0.8
const pitch = hole + gap
const pxPerMm = 6
const R1 = +outerMm / 2
const R2 = +innerMm / 2
const W = Math.round((+outerMm + 8) * pxPerMm)
const cx = W / 2
const bin = new Uint8Array(W * W)
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cx) / pxPerMm
    bin[y * W + x] = d <= R1 && d >= R2 ? 1 : 0
  }
const grid = { bin, w: W, h: W, pxPerMm, padPx: 0 }
const contours = marchingSquares(bin, W, W).map((c) => c.map((p) => ({ x: p.x / pxPerMm, y: p.y / pxPerMm })))
console.log('contours:', contours.map((c) => c.length))

const idx = new SpacingIndex(pitch)
const out = outlineOrSpine(contours, grid, hole, gap, idx, style, false, pitch, true)

const cMm = cx / pxPerMm
let nearOuter = 0
let nearInner = 0
let elsewhere = 0
for (const p of out) {
  const d = Math.hypot(p.x - cMm, p.y - cMm)
  if (Math.abs(d - R1) < pitch) nearOuter++
  else if (Math.abs(d - R2) < pitch) nearInner++
  else elsewhere++
}
console.log({ stones: out.length, nearOuter, nearInner, elsewhere })
