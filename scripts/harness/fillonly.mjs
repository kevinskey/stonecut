// Replicates App contoursToStones mode='fill' (Solid fill only), wholeWord text.
//   node fillonly.mjs <font> <text> <H> <holeOutline> <fillHole> <gap> <fillStyle> <out.svg>
import './canvas-stub.mjs'
import { readFile, writeFile } from 'node:fs/promises'
const [fontPath, text, heightMm, holeA, fillHoleA, gapA, fillStyle, outPath] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, fillByGlyph } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const H = +heightMm, hole = +holeA, fHole = +fillHoleA, gap = +gapA
const hardGap = Math.max(0.5, Math.min(gap, 1.2))
const { contours, widthMm } = textToContours(font, text, H, 2)
const fGap = hardGap
const fRhythm = fHole + fGap
const fInset = fHole / 2 + 0.1
const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
const t0 = performance.now()
const f = fillByGlyph(contours, fHole, fGap, fInset, fIdx, [], fRhythm, fillStyle, hole)
console.log(JSON.stringify({ text, H, fHole, stones: f.length, ms: Math.round(performance.now()-t0) }))
const S = 8, W = (widthMm+10)*S, Ht = (H+16)*S
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}"><rect width="100%" height="100%" fill="#1b1f2a"/>`
for (const c of contours) svg += `<path d="M${c.map(p=>`${((p.x+5)*S).toFixed(1)},${((p.y+8)*S).toFixed(1)}`).join('L')}Z" fill="none" stroke="#556" stroke-width="1.5"/>`
for (const p of f) svg += `<circle cx="${((p.x+5)*S).toFixed(1)}" cy="${((p.y+8)*S).toFixed(1)}" r="${fHole/2*S}" fill="#9fc3d9" fill-opacity="0.85"/>`
svg += '</svg>'
await writeFile(outPath, svg)
