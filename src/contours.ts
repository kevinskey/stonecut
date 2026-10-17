import type { Pt } from './model'
import { pointInPoly } from './fill'

// Split contours into per-letter clusters: a contour nested inside another
// is a hole and stays with its parent; disjoint top-level contours whose
// x-ranges overlap (an i's dot over its stem) stay together. Returns groups
// of contour indices; one group means "nothing to split".
export const splitContoursIntoLetters = (paths: Pt[][]): number[][] => {
  if (paths.length < 2) return [paths.map((_, i) => i)]
  const bb = paths.map((c) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const q of c) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    return { minX, minY, maxX, maxY }
  })
  const parent = paths.map((c, i) => {
    let best = -1, bestArea = Infinity
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue
      const inBox = bb[i].minX >= bb[j].minX && bb[i].maxX <= bb[j].maxX && bb[i].minY >= bb[j].minY && bb[i].maxY <= bb[j].maxY
      if (inBox && pointInPoly(paths[j], c[0])) {
        const area = (bb[j].maxX - bb[j].minX) * (bb[j].maxY - bb[j].minY)
        if (area < bestArea) { bestArea = area; best = j }
      }
    }
    return best
  })
  const topOf = (i: number): number => (parent[i] === -1 ? i : topOf(parent[i]))
  const tops = [...new Set(paths.map((_, i) => topOf(i)))]
  const sorted = tops.sort((a, b) => bb[a].minX - bb[b].minX)
  const groups: number[][] = []
  let cur: number[] = []
  let curMax = -Infinity
  for (const t of sorted) {
    if (!cur.length || bb[t].minX <= curMax + 0.01) { cur.push(t); curMax = Math.max(curMax, bb[t].maxX) }
    else { groups.push(cur); cur = [t]; curMax = bb[t].maxX }
  }
  if (cur.length) groups.push(cur)
  return groups.map((g) => {
    const set = new Set(g)
    return paths.map((_, i) => i).filter((i) => set.has(topOf(i)))
  })
}
