// What geometry exists near a stray stone? Compare raster boundary vs input vector.
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const [fontPath, text, X, Y] = process.argv.slice(2)
const cx=+X, cy=+Y
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { marchingSquares, rasterizeContours } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours } = await textToContours(font, text, 50, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const { w,h,pxPerMm,padPx } = grid
const merged = marchingSquares(grid.bin, w, h).map(ct=>ct.map(v=>({x:(v.x-padPx)/pxPerMm,y:(v.y-padPx)/pxPerMm})))
const near=(pts)=>pts.filter(p=>Math.hypot(p.x-cx,p.y-cy)<5)
console.log('merged-outline pts within 5mm:')
for (const ct of merged){const n=near(ct); if(n.length) console.log(' ct(len'+ct.length+'):', n.slice(0,10).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))}
console.log('input-vector pts within 5mm:')
for (const ct of contours){const n=near(ct); if(n.length) console.log(' ct(len'+ct.length+'):', n.slice(0,10).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))}
// material profile row through the stray
const yi=Math.round(cy*pxPerMm+padPx)
let row=''
for(let xi=Math.round((cx-6)*pxPerMm+padPx); xi<=Math.round((cx+6)*pxPerMm+padPx); xi++) row+=grid.bin[yi*w+xi]?'#':'.'
console.log('bin row @y='+cy+':', row)
