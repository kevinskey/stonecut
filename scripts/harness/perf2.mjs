// preview-resolution timing comparison
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(process.argv[2])).buffer)
const { contours } = textToContours(font, 'Glee World', 50, 2)
for (const px of [6, 4]) {
  const t = performance.now()
  const grid = rasterizeContours(contours, px, 0.5)
  const idx = new SpacingIndex(4.2)
  const o = outlineOrSpine(contours, grid, 3.4, 0.8, idx, 'auto', true, 4.2, true)
  console.log(`px=${px}: ${(performance.now()-t).toFixed(0)}ms, ${o.length} stones`)
}
