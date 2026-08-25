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

// Nearest-neighbor cut ordering starting from the origin — the fix for the
// head zigzagging across the mat on dense rhinestone patterns.
export function orderNearestNeighbor(stones: Stone[]): Stone[] {
  if (stones.length < 3) return stones
  const remaining = [...stones]
  const out: Stone[] = []
  let cur: Pt = { x: 0, y: 0 }
  while (remaining.length) {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = (remaining[i].x - cur.x) ** 2 + (remaining[i].y - cur.y) ** 2
      if (d < bd) { bd = d; bi = i }
    }
    const s = remaining.splice(bi, 1)[0]
    out.push(s)
    cur = s
  }
  return out
}
