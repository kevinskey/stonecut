import type { Job, CutOpts, OriginCorner } from './export'
import { toGPGL, toHPGL } from './export'
import type { MaterialPreset } from './model'

export interface CutConfirmation {
  title: string
  data: string
  rows: [string, string][]
  warnings: string[]
  origin: OriginCorner
  device: string | null
}

// Serialize and describe the exact same job before awaiting any device lookup.
// Subsequent edits cannot change the bytes the operator is approving.
export function makeCutConfirmation(job: Job, settings: {
  format: 'gpgl' | 'hpgl'
  preset: MaterialPreset
  origin: OriginCorner
  unitsPerMm: number
  sendConditions: boolean
  swapAxes: boolean
  cutOpts: CutOpts
  scope: string
  warnings: string[]
}): CutConfirmation {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of job.stones) {
    const r = (job.sizes[s.size]?.holeMm ?? 3) / 2
    minX = Math.min(minX, s.x - r); minY = Math.min(minY, s.y - r)
    maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r)
  }
  for (const p of job.paths ?? []) for (const q of p) {
    minX = Math.min(minX, q.x); minY = Math.min(minY, q.y)
    maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y)
  }
  if (!Number.isFinite(minX)) throw new Error('Nothing to cut')
  const conditions = settings.format === 'hpgl' || settings.sendConditions
  const material = (p: MaterialPreset) => `${p.name} · ${p.passes} pass(es) · ${conditions ? `force ${p.force}, speed ${p.speed}` : 'panel force/speed'}`
  const rows: [string, string][] = [
    ['Scope', settings.scope],
    ['Geometry', `${job.stones.length} stones · ${job.paths?.length ?? 0} cut paths`],
    ['Cut size', `${((maxX - minX) / 25.4).toFixed(2)}″ × ${((maxY - minY) / 25.4).toFixed(2)}″ (${(maxX - minX).toFixed(2)} × ${(maxY - minY).toFixed(2)} mm)`],
    ['Job area', `${job.widthMm.toFixed(2)} × ${job.heightMm.toFixed(2)} mm`],
    ['From origin', `${((settings.origin === 'br' ? job.widthMm - maxX : minX) / 25.4).toFixed(2)}″ across, ${((job.heightMm - maxY) / 25.4).toFixed(2)}″ up`],
    ['Command mode', settings.format === 'gpgl' ? 'GP-GL' : 'HP-GL'],
    ['Origin', settings.origin === 'br' ? 'Lower-right' : 'Lower-left'],
  ]
  if (settings.format === 'gpgl') rows.push(
    ['Step size', `${(1 / settings.unitsPerMm).toFixed(3)} mm — must match the cutter`],
    ['Swap axes', settings.swapAxes ? 'On' : 'Off'],
    ['Circles', settings.cutOpts.firmwareCircles ? 'Firmware arcs' : 'Polygons'],
  )
  rows.push(['Overcut', `${settings.cutOpts.overcutMm ?? 0} mm`])
  if (job.stones.length) rows.push(['Holes material', material(settings.preset)])
  if (job.paths?.length) rows.push(['Lines material', material(settings.cutOpts.linePreset ?? settings.preset)])
  return {
    title: 'Cut on Graphtec',
    data: settings.format === 'gpgl'
      ? toGPGL(job, settings.preset, settings.origin, settings.unitsPerMm, settings.sendConditions, settings.swapAxes, settings.cutOpts)
      : toHPGL(job, settings.preset, settings.origin, settings.cutOpts),
    rows,
    warnings: [...settings.warnings],
    origin: settings.origin,
    device: null,
  }
}
