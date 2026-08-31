// Line-art repro: TWO concentric thin circle strokes (target symbol) —
// the common "circle with inner circle" artwork.
//   node scripts/harness/ring-repro2.mjs [strokeMm] [r1] [r2] [style]
import './canvas-stub.mjs'
const [strokeMm = '2', r1s = '40', r2s = '20', style = 'auto'] = process.argv.slice(2)
const { SpacingIndex, marchingSquares, outlineOrSpine } = await import('../../src/fill.ts')
const hole = 3.4, gap = 0.8, pitch = hole + gap, pxPerMm = 6
const R1 = +r1s / 2, R2 = +r2s / 2, sw = +strokeMm / 2
const W = Math.round((+r1s + 10) * pxPerMm)
const cx = W / 2
const bin = new Uint8Array(W * W)
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cx) / pxPerMm
    bin[y * W + x] = Math.abs(d - R1) <= sw || Math.abs(d - R2) <= sw ? 1 : 0
  }
const grid = { bin, w: W, h: W, pxPerMm, padPx: 0 }
const contours = marchingSquares(bin, W, W).map((c) => c.map((p) => ({ x: p.x / pxPerMm, y: p.y / pxPerMm })))
const idx = new SpacingIndex(pitch)
const out = outlineOrSpine(contours, grid, hole, gap, idx, style, false, pitch, true)
const cMm = cx / pxPerMm
let n1 = 0, n2 = 0, other = 0
for (const p of out) {
  const d = Math.hypot(p.x - cMm, p.y - cMm)
  if (Math.abs(d - R1) < pitch * 0.7) n1++
  else if (Math.abs(d - R2) < pitch * 0.7) n2++
  else other++
}
console.log({ strokeMm: +strokeMm, stones: out.length, outerRing: n1, innerRing: n2, other })
