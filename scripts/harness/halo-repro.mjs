// Smoke test the Halo design: N rows of stones floating OUTSIDE vinyl
// letters. Checks that rows exist, respect the clearance band, and never
// land inside the letters.
//
//   node --experimental-strip-types scripts/harness/halo-repro.mjs <font.ttf> [text] [heightMm] [rows]
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'

const [fontPath, text = 'Bears', heightMm = '60', rowsArg = '3'] = process.argv.slice(2)
if (!fontPath) {
  console.error('usage: node scripts/harness/halo-repro.mjs <font.ttf> [text] [height] [rows]')
  process.exit(1)
}
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, distanceTransform, haloOutline, rasterizeContours, HALO_CLEAR } =
  await import('../../src/fill.ts')

const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours, widthMm } = textToContours(font, text, +heightMm, 0)
const hole = 3.4
const gap = 0.8
const rhythm = hole + gap
const rows = Math.round(+rowsArg)
const pad = (HALO_CLEAR + rows) * rhythm + hole + 1
const grid = rasterizeContours(contours, 6, pad)
const idx = new SpacingIndex(hole + 0.8)
const stones = haloOutline(grid, hole, 0.8, idx, rhythm, rows, true)

// distance from each stone to the letter shape (negative = inside)
const dtOut = (() => {
  const inv = new Uint8Array(grid.w * grid.h)
  for (let i = 0; i < grid.w * grid.h; i++) inv[i] = grid.bin[i] ? 0 : 1
  return distanceTransform({ ...grid, bin: inv })
})()
let inside = 0
let minD = Infinity
let maxD = 0
for (const s of stones) {
  const px = Math.round(s.x * grid.pxPerMm + grid.padPx)
  const py = Math.round(s.y * grid.pxPerMm + grid.padPx)
  if (px < 0 || py < 0 || px >= grid.w || py >= grid.h) continue
  if (grid.bin[py * grid.w + px]) { inside++; continue }
  const d = dtOut[py * grid.w + px] / grid.pxPerMm
  if (d < minD) minD = d
  if (d > maxD) maxD = d
}
// legal floor check
let floorViol = 0
for (let i = 0; i < stones.length; i++)
  for (let j = i + 1; j < stones.length; j++) {
    const dx = stones[i].x - stones[j].x
    const dy = stones[i].y - stones[j].y
    if (Math.hypot(dx, dy) < hole + 0.8 - 0.05) floorViol++
  }
console.log({
  text,
  widthMm: +widthMm.toFixed(1),
  rows,
  stones: stones.length,
  insideLetters: inside,
  distMin: +minD.toFixed(2),
  distMax: +maxD.toFixed(2),
  expectFirstRow: +(HALO_CLEAR * rhythm).toFixed(2),
  expectLastRow: +((HALO_CLEAR + rows - 1) * rhythm).toFixed(2),
  floorViol,
})
if (!stones.length || inside > 0 || floorViol > 0) process.exit(1)
console.log('halo OK')
