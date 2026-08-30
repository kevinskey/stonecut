// Population-level placement quality: run the harness over EVERY font in
// the given directories, aggregate, and rank. Principles get tuned against
// the whole population, never one font at a time — a change must improve
// the ranking without regressing fonts that were already clean.
//
//   node scripts/harness/suite.mjs [dir ...]        (default: ~/Library/Fonts, ~/Desktop/fonts)
//
// Score per font (lower is better):
//   floorViol * 10   — illegal stones are never acceptable
//   bareRuns  * 3    — visible holes in the lettering
//   max(0, gapP90/rhythm - 1.15) * 10  — ragged spacing
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [join(homedir(), 'Library/Fonts'), join(homedir(), 'Desktop/fonts')]

const files = []
for (const d of dirs) {
  try {
    for (const f of await readdir(d)) if (/\.(ttf|otf)$/i.test(f)) files.push(join(d, f))
  } catch { /* dir absent */ }
}
console.error(`${files.length} fonts`)

const rhythm = 3.4 + 0.8
const results = []
const CONC = 6
let i = 0
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const f = files[i++]
      if (!f) return
      try {
        const { stdout } = await run(
          process.execPath,
          ['scripts/harness/run.mjs', f, 'GLEE', '50', '3.4', '0.8', 'auto'],
          { timeout: 30000 },
        )
        const j = JSON.parse(stdout)
        j.score =
          j.floorViol * 10 +
          j.bareRuns * 3 +
          Math.max(0, j.gapP90 / rhythm - 1.15) * 10
        results.push(j)
      } catch (e) {
        results.push({ font: f.split('/').pop(), error: String(e.message ?? e).slice(0, 60), score: -1 })
      }
    }
  }),
)

results.sort((a, b) => b.score - a.score)
const clean = results.filter((r) => r.score === 0).length
const errs = results.filter((r) => r.score === -1)
console.log(`clean: ${clean}/${results.length}   errors: ${errs.length}`)
console.log('font'.padEnd(38), 'score', 'stones', 'viol', 'bare', 'gapP90', 'bareMax')
for (const r of results) {
  if (r.score <= 0) continue
  console.log(
    String(r.font).padEnd(38),
    r.score.toFixed(1).padStart(5),
    String(r.stones).padStart(6),
    String(r.floorViol).padStart(4),
    String(r.bareRuns).padStart(4),
    String(r.gapP90).padStart(6),
    String(r.bareMaxBeats).padStart(7),
  )
}
for (const r of errs) console.log('ERR', r.font, r.error)
