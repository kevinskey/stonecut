import type { MaterialPreset, Pt, Stone, StoneSpec } from './model'
import { orderNearestNeighbor } from './geometry'

export interface Job {
  stones: Stone[]
  sizes: Record<string, StoneSpec>
  widthMm: number
  heightMm: number
  // Vector cut lines (mm polylines in the same frame as the stones). Cut
  // AFTER the holes so the sheet stays anchored while the small circles go.
  paths?: Pt[][]
}

const holeOf = (job: Job, s: Stone) => (job.sizes[s.size]?.holeMm ?? 3) / 2

export interface CutOpts {
  // Cut holes with the firmware's W (CIRCLE) arc command — one command per
  // hole, interpolated by the machine (truly round, ~20x less data) —
  // instead of a 12-24 segment polygon. GP-GL only.
  firmwareCircles?: boolean
  // Continue each hole this far past its closing point. A drag knife's
  // swivel leaves a tiny uncut tag where a closed path ends; the overcut
  // recuts the first bit of the circle so small holes weed cleanly.
  overcutMm?: number
}

// Extra polygon segments to recut `over` mm past closure (capped at one lap).
const overcutSegs = (over: number, r: number, n: number) =>
  over > 0 ? Math.min(n, Math.ceil(over / ((2 * Math.PI * r) / n))) : 0

// Which corner of the material the machine's (0,0) sits at. Graphtec carriages
// home to the RIGHT, so a CE6000 with ORIGIN set at the right edge needs X
// mirrored — otherwise distance from the page's LEFT edge becomes feed
// distance and art parked on the right edge feeds the whole sheet to reach it.
export type OriginCorner = 'bl' | 'br'

// Mirror about the job's own width, so the design's right edge maps to X=0.
const mapX = (job: Job, origin: OriginCorner, x: number) =>
  origin === 'br' ? job.widthMm - x : x

// ---------- SVG (for Cricut Design Space or anything else) ----------
export function toSVG(job: Job): string {
  const circles = job.stones
    .map(
      (s) =>
        `  <circle cx="${s.x.toFixed(3)}" cy="${s.y.toFixed(3)}" r="${holeOf(job, s).toFixed(3)}"/>`,
    )
    .join('\n')
  const lines = (job.paths ?? [])
    .map((p) => `  <path d="M${p.map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).join('L')}"/>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${job.widthMm}mm" height="${job.heightMm}mm" viewBox="0 0 ${job.widthMm} ${job.heightMm}">
<g fill="none" stroke="#000" stroke-width="0.1">
${circles}
${lines}
</g>
</svg>
`
}

// ---------- HP-GL (.plt) for the CE6000 ----------
// CE6000 must have COMMAND set to HP-GL in the menu (default is GP-GL).
// HP-GL plotter units: 40 per mm. Circles cut as polygons, nearest-neighbor order.
export function toHPGL(job: Job, preset: MaterialPreset, origin: OriginCorner = 'bl', opts: CutOpts = {}): string {
  const U = 40
  const over = Math.max(0, opts.overcutMm ?? 0)
  // start from whichever model corner maps to the machine's (0,0)
  const ordered = orderNearestNeighbor(job.stones, {
    x: origin === 'br' ? job.widthMm : 0,
    y: job.heightMm,
  })
  const lines: string[] = ['IN;', `FS${preset.force};`, `VS${preset.speed};`, 'SP1;']
  for (let pass = 0; pass < preset.passes; pass++) {
    for (const s of ordered) {
      const r = holeOf(job, s)
      const n = r < 1.6 ? 12 : r < 3 ? 16 : 24
      // flip Y: HP-GL origin is bottom-left, our model is top-left
      const cy = job.heightMm - s.y
      // a mirrored circle is still a circle, so only the centre needs mapping
      const cx = mapX(job, origin, s.x)
      const pts: string[] = []
      // i past n laps into the overcut: cos/sin wrap, recutting the start
      for (let i = 0; i <= n + overcutSegs(over, r, n); i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.round((cx + r * Math.cos(a)) * U)
        const y = Math.round((cy + r * Math.sin(a)) * U)
        pts.push(`${x},${y}`)
      }
      lines.push(`PU${pts[0]};`)
      lines.push(`PD${pts.slice(1).join(',')};`)
    }
  }
  for (const p of job.paths ?? []) {
    const pts = p.map((q) => `${Math.round(mapX(job, origin, q.x) * U)},${Math.round((job.heightMm - q.y) * U)}`)
    lines.push(`PU${pts[0]};`)
    lines.push(`PD${pts.slice(1).join(',')};`)
  }
  lines.push('PU0,0;', 'SP0;', 'IN;')
  return lines.join('\n') + '\n'
}

// ---------- GP-GL for the CE6000 (factory default COMMAND mode) ----------
// M = move, D = draw. Units per mm MUST match the machine's GP-GL STEP SIZE
// (MENU -> I/F -> STEP SIZE); a mismatch scales the whole job silently —
// 0.1mm step read as 0.05mm plots everything at double size.
//   0.100mm =  254 steps/in ->  10 units/mm
//   0.050mm =  508 steps/in ->  20 units/mm  (long-standing default here)
//   0.025mm = 1016 steps/in ->  40 units/mm
//   0.010mm = 2540 steps/in -> 100 units/mm
export function toGPGL(
  job: Job,
  preset: MaterialPreset,
  origin: OriginCorner = 'bl',
  unitsPerMm = 20,
  sendConditions = false,
  swapAxes = false,
  opts: CutOpts = {},
): string {
  const U = unitsPerMm
  const over = Math.max(0, opts.overcutMm ?? 0)
  // start from whichever model corner maps to the machine's (0,0)
  const ordered = orderNearestNeighbor(job.stones, {
    x: origin === 'br' ? job.widthMm : 0,
    y: job.heightMm,
  })
  // NO leading 'H' (GP-GL Home). Home drives the machine back to its
  // mechanical origin before cutting — throwing away the ORIGIN the operator
  // set on the panel, and scrolling back however much media has been fed.
  // That showed up as a long pre-cut scroll that grew with every job run.
  // ONLY documented GP-GL commands here. Two prior entries were wrong:
  //   'H'      = Home. Drove back to mechanical home, discarding the operator's
  //              ORIGIN and scrolling back all fed media.
  //   'FX<n>'  = NOT GP-GL. It is a Silhouette Studio extension. A real
  //              Graphtec parses the leading 'F' as CHART FEED (syntax Fl[t])
  //              and advances the media by the remaining digits — a media feed
  //              at the head of every single job.
  // Per the Graphtec GP-GL reference: speed is '!l', force/acceleration is
  // '*a,f'. Acceleration 2 is a safe mid-range default for a cutting head.
  // Conditions are sent by default (App.tsx). The CE6000 ignores
  // program conditions unless TOOLS SETTING -> CONDITION PRIORITY is PROGRAM,
  // in which case the panel is the source of truth. The toggle stays because a malformed condition
  // command is far more dangerous than a missing one.
  const cmds: string[] = sendConditions
    ? [`!${preset.speed}`, `*2,${preset.force}`]
    : []
  for (let pass = 0; pass < preset.passes; pass++) {
    for (const s of ordered) {
      const r = holeOf(job, s)
      const n = r < 1.6 ? 12 : r < 3 ? 16 : 24
      const cy = job.heightMm - s.y
      const cx = mapX(job, origin, s.x)
      if (opts.firmwareCircles) {
        // W (CIRCLE): Wx0,y0,r1,r2,θ1,θ2 — the machine interpolates the arc
        // itself: one command per hole instead of 13-25, truly round cut.
        // Explicit M to the arc's 0° start first: the plotter has a menu
        // setting for whether W travels to the arc start pen-up or pen-down,
        // and starting from the arc start makes either setting safe.
        const c1 = Math.round((swapAxes ? cy : cx) * U)
        const c2 = Math.round((swapAxes ? cx : cy) * U)
        const ru = Math.max(1, Math.round(r * U))
        cmds.push(`M${c1 + ru},${c2}`)
        cmds.push(`W${c1},${c2},${ru},${ru},0,360`)
        if (over > 0) {
          // overcut as a second short arc retracing the circle's first
          // degrees — safer than relying on the firmware accepting θ2 > 360
          const deg = Math.min(90, Math.ceil((over / r) * (180 / Math.PI)))
          cmds.push(`W${c1},${c2},${ru},${ru},0,${deg}`)
        }
        continue
      }
      // Graphtec's first coordinate is the media-feed axis, which is not
      // necessarily the model's X. swapAxes emits (feed, carriage) instead.
      const pt = (i: number) => {
        const a = (i / n) * Math.PI * 2
        const px = Math.round((cx + r * Math.cos(a)) * U)
        const py = Math.round((cy + r * Math.sin(a)) * U)
        return swapAxes ? `${py},${px}` : `${px},${py}`
      }
      cmds.push(`M${pt(0)}`)
      // i past n laps into the overcut, recutting the start of the circle
      for (let i = 1; i <= n + overcutSegs(over, r, n); i++) cmds.push(`D${pt(i)}`)
    }
  }
  for (const p of job.paths ?? []) {
    const enc = (q: Pt) => {
      const px = Math.round(mapX(job, origin, q.x) * U)
      const py = Math.round((job.heightMm - q.y) * U)
      return swapAxes ? `${py},${px}` : `${px},${py}`
    }
    cmds.push(`M${enc(p[0])}`)
    for (let i = 1; i < p.length; i++) cmds.push(`D${enc(p[i])}`)
  }
  cmds.push('M0,0')
  return cmds.join('\x03') + '\x03'
}

// Absolute-minimum GP-GL: one small square near the origin. No speed/force,
// no home, no trailing M0,0 — nothing but positioning and drawing. If the
// machine still scrolls on this, the cause is outside the data stream.
export function gpglTestShape(unitsPerMm = 20, offsetMm = 2, swapAxes = false): string {
  // An L, not a square. A square looks identical rotated or mirrored, so it
  // cannot tell you which axis is which or whether the job comes out reversed.
  // Tall bar runs 20mm, foot runs 10mm — both directions readable at a glance.
  const shape: [number, number][] = [
    [0, 0], [10, 0], [10, 5], [5, 5], [5, 20], [0, 20], [0, 0],
  ]
  const enc = ([a, b]: [number, number]) => {
    const x = Math.round((a + offsetMm) * unitsPerMm)
    const y = Math.round((b + offsetMm) * unitsPerMm)
    return swapAxes ? `${y},${x}` : `${x},${y}`
  }
  return shape
    .map((p, i) => (i === 0 ? `M${enc(p)}` : `D${enc(p)}`))
    .join('\x03') + '\x03'
}

// ---------- DXF (R12) for laser cutters and other machine software ----------
// Holes as true CIRCLE entities on layer HOLES, cut lines as POLYLINE on
// layer LINES. R12 ASCII with an ENTITIES-only body — the most widely
// accepted dialect (LWPOLYLINE is R13+ and some laser tools choke on it).
// DXF is Y-up; the model is Y-down, so Y flips against the job height.
// Units are implicitly mm — tell the receiving software "millimetres" if
// it asks, exactly like the SVG export.
export function toDXF(job: Job): string {
  const H = job.heightMm
  const f = (v: number) => v.toFixed(3)
  const L: string[] = ['0', 'SECTION', '2', 'ENTITIES']
  for (const s of job.stones) {
    L.push('0', 'CIRCLE', '8', 'HOLES', '10', f(s.x), '20', f(H - s.y), '30', '0', '40', f(holeOf(job, s)))
  }
  for (const p of job.paths ?? []) {
    if (p.length < 2) continue
    const a = p[0], b = p[p.length - 1]
    const closed = p.length > 2 && Math.hypot(a.x - b.x, a.y - b.y) < 0.01
    const pts = closed ? p.slice(0, -1) : p
    L.push('0', 'POLYLINE', '8', 'LINES', '66', '1', '70', closed ? '1' : '0')
    for (const q of pts) L.push('0', 'VERTEX', '8', 'LINES', '10', f(q.x), '20', f(H - q.y), '30', '0')
    L.push('0', 'SEQEND')
  }
  L.push('0', 'ENDSEC', '0', 'EOF')
  return L.join('\r\n') + '\r\n'
}

// ---------- stone counts (bill of materials) ----------
export interface BomRow {
  size: string
  color: string // display hex
  holeMm: number
  stoneMm: number
  n: number
}

// Count stones by (size, colour). `colorOf` resolves a stone's display
// colour the same way the canvas does (layer default when unset), so the
// counts match what the operator sees.
export function stoneBom(
  stones: Stone[],
  sizes: Record<string, StoneSpec>,
  colorOf: (s: Stone) => string,
): BomRow[] {
  const m = new Map<string, BomRow>()
  for (const s of stones) {
    const color = colorOf(s)
    const key = `${s.size}|${color}`
    const row = m.get(key)
    if (row) row.n++
    else m.set(key, { size: s.size, color, holeMm: sizes[s.size]?.holeMm ?? 3, stoneMm: sizes[s.size]?.stoneMm ?? 0, n: 1 })
  }
  return [...m.values()].sort((a, b) => b.stoneMm - a.stoneMm || a.color.localeCompare(b.color))
}

// Printable work order: counts with order quantities (+10% for spills and
// culls), the design at a glance, and the cut facts the operator needs.
export function workOrderHtml(
  job: Job,
  bom: BomRow[],
  colorOf: (s: Stone) => string,
  meta: { title: string; boardLabel: string; material: string },
): string {
  const total = bom.reduce((t, r) => t + r.n, 0)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of job.stones) {
    const r = holeOf(job, s)
    minX = Math.min(minX, s.x - r); minY = Math.min(minY, s.y - r)
    maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r)
  }
  for (const p of job.paths ?? []) for (const q of p) {
    minX = Math.min(minX, q.x); minY = Math.min(minY, q.y)
    maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y)
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1 }
  const w = maxX - minX, h = maxY - minY
  const circles = job.stones
    .map((s) => `<circle cx="${(s.x - minX).toFixed(2)}" cy="${(s.y - minY).toFixed(2)}" r="${holeOf(job, s).toFixed(2)}" fill="${colorOf(s)}"/>`)
    .join('')
  const lines = (job.paths ?? [])
    .map((p) => `<path d="M${p.map((q) => `${(q.x - minX).toFixed(2)},${(q.y - minY).toFixed(2)}`).join('L')}" fill="none" stroke="#333" stroke-width="0.3"/>`)
    .join('')
  const rows = bom
    .map(
      (r) => `<tr>
  <td><span class="sw" style="background:${r.color}"></span>${r.color}</td>
  <td>${r.size}</td>
  <td>${r.stoneMm ? r.stoneMm.toFixed(1) : '—'} mm</td>
  <td>${r.holeMm.toFixed(1)} mm</td>
  <td class="n">${r.n}</td>
  <td class="n">${Math.ceil(r.n * 1.1)}</td>
</tr>`,
    )
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${meta.title}</title>
<style>
  body { font: 13px/1.45 -apple-system, Segoe UI, sans-serif; color: #111; margin: 28px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #555; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; max-width: 640px; margin: 10px 0 18px; }
  th, td { border: 1px solid #bbb; padding: 5px 9px; text-align: left; }
  th { background: #f0f0f0; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .sw { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 1px solid #888; margin-right: 7px; vertical-align: -1px; }
  .preview { max-width: 640px; border: 1px solid #ccc; padding: 8px; background: #fff; }
  .preview svg { width: 100%; height: auto; display: block; }
  .facts td { border: none; padding: 1px 18px 1px 0; color: #333; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<h1>StoneCut work order</h1>
<p class="sub">${meta.title} · ${new Date().toLocaleString()}</p>
<table class="facts"><tbody>
<tr><td>Design size</td><td><b>${(w / 25.4).toFixed(2)}″ × ${(h / 25.4).toFixed(2)}″</b> (${w.toFixed(0)} × ${h.toFixed(0)} mm)</td></tr>
<tr><td>Media</td><td>${meta.boardLabel}</td></tr>
<tr><td>Material</td><td>${meta.material}</td></tr>
<tr><td>Holes</td><td><b>${total}</b>${(job.paths?.length ?? 0) ? ` + ${job.paths!.length} cut line${job.paths!.length === 1 ? '' : 's'}` : ''}</td></tr>
</tbody></table>
<table>
<thead><tr><th>Color</th><th>Size</th><th>Stone ⌀</th><th>Hole ⌀</th><th class="n">Holes</th><th class="n">Order (+10%)</th></tr></thead>
<tbody>
${rows}
<tr><th colspan="4">Total</th><th class="n">${total}</th><th class="n">${Math.ceil(total * 1.1)}</th></tr>
</tbody>
</table>
<div class="preview"><svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">${circles}${lines}</svg></div>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 150))</script>
</body></html>`
}

export function download(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
