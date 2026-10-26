import { booleanPaths } from '../../src/boolean.ts'
const rect = (x0,y0,x1,y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]
// H: two stems + crossbar exactly flush with both stems
const stems = [rect(0,0,10,30), rect(20,0,30,30)]
const bar = [rect(10,12,20,18)]
const out = booleanPaths('union', [stems, bar])
let spurs = 0
for (const ring of out) {
  for (let i = 1; i < ring.length - 1; i++) {
    const a=ring[i-1], b=ring[i], c=ring[i+1]
    const cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)
    const dot=(b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)
    if (Math.abs(cross)<1e-6 && dot<0) spurs++
  }
}
console.log('rings:', out.length, 'pts:', out.map(r=>r.length).join(','), 'spurs:', spurs)
