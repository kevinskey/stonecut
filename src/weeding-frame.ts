import type { Job } from './export'

// Use the full design for registration across color/size templates, but keep
// the original job dimensions: exporters use them as the machine-origin datum.
export function withWeedingFrame(cutJob: Job, fullJob: Job, marginMm: number): Job {
  if (!cutJob.stones.length && !cutJob.paths?.some((p) => p.length)) return cutJob
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of fullJob.stones) {
    const r = (fullJob.sizes[s.size]?.holeMm ?? 3) / 2
    minX = Math.min(minX, s.x - r); minY = Math.min(minY, s.y - r)
    maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r)
  }
  for (const p of fullJob.paths ?? []) for (const q of p) {
    minX = Math.min(minX, q.x); minY = Math.min(minY, q.y)
    maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y)
  }
  if (!isFinite(minX)) return cutJob
  const m = Number.isFinite(marginMm) ? Math.max(1, marginMm) : 5
  const x0 = minX - m, y0 = minY - m, x1 = maxX + m, y1 = maxY + m
  return {
    ...cutJob,
    paths: [...(cutJob.paths ?? []), [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 },
      { x: x0, y: y1 }, { x: x0, y: y0 },
    ]],
  }
}

// Inspect the added frame against the unchanged job extent. Never enlarge
// the media silently or rely on the cutter clipping an oversized rectangle.
export function weedingFrameFits(job: Job): boolean {
  const frame = job.paths?.at(-1)
  if (!frame) return true
  return frame.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= -1e-6 && p.y >= -1e-6 && p.x <= job.widthMm + 1e-6 && p.y <= job.heightMm + 1e-6)
}
