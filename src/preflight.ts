import type { Job } from './export'
import type { MaterialPreset } from './model'
import { findOverlaps } from './geometry'

export function preflight(job: Job, gapMm = 0.5): string[] {
  const issues: string[] = []
  const finite = (v: number) => Number.isFinite(v)
  if (![job.widthMm, job.heightMm].every((v) => finite(v) && v > 0)) return ['Job dimensions must be positive finite measurements.']
  if (job.stones.length > 250000) return ['This job exceeds the 250,000-stone limit. Split it into smaller jobs.']
  let outside = false
  for (const s of job.stones) {
    const spec = job.sizes[s.size]
    if (!spec || ![s.x, s.y, spec.holeMm, spec.stoneMm].every(finite) || spec.holeMm <= 0 || spec.stoneMm <= 0) {
      issues.push('A stone has invalid coordinates or an undefined/invalid size.'); break
    }
    const r = spec.holeMm / 2
    outside ||= s.x - r < -1e-6 || s.y - r < -1e-6 || s.x + r > job.widthMm + 1e-6 || s.y + r > job.heightMm + 1e-6
  }
  for (const p of job.paths ?? []) {
    if (p.length < 2) { issues.push('A cut path needs at least two points.'); break }
    if (p.some((q) => !finite(q.x) || !finite(q.y))) { issues.push('A cut path has invalid coordinates.'); break }
    outside ||= p.some((q) => q.x < -1e-6 || q.y < -1e-6 || q.x > job.widthMm + 1e-6 || q.y > job.heightMm + 1e-6)
  }
  if (outside) issues.push('Cut geometry extends beyond the job area. Move it inward or increase the job area/margin.')
  if (!issues.length && job.stones.length && findOverlaps(job.stones, (s) => job.sizes[s.size].holeMm, Math.max(0.5, gapMm)).involved.length) issues.push('Template holes are too close. Use Production → Check spacing to resolve conflicts before cutting.')
  return issues
}

export function validateConditions(preset: MaterialPreset): void {
  if (!Number.isInteger(preset.force) || preset.force < 1 || preset.force > 38 ||
      !Number.isInteger(preset.speed) || preset.speed < 1 || preset.speed > 64 ||
      !Number.isInteger(preset.passes) || preset.passes < 1 || preset.passes > 20) {
    throw new Error('Material conditions must use force 1–38, speed 1–64, and 1–20 whole passes.')
  }
}
