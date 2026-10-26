// render with hole/gap params: node render2.mjs <font> <text> <H> <hole> <gap> <out.svg>
import './canvas-stub.mjs'
import { readFile, writeFile } from 'node:fs/promises'
const [fontPath, text='GLEE', heightMm='50', holeA='3.4', gapA='0.8', outPath='/tmp/trace.svg'] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours, debugStones } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const hole = +holeA, gap = +gapA
const pitch = hole + gap
const rhythm = pitch * 1.15
const { contours, widthMm } = textToContours(font, text, +heightMm, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(rhythm)
outlineOrSpine(contours, grid, hole, gap, idx, 'auto', true, rhythm, true)
const S = +(process.env.SC_SCALE ?? 10)
const W = (widthMm+10)*S, H = (+heightMm+30)*S
const COLORS = {corner:'#ff5555',edge:'#7f9cf5',patch:'#ffd700',loop:'#7f9cf5',line:'#00e0a0',spine:'#ff9d00',partspine:'#ff9d00',narrowspine:'#ff9d00',taper:'#e879f9',vectorline:'#00e0a0',rescue:'#ff3d9a'}
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#1b1f2a"/>`
for (const c of contours) svg += `<path d="M${c.map(p=>`${((p.x+5)*S).toFixed(1)},${((p.y+15)*S).toFixed(1)}`).join('L')}Z" fill="none" stroke="#556" stroke-width="1.5"/>`
for (const s of debugStones) svg += `<circle cx="${((s.x+5)*S).toFixed(1)}" cy="${((s.y+15)*S).toFixed(1)}" r="${(hole/2)*S}" fill="${COLORS[s.cat]??'#fff'}" fill-opacity="0.8"/>`
svg += '</svg>'
await writeFile(outPath, svg)
console.log('wrote', outPath, debugStones.length, 'stones', Math.round(widthMm), 'mm wide')
