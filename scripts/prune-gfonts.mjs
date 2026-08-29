// One-time catalog prune: drop fonts opentype.js cannot parse or shape.
// A font "works" only if BOTH its regular and bold files parse and can
// render a sample string through the same getPath call the app makes
// (Roboto v51 parses fine but throws in GSUB ccmp processing at getPath).
import { readFile, writeFile } from 'node:fs/promises'
import opentype from 'opentype.js'

// opentype.js lazily parses SVG-table color glyphs with DOMParser, which
// doesn't exist in Node; the browser handles those fine, so ignore the
// async rejection instead of letting it kill the run.
process.on('unhandledRejection', () => {})

const SAMPLE = 'GLEE glee Hello 0123'
const CATALOG = new URL('../public/gfonts.json', import.meta.url)

const fonts = JSON.parse(await readFile(CATALOG, 'utf8'))

// Mirrors getPathSafe in src/text.ts: getPath first, then the per-glyph
// GSUB-free fallback. A font is only "bad" if BOTH paths fail or the
// fallback yields no outlines at all.
async function urlWorks(url) {
  const res = await fetch(url)
  if (!res.ok) return false
  const buf = await res.arrayBuffer()
  const font = opentype.parse(buf)
  try {
    font.getPath(SAMPLE, 0, 0, 100, { kerning: true })
    return true
  } catch {
    let commands = 0
    for (const ch of SAMPLE) {
      const g = font.charToGlyph(ch)
      commands += g.getPath(0, 0, 100).commands.length
    }
    return commands > 0
  }
}

const bad = []
let done = 0
const queue = [...fonts]
const CONCURRENCY = 16
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const f = queue.shift()
      if (!f) return
      let ok = false
      try {
        ok = (await urlWorks(f.r)) && (!f.b || (await urlWorks(f.b)))
      } catch {
        ok = false
      }
      if (!ok) bad.push(f.id)
      done++
      if (done % 100 === 0) console.log(`${done}/${fonts.length} tested, ${bad.length} bad`)
    }
  }),
)

const badSet = new Set(bad)
const kept = fonts.filter((f) => !badSet.has(f.id))
await writeFile(CATALOG, JSON.stringify(kept))
console.log(`removed ${bad.length}: ${bad.sort().join(', ')}`)
console.log(`kept ${kept.length}/${fonts.length}`)
