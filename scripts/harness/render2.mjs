// Parameterized render: node render2.mjs <font> <text> <H> <hole> <gap> <style> <out.svg>
import './canvas-stub.mjs'
import { readFile, writeFile } from 'node:fs/promises'
const [fontPath, text, heightMm, hole, gap, style, outPath] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, outlineOrSpine, rasterizeContours } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const H = +heightMm, HO = +hole, G = +gap, pitch = HO + G
const { contours, widthMm } = textToContours(font, text, H, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(pitch)
const outline = outlineOrSpine(contours, grid, HO, G, idx, style, true, pitch, true)
const S = 6
const W = (widthMm+10)*S, Ht = (H+16)*S
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}"><rect width="100%" height="100%" fill="#1b1f2a"/>`
for (const c of contours) svg += `<path d="M${c.map(p=>`${((p.x+5)*S).toFixed(1)},${((p.y+8)*S).toFixed(1)}`).join('L')}Z" fill="none" stroke="#556" stroke-width="1.5"/>`
for (const p of outline) svg += `<circle cx="${((p.x+5)*S).toFixed(1)}" cy="${((p.y+8)*S).toFixed(1)}" r="${HO/2*S}" fill="#9fc3d9" fill-opacity="0.85"/>`
svg += '</svg>'
await writeFile(outPath, svg)
console.log('wrote', outPath, outline.length, 'stones')
