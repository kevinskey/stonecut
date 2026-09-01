// List clump stones (cat + position + angular neighbours' cats).
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const [fontPath, text='GLEE', heightMm='40'] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours, debugStones } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours } = await textToContours(font, text, +heightMm, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(4.2)
const out = outlineOrSpine(contours, grid, 3.4, 0.8, idx, 'auto', true, 4.2, true)
const catOf = new Map()
for (const s of debugStones) catOf.set(`${s.x.toFixed(3)},${s.y.toFixed(3)}`, s.cat)
const pitch = 4.2
const clumps = []
for (const p of out) {
  const nbr = []
  for (const q of out) {
    if (q === p) continue
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < pitch * 1.15) nbr.push({ q, ux: (q.x - p.x) / d, uy: (q.y - p.y) / d, d })
  }
  if (nbr.length < 2) continue
  let knot = false
  for (let a = 0; a < nbr.length && !knot; a++)
    for (let b = a + 1; b < nbr.length; b++)
      if (nbr[a].ux * nbr[b].ux + nbr[a].uy * nbr[b].uy > -0.45) { knot = true; break }
  if (knot)
    clumps.push({
      cat: catOf.get(`${p.x.toFixed(3)},${p.y.toFixed(3)}`) ?? '?',
      x: +p.x.toFixed(1), y: +p.y.toFixed(1),
      nbrs: nbr.map(n=>`${catOf.get(`${n.q.x.toFixed(3)},${n.q.y.toFixed(3)}`)??'?'}@${n.d.toFixed(1)}`),
    })
}
console.log(JSON.stringify(clumps,null,0).replaceAll('},','},\n'))
