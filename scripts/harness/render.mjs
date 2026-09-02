// Render trace result to SVG so a human (or Claude) can LOOK at it.
//   node scripts/harness/render.mjs <font.ttf> <text> <heightMm> <out.svg> [style]
import './canvas-stub.mjs'
import { readFile, writeFile } from 'node:fs/promises'
const [fontPath, text='GLEE', heightMm='50', outPath='/tmp/trace.svg', style='auto'] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours, debugStones, fillByGlyph } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours, widthMm } = textToContours(font, text, +heightMm, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(4.2)
const outline = outlineOrSpine(contours, grid, 3.4, 0.8, idx, style, true, 4.2, true)
let fillPts = []
if (process.env.SC_FILL) {
  const fHole = 2.5, fGap = 0.8
  const fIdx = new SpacingIndex(Math.max(fHole + fGap, (3.4 + fHole) / 2 + fGap), fGap, fHole / 2)
  for (const p of outline) fIdx.add(p, 3.4 / 2)
  fillPts = fillByGlyph(contours, fHole, fGap, fHole / 2 + 0.1, fIdx, outline, fHole + fGap, true)
}
const S = +(process.env.SC_SCALE ?? 8)
const W = (widthMm+10)*S, H = (+heightMm+16)*S
const COLORS = {corner:'#ff5555',edge:'#7f9cf5',patch:'#ffd700',loop:'#7f9cf5',line:'#00e0a0',spine:'#ff9d00',partspine:'#ff9d00',narrowspine:'#ff9d00',taper:'#e879f9',vectorline:'#00e0a0',rescue:'#ff3d9a'}
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#1b1f2a"/>`
for (const c of contours) {
  svg += `<path d="M${c.map(p=>`${((p.x+5)*S).toFixed(1)},${((p.y+8)*S).toFixed(1)}`).join('L')}Z" fill="none" stroke="#556" stroke-width="1.5"/>`
}
for (const s of debugStones) {
  svg += `<circle cx="${((s.x+5)*S).toFixed(1)}" cy="${((s.y+8)*S).toFixed(1)}" r="${1.7*S}" fill="${COLORS[s.cat]??'#fff'}" fill-opacity="0.75"/>`
}
for (const p of fillPts) svg += `<circle cx="${((p.x+5)*S).toFixed(1)}" cy="${((p.y+8)*S).toFixed(1)}" r="${1.25*S}" fill="#e05563" fill-opacity="0.85"/>`
svg += '</svg>'
await writeFile(outPath, svg)
console.log('wrote', outPath, debugStones.length, 'stones')
