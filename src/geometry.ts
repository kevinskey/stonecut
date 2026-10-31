import type { Pt, Stone } from './model'

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Remove stones whose edge-to-edge gap is below minGap. Later stones lose.
// Safety net over the fill engine (used when merging with existing stones).
export function removeCollisions(
  stones: Stone[],
  holeOf: (s: Stone) => number,
  minGap: number,
): Stone[] {
  const kept: Stone[] = []
  const cell = 8
  const grid = new Map<string, Stone[]>()
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  for (const s of stones) {
    const r = holeOf(s) / 2
    let ok = true
    const cx = Math.floor(s.x / cell)
    const cy = Math.floor(s.y / cell)
    for (let gx = cx - 1; gx <= cx + 1 && ok; gx++)
      for (let gy = cy - 1; gy <= cy + 1 && ok; gy++) {
        const bucket = grid.get(`${gx},${gy}`)
        if (!bucket) continue
        for (const o of bucket) {
          if (dist(s, o) < r + holeOf(o) / 2 + minGap) { ok = false; break }
        }
      }
    if (ok) {
      kept.push(s)
      const k = key(s.x, s.y)
      const bucket = grid.get(k)
      if (bucket) bucket.push(s)
      else grid.set(k, [s])
    }
  }
  return kept
}

// Post-edit legality audit: generation can't place an illegal stone (the
// SpacingIndex forbids it), but manual drags and nudges can. Returns the
// indices of every stone involved in an edge-to-edge gap below minGap,
// plus a minimal-ish removal set (later stone of each conflict loses —
// same seniority rule as removeCollisions).
export function findOverlaps(
  stones: Stone[],
  holeOf: (s: Stone) => number,
  minGap: number,
): { involved: number[]; removal: number[] } {
  const cell = stones.reduce((m, s) => Math.max(m, holeOf(s) + minGap), 8)
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const involved = new Set<number>()
  const removal = new Set<number>()
  for (let i = 0; i < stones.length; i++) {
    const s = stones[i]
    const r = holeOf(s) / 2
    const cx = Math.floor(s.x / cell)
    const cy = Math.floor(s.y / cell)
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(`${gx},${gy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (removal.has(j)) continue // already slated to go — gap resolved
          const o = stones[j]
          if (dist(s, o) < r + holeOf(o) / 2 + minGap - 1e-6) {
            involved.add(i)
            involved.add(j)
            removal.add(i) // later stone loses
          }
        }
      }
    const k = key(s.x, s.y)
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  }
  return { involved: [...involved], removal: [...removal] }
}

// Nearest-neighbor cut ordering starting from the origin — the fix for the
// head zigzagging across the mat on dense rhinestone patterns.
// `start` is in MODEL space and should be whatever maps to the machine's
// (0,0) — the exporters mirror X and flip Y, so the model origin is the far
// corner on the cutter. Ordering from the wrong end made the head traverse
// the whole design before its first cut.
export { spatialCutOrder as orderNearestNeighbor } from './cut-order'
