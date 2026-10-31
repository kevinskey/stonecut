import type { Pt, Stone } from './model'
interface Node { index: number; axis: number; left?: Node; right?: Node; parent?: Node; live: number; removed: boolean }
// Exact nearest-neighbor ordering with a balanced spatial tree. Input order
// breaks equal-distance ties, preserving the original exporter's behavior.
export function spatialCutOrder(stones: Stone[], start: Pt = { x: 0, y: 0 }): Stone[] {
  if (stones.length < 3) return stones
  const nodes: Node[] = []
  const coord = (i: number, axis: number) => axis ? stones[i].y : stones[i].x
  const build = (indices: number[], depth: number, parent?: Node): Node | undefined => {
    if (!indices.length) return undefined
    const axis = depth % 2
    indices.sort((a,b) => coord(a,axis) - coord(b,axis) || a-b)
    const mid = indices.length >> 1
    const node: Node = { index: indices[mid], axis, parent, live: indices.length, removed: false }
    nodes[node.index] = node
    node.left = build(indices.slice(0,mid),depth+1,node)
    node.right = build(indices.slice(mid+1),depth+1,node)
    return node
  }
  const root = build(stones.map((_,i)=>i),0)
  let cur = start
  const out: Stone[] = []
  for (let i=0;i<stones.length;i++) {
    let best = -1, distance = Infinity
    const search = (node?: Node) => {
      if (!node?.live) return
      const p = stones[node.index]
      const delta = node.axis ? cur.y-p.y : cur.x-p.x
      const near = delta < 0 ? node.left : node.right
      const far = delta < 0 ? node.right : node.left
      if (!node.removed) {
        const d = (cur.x-p.x)**2+(cur.y-p.y)**2
        if (d < distance || (d === distance && (best < 0 || node.index < best))) { distance=d; best=node.index }
      }
      search(near)
      if (delta*delta <= distance) search(far)
    }
    search(root)
    if (best < 0) throw new Error('Invalid cutter coordinates')
    const node = nodes[best]; node.removed=true
    for (let p: Node | undefined=node;p;p=p.parent) p.live--
    cur=stones[best]; out.push(stones[best])
  }
  return out
}
