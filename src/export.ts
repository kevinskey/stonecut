import type { MaterialPreset, Stone, StoneSpec } from './model'
import { orderNearestNeighbor } from './geometry'

export interface Job {
  stones: Stone[]
  sizes: Record<string, StoneSpec>
  widthMm: number
  heightMm: number
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${job.widthMm}mm" height="${job.heightMm}mm" viewBox="0 0 ${job.widthMm} ${job.heightMm}">
<g fill="none" stroke="#000" stroke-width="0.1">
${circles}
</g>
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
