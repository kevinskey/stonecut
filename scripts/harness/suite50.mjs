// 50 tracing tests, script-heavy: rank how close each trace sits to its
// original vector. Tune against the whole matrix, never one font.
//   node scripts/harness/suite50.mjs [--json out.json]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const run = promisify(execFile)
const FDIR = '/private/tmp/claude-501/-Users-kevinjohnson/56d6785b-4dd5-4eb1-afcf-c22765c57f8d/scratchpad/fonts'

const SCRIPT = ['Dancing_Script','Great_Vibes','Pacifico','Satisfy','Yellowtail','Kaushan_Script',
 'Sacramento','Allura','Cookie','Italianno','Berkshire_Swash','Tangerine','Pinyon_Script',
 'Courgette','Parisienne','Alex_Brush','Marck_Script','Damion','Norican','Lobster']
const HAND = ['Caveat','Shadows_Into_Light','Amatic_SC','Permanent_Marker']
const DISPLAY = ['Playfair_Display','Google_Sans','Anton','Montserrat','Oswald','Roboto']

const tests = []
for (const f of SCRIPT) {
  tests.push([f, 'Glee'])
  tests.push([f, 'hello'])
}
for (const f of HAND) tests.push([f, 'Glee'])
for (const f of DISPLAY) tests.push([f, 'GLEE'])
// 20*2 + 4 + 6 = 50

const results = []
const CONC = 6
let i = 0
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const t = tests[i++]
      if (!t) return
      const [f, word] = t
      try {
        const { stdout } = await run(
          process.execPath,
          ['scripts/harness/trace.mjs', join(FDIR, f + '.ttf'), word, '50', '3.4', '0.8', 'auto'],
          { timeout: 60000 },
        )
        results.push(JSON.parse(stdout.trim().split('\n').pop()))
      } catch (e) {
        results.push({ font: f, text: word, error: String(e.message ?? e).slice(0, 80) })
      }
    }
  }),
)

const ok = results.filter((r) => !r.error)
const errs = results.filter((r) => r.error)
// score: vector drift dominates (the question is "closer to the vector?"),
// legality and coverage still hard-count
for (const r of ok)
  r.score = +(r.vecP90 * 2 + r.vecMax * 0.5 + r.floorViol * 10 + r.bareRuns * 3 +
    Math.max(0, r.gapP90 / 4.2 - 1.15) * 10 + r.spineCtrP90).toFixed(2)
ok.sort((a, b) => b.score - a.score)
const mean = (k) => (ok.reduce((s, r) => s + r[k], 0) / ok.length).toFixed(2)
console.log(`tests: ${ok.length} ok, ${errs.length} err`)
console.log(`MEANS  vecP50 ${mean('vecP50')}  vecP90 ${mean('vecP90')}  vecMax ${mean('vecMax')}  floorViol ${mean('floorViol')}  bare ${mean('bareRuns')}  gapP90 ${mean('gapP90')}`)
console.log('font/word'.padEnd(30), 'score', 'vP50', 'vP90', 'vMax', 'viol', 'bare', 'gP90', 'spine')
for (const r of ok)
  console.log(
    `${r.font.replace('.ttf', '')}/${r.text}`.padEnd(30),
    String(r.score).padStart(6), String(r.vecP50).padStart(5), String(r.vecP90).padStart(5),
    String(r.vecMax).padStart(5), String(r.floorViol).padStart(4), String(r.bareRuns).padStart(4),
    String(r.gapP50).padStart(5), String(r.spineCtrP90).padStart(5),
  )
for (const r of errs) console.log('ERR', r.font, r.text, r.error)
const outIdx = process.argv.indexOf('--json')
if (outIdx > 0) await writeFile(process.argv[outIdx + 1], JSON.stringify(results, null, 1))
