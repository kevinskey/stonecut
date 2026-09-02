// Fill test: solid disk (pure lattice, no salvage) vs narrow ring (salvage row).
import './canvas-stub.mjs'
const { SpacingIndex, marchingSquares, outlineOrSpine, fillStones } = await import('../../src/fill.ts')
const hole = 3.4, gap = 0.8, pitch = hole + gap, pxPerMm = 6
const fHole = 2.5, fGap = 0.8

function makeGrid(fn, sizeMm) {
  const W = Math.round(sizeMm * pxPerMm)
  const bin = new Uint8Array(W * W)
  const c = W / 2
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++)
      bin[y * W + x] = fn(Math.hypot(x - c, y - c) / pxPerMm) ? 1 : 0
  return { grid: { bin, w: W, h: W, pxPerMm, padPx: 0 }, W, c }
}

for (const [name, fn, size] of [
  ['solid-disk-40', (d) => d <= 20, 48],
  ['ring-band-6mm', (d) => d <= 20 && d >= 14, 48],
  ['ring-band-8mm', (d) => d <= 20 && d >= 12, 48],
]) {
  const { grid, W, c } = makeGrid(fn, size)
  const contours = marchingSquares(grid.bin, W, W).map((ct) => ct.map((p) => ({ x: p.x / pxPerMm, y: p.y / pxPerMm })))
  const idx = new SpacingIndex(pitch)
  const outline = outlineOrSpine(contours, grid, hole, gap, idx, 'auto', false, pitch, true)
  const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
  const fill = fillStones(grid, fHole, fGap, fHole / 2 + 0.1, fIdx, outline, fHole + fGap, true, hole)
  // how much of the material is within a beat of some fill/outline stone?
  const all = [...outline, ...fill]
  let bare = 0, mat = 0
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      if (!grid.bin[y * W + x]) continue
      mat++
      const px = x / pxPerMm, py = y / pxPerMm
      if (!all.some((p) => Math.hypot(p.x - px, p.y - py) < pitch)) bare++
    }
  console.log(name, { outline: outline.length, fill: fill.length, barePct: +(100 * bare / mat).toFixed(1) })
}
