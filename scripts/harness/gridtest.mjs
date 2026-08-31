import './canvas-stub.mjs'
const { SpacingIndex, marchingSquares, outlineOrSpine, fillStones } = await import('../../src/fill.ts')
const hole=3.4, gap=0.8, pitch=hole+gap, pxPerMm=6, fHole=2.5, fGap=0.8
const W=Math.round(48*pxPerMm); const c=W/2
const bin=new Uint8Array(W*W)
for(let y=0;y<W;y++)for(let x=0;x<W;x++) bin[y*W+x]=Math.hypot(x-c,y-c)/pxPerMm<=20?1:0
const grid={bin,w:W,h:W,pxPerMm,padPx:0}
const contours=marchingSquares(bin,W,W).map(ct=>ct.map(p=>({x:p.x/pxPerMm,y:p.y/pxPerMm})))
for (const brick of [true,false]) {
  const idx=new SpacingIndex(pitch)
  const outline=outlineOrSpine(contours,grid,hole,gap,idx,'auto',false,pitch,true)
  const fIdx=new SpacingIndex(Math.max(fHole+fGap,(hole+fHole)/2+fGap),fGap,fHole/2)
  for(const p of outline) fIdx.add(p,hole/2)
  const fill=fillStones(grid,fHole,fGap,fHole/2+0.1,fIdx,outline,fHole+fGap,brick)
  const ys=[...new Set(fill.map(p=>p.y.toFixed(1)))].sort((a,b)=>a-b)
  const rowGap=ys.length>1?(+ys[ys.length-1]-+ys[0])/(ys.length-1):0
  console.log(brick?'brick':'grid ', 'stones:',fill.length,'rows:',ys.length,'rowGap:',rowGap.toFixed(2))
}
