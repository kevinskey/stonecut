// Render one glyph across many fonts into a single SVG grid.
import './canvas-stub.mjs'
import { readFile, writeFile, readdir } from 'node:fs/promises'
const [dir, text='G', hMm='45', outPath='dist/lineup.svg'] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const S=4, cw=260, ch=260
const names=(await readdir(dir)).filter(f=>/\.(ttf|otf)$/i.test(f))
let svg=''
let i=0
for (const n of names) {
  try {
    const font = opentype.parse((await readFile(dir+'/'+n)).buffer)
    const { contours } = textToContours(font, text, +hMm, 2)
    const ox=(i%6)*cw+20, oy=Math.floor(i/6)*ch+20
    svg += `<text x="${ox}" y="${oy-5}" fill="#aaa" font-size="12">${n.replace('.ttf','')}</text>`
    for (const c of contours) svg += `<path d="M${c.map(p=>`${(ox+p.x*S).toFixed(1)},${(oy+p.y*S).toFixed(1)}`).join('L')}Z" fill="none" stroke="#8899cc" stroke-width="1.5"/>`
    i++
  } catch {}
}
const W=6*cw+40, H=(Math.ceil(i/6))*ch+40
await writeFile(outPath, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#1b1f2a"/>`+svg+'</svg>')
console.log('wrote', outPath, i, 'fonts')
