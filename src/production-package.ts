import type { Job } from './export'
import { toSVG, stoneBom, workOrderHtml, placementGuideHtml } from './export'
import type { Stone } from './model'
import { renderPreviewPng } from './publish'
import { preflight } from './preflight'

export async function productionPackage(job: Job, projectJson: string, name: string, colorOf: (s: Stone) => string): Promise<Uint8Array> {
  const issues = preflight(job)
  if (issues.length) throw new Error(issues.join(' '))
  const { zipSync, strToU8 } = await import('fflate')
  const bom = stoneBom(job.stones, job.sizes, colorOf)
  const files: Record<string, Uint8Array> = {
    'design.stonecut': strToU8(projectJson),
    'templates/all.svg': strToU8(toSVG(job)),
    'manifest.json': strToU8(JSON.stringify({ name, units: 'mm', widthMm: job.widthMm, heightMm: job.heightMm, stoneBom: bom, createdAt: new Date().toISOString(), scope: 'Whole design; shared template frame' }, null, 2)),
    'work-order.html': strToU8(workOrderHtml(job, bom, colorOf, { title: name, boardLabel: `${job.widthMm} × ${job.heightMm} mm`, material: 'See saved project cutter profile' })),
    'placement-guide.html': strToU8(placementGuideHtml(job, colorOf, name)),
  }
  const colors = [...new Set(job.stones.map(colorOf))]
  for (const [i, color] of colors.entries()) files[`templates/color-${i+1}.svg`] = strToU8(toSVG({ ...job, stones: job.stones.filter((s) => colorOf(s) === color), paths: [] }))
  if (job.paths?.length) files['templates/lines.svg'] = strToU8(toSVG({ ...job, stones: [] }))
  if (job.stones.length) {
    const preview = renderPreviewPng(job.stones, job.sizes, colorOf)
    const bytes = atob(preview.dataUrl.split(',')[1])
    files['preview.png'] = Uint8Array.from(bytes, (c) => c.charCodeAt(0))
  }
  return zipSync(files)
}
