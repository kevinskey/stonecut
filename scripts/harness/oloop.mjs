// Measure chord gaps around the o's two rings, split by radius.
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours, debugStones } = await import('../../src/fill.ts')
const [fontPath, text='Joyful!', H='60'] = process.argv.slice(2)
const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours } = textToContours(font, text, +H, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(4.2)
outlineOrSpine(contours, grid, 3.4, 0.8, idx, 'auto', true, 4.2, true)
const loops = debugStones.filter(d => d.cat === 'loop')
const cx = loops.reduce((s,p)=>s+p.x,0)/loops.length, cy = loops.reduce((s,p)=>s+p.y,0)/loops.length
const withR = loops.map(p=>({...p, r: Math.hypot(p.x-cx,p.y-cy)}))
const rMid = (Math.min(...withR.map(p=>p.r)) + Math.max(...withR.map(p=>p.r)))/2
for (const [name, pts] of [['outer', withR.filter(p=>p.r>=rMid)], ['inner', withR.filter(p=>p.r<rMid)]]) {
  const sorted = [...pts].sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx))
  const gaps = sorted.map((p,i)=>{const q=sorted[(i+1)%sorted.length];return Math.hypot(p.x-q.x,p.y-q.y)})
  console.log(`${name} n=${pts.length} min=${Math.min(...gaps).toFixed(2)} max=${Math.max(...gaps).toFixed(2)} :: ${gaps.map(g=>g.toFixed(2)).join(' ')}`)
}
