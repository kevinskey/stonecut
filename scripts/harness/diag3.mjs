// What's near a bare blob: stones (with cats) and material shape around (x,y).
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const [fontPath, text, X, Y] = process.argv.slice(2)
const cx=+X, cy=+Y
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours, debugStones } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours } = await textToContours(font, text, 50, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(4.2)
outlineOrSpine(contours, grid, 3.4, 0.8, idx, 'auto', true, 4.2, true)
const near = debugStones.filter(s=>Math.hypot(s.x-cx,s.y-cy)<8)
  .map(s=>({cat:s.cat,x:+s.x.toFixed(1),y:+s.y.toFixed(1),d:+Math.hypot(s.x-cx,s.y-cy).toFixed(1)}))
  .sort((a,b)=>a.d-b.d)
console.log(JSON.stringify(near.slice(0,10)).replaceAll('},','},\n'))
const { w,h,pxPerMm,padPx } = grid
let art=''
for(let yy=Math.round((cy-5)*pxPerMm+padPx); yy<=Math.round((cy+5)*pxPerMm+padPx); yy+=2){
  let row=''
  for(let xx=Math.round((cx-7)*pxPerMm+padPx); xx<=Math.round((cx+7)*pxPerMm+padPx); xx+=1)
    row += (xx>=0&&yy>=0&&xx<w&&yy<h&&grid.bin[yy*w+xx])?'#':'.'
  art+=row+'\n'
}
console.log(art)
