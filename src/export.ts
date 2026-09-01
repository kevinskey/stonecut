import type { MaterialPreset, Stone, StoneSpec } from './model'
import { orderNearestNeighbor } from './geometry'

export interface Job {
  stones: Stone[]
  sizes: Record<string, StoneSpec>
  widthMm: number
  heightMm: number
}

const holeOf = (job: Job, s: Stone) => (job.sizes[s.size]?.holeMm ?? 3) / 2

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
export function toHPGL(job: Job, preset: MaterialPreset, origin: OriginCorner = 'bl'): string {
  const U = 40
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
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.round((cx + r * Math.cos(a)) * U)
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
): string {
  const U = unitsPerMm
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
  // Default: send NO conditions at all — geometry only. The CE6000 ignores
  // program conditions unless TOOLS SETTING -> CONDITION PRIORITY is PROGRAM,
  // so the panel is normally the source of truth, and a malformed condition
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
      // Graphtec's first coordinate is the media-feed axis, which is not
      // necessarily the model's X. swapAxes emits (feed, carriage) instead.
      const pt = (i: number) => {
        const a = (i / n) * Math.PI * 2
        const px = Math.round((cx + r * Math.cos(a)) * U)
        const py = Math.round((cy + r * Math.sin(a)) * U)
        return swapAxes ? `${py},${px}` : `${px},${py}`
      }
      cmds.push(`M${pt(0)}`)
      for (let i = 1; i <= n; i++) cmds.push(`D${pt(i)}`)
    }
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

export function download(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
