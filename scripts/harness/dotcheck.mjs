// Verify dot treatment: outline ring evenness + fill count on i/! dots.
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const [fontPath, text='i!'] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours, fillByGlyph } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
globalThis.SC_DOTDBG = true
const { contours } = await textToContours(font, text, 45, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(4.2)
const outline = outlineOrSpine(contours, grid, 3.4, 0.8, idx, 'auto', true, 4.2, true)
const fHole=2.5, fGap=0.8
const fIdx = new SpacingIndex(Math.max(fHole+fGap,(3.4+fHole)/2+fGap), fGap, fHole/2)
const fill = fillByGlyph(contours, fHole, fGap, fHole/2+0.1, fIdx, outline, fHole+fGap, true, 3.4)
// find small closed contours (dots): circumference < 4.2*7
for (const c of contours) {
  let len=0, cx=0, cy=0
  for (let k=0;k<c.length;k++){const a=c[k],b=c[(k+1)%c.length]; len+=Math.hypot(b.x-a.x,b.y-a.y); cx+=a.x; cy+=a.y}
  cx/=c.length; cy/=c.length
  if (len >= 4.2*7 || len < 8) continue
  const near = outline.filter(p=>Math.hypot(p.x-cx,p.y-cy) < len/4)
  const fnear = fill.filter(p=>Math.hypot(p.x-cx,p.y-cy) < len/4)
  // ring evenness: angular gaps between outline stones around centroid
  const angs = near.map(p=>Math.atan2(p.y-cy,p.x-cx)).sort((a,b)=>a-b)
  let maxGap=0
  for (let k=0;k<angs.length;k++){const g=(angs[(k+1)%angs.length]-angs[k]+2*Math.PI)%(2*Math.PI); if(g>maxGap)maxGap=g}
  console.log(`dot @(${cx.toFixed(0)},${cy.toFixed(0)}) circ=${len.toFixed(1)}mm ring=${near.length} stones maxAngGap=${(maxGap*180/Math.PI).toFixed(0)}° fillInside=${fnear.length}`)
}
