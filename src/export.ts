import type { MaterialPreset, Pt, Stone, StoneSpec } from './model'
import { orderNearestNeighbor } from './geometry'

export interface Job {
  stones: Stone[]
  sizes: Record<string, StoneSpec>
  widthMm: number
  heightMm: number
  // vector cut lines (letter outlines etc.) cut alongside the stone holes
  paths?: Pt[][]
}

const holeOf = (job: Job, s: Stone) => (job.sizes[s.size]?.holeMm ?? 3) / 2

// ---------- SVG (for Cricut Design Space or anything else) ----------
export function toSVG(job: Job): string {
  const circles = job.stones
    .map(
      (s) =>
        `  <circle cx="${s.x.toFixed(3)}" cy="${s.y.toFixed(3)}" r="${holeOf(job, s).toFixed(3)}"/>`,
    )
    .join('\n')
  const paths = (job.paths ?? [])
    .filter((c) => c.length >= 2)
    .map(
      (c) =>
        `  <path d="M${c.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' L')} Z"/>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${job.widthMm}mm" height="${job.heightMm}mm" viewBox="0 0 ${job.widthMm} ${job.heightMm}">
<g fill="none" stroke="#000" stroke-width="0.1">
${circles}${paths ? '\n' + paths : ''}
</g>
</svg>
`
}

// ---------- Vinyl layer (solid letters for glitter vinyl / HTV) ----------
// Halo designs pair the stone template with the letters themselves cut from
// glitter vinyl. One even-odd path keeps counters (the hole in an "e") open.
// Exported at true mm size; Cricut Design Space reads the mm width/height.
export function contoursToVinylSVG(contours: Pt[][], marginMm = 5): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of contours)
    for (const p of c) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  if (!isFinite(minX)) return ''
  const w = (maxX - minX + marginMm * 2).toFixed(2)
  const h = (maxY - minY + marginMm * 2).toFixed(2)
  const d = contours
    .filter((c) => c.length >= 3)
    .map(
      (c) =>
        'M' +
        c
          .map((p) => `${(p.x - minX + marginMm).toFixed(2)} ${(p.y - minY + marginMm).toFixed(2)}`)
          .join(' L') +
        ' Z',
    )
    .join(' ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
<path d="${d}" fill="#000" fill-rule="evenodd"/>
</svg>
`
}

// ---------- HP-GL (.plt) for the CE6000 ----------
// CE6000 must have COMMAND set to HP-GL in the menu (default is GP-GL).
// HP-GL plotter units: 40 per mm. Circles cut as polygons, nearest-neighbor order.
export function toHPGL(job: Job, preset: MaterialPreset): string {
  const U = 40
  const ordered = orderNearestNeighbor(job.stones)
  const lines: string[] = ['IN;', `FS${preset.force};`, `VS${preset.speed};`, 'SP1;']
  for (let pass = 0; pass < preset.passes; pass++) {
    for (const s of ordered) {
      const r = holeOf(job, s)
      const n = r < 1.6 ? 12 : r < 3 ? 16 : 24
      // flip Y: HP-GL origin is bottom-left, our model is top-left
      const cy = job.heightMm - s.y
      const pts: string[] = []
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.round((s.x + r * Math.cos(a)) * U)
        const y = Math.round((cy + r * Math.sin(a)) * U)
        pts.push(`${x},${y}`)
      }
      lines.push(`PU${pts[0]};`)
      lines.push(`PD${pts.slice(1).join(',')};`)
    }
  }
  // vector cut lines after the holes, one pass per preset pass
  for (let pass = 0; pass < preset.passes; pass++) {
    for (const c of job.paths ?? []) {
      if (c.length < 2) continue
      const pts = c.map((p) => `${Math.round(p.x * U)},${Math.round((job.heightMm - p.y) * U)}`)
      lines.push(`PU${pts[0]};`)
      lines.push(`PD${pts.slice(1).join(',')},${pts[0]};`)
    }
  }
  lines.push('PU0,0;', 'SP0;', 'IN;')
  return lines.join('\n') + '\n'
}

// ---------- GP-GL for the CE6000 (factory default COMMAND mode) ----------
// GP-GL units: 20 per mm (0.05mm step, the CE6000 default). M = move, D = draw.
export function toGPGL(job: Job, preset: MaterialPreset): string {
  const U = 20
  const ordered = orderNearestNeighbor(job.stones)
  const cmds: string[] = ['H', `!${preset.speed}`, `FX${preset.force}`]
  for (let pass = 0; pass < preset.passes; pass++) {
    for (const s of ordered) {
      const r = holeOf(job, s)
      const n = r < 1.6 ? 12 : r < 3 ? 16 : 24
      const cy = job.heightMm - s.y
      const pt = (i: number) => {
        const a = (i / n) * Math.PI * 2
        return `${Math.round((s.x + r * Math.cos(a)) * U)},${Math.round((cy + r * Math.sin(a)) * U)}`
      }
      cmds.push(`M${pt(0)}`)
      for (let i = 1; i <= n; i++) cmds.push(`D${pt(i)}`)
    }
  }
  for (let pass = 0; pass < preset.passes; pass++) {
    for (const c of job.paths ?? []) {
      if (c.length < 2) continue
      const P = (p: Pt) => `${Math.round(p.x * U)},${Math.round((job.heightMm - p.y) * U)}`
      cmds.push(`M${P(c[0])}`)
      for (let i = 1; i < c.length; i++) cmds.push(`D${P(c[i])}`)
      cmds.push(`D${P(c[0])}`)
    }
  }
  cmds.push('M0,0')
  return cmds.join('\x03') + '\x03'
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
