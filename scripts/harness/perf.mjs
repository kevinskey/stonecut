import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, marchingSquares, outlineOrSpine, rasterizeContours, fillStones, fillByGlyph } = await import('../../src/fill.ts')
// thick image case: paw-like disk 100mm
const pxPerMm=6, W=Math.round(110*pxPerMm)
const bin=new Uint8Array(W*W); const c=W/2
for(let y=0;y<W;y++)for(let x=0;x<W;x++) bin[y*W+x]=Math.hypot(x-c,y-c)/pxPerMm<=50?1:0
const grid={bin,w:W,h:W,pxPerMm,padPx:0}
const contours=marchingSquares(bin,W,W).map(ct=>ct.map(p=>({x:p.x/pxPerMm,y:p.y/pxPerMm})))
let t=performance.now()
const idx=new SpacingIndex(4.2)
const outline=outlineOrSpine(contours,grid,3.4,0.8,idx,'auto',false,4.2,true)
console.log('disk100 outline:', (performance.now()-t).toFixed(0),'ms,',outline.length,'stones')
t=performance.now()
const fIdx=new SpacingIndex(3.3,0.8,1.25)
const fill=fillStones(grid,2.5,0.8,1.35,fIdx,outline,3.3,true,3.4)
console.log('disk100 fill   :', (performance.now()-t).toFixed(0),'ms,',fill.length,'stones')
// text case
const font=opentype.parse((await readFile(process.argv[2])).buffer)
const {contours: tc}=textToContours(font,'Glee World',50,2)
const tg=rasterizeContours(tc,6,0.5)
t=performance.now()
const idx2=new SpacingIndex(4.2)
const o2=outlineOrSpine(tc,tg,3.4,0.8,idx2,'auto',true,4.2,true)
console.log('GleeWorld outline:', (performance.now()-t).toFixed(0),'ms,',o2.length)
t=performance.now()
const fIdx2=new SpacingIndex(3.3,0.8,1.25)
const f2=fillByGlyph(tc,2.5,0.8,1.35,fIdx2,o2,3.3,true,3.4)
console.log('GleeWorld fill  :', (performance.now()-t).toFixed(0),'ms,',f2.length)
