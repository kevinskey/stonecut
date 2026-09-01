// Dump worst-drifting wall stones with context for one font/word.
import './canvas-stub.mjs'
import { readFile } from 'node:fs/promises'
const [fontPath, text='Glee'] = process.argv.slice(2)
const opentype = (await import('opentype.js')).default
const { textToContours } = await import('../../src/text.ts')
const { SpacingIndex, distanceTransform, outlineOrSpine, rasterizeContours, debugStones } = await import('../../src/fill.ts')
const font = opentype.parse((await readFile(fontPath)).buffer)
const { contours } = await textToContours(font, text, 50, 2)
const grid = rasterizeContours(contours, 6, 0.5)
const idx = new SpacingIndex(4.2)
outlineOrSpine(contours, grid, 3.4, 0.8, idx, 'auto', true, 4.2, true)
const segs=[]
for (const c of contours) for (let k=0;k<c.length;k++){const a=c[k],b=c[(k+1)%c.length]; if(Math.hypot(b.x-a.x,b.y-a.y)>1e-9) segs.push([a.x,a.y,b.x-a.x,b.y-a.y])}
const dv=(p)=>{let m=Infinity; for(const [ax,ay,vx,vy] of segs){const L2=vx*vx+vy*vy; let t=((p.x-ax)*vx+(p.y-ay)*vy)/L2; t=t<0?0:t>1?1:t; const d=Math.hypot(p.x-(ax+vx*t),p.y-(ay+vy*t)); if(d<m)m=d} return m}
const { w,h,pxPerMm,padPx }=grid
const dt=distanceTransform(grid)
const dtAt=(p)=>{const xi=Math.round(p.x*pxPerMm+padPx),yi=Math.round(p.y*pxPerMm+padPx); return (xi<0||yi<0||xi>=w||yi>=h)?0:dt[yi*w+xi]/pxPerMm}
const WALL=new Set(['corner','edge','patch','loop'])
const strokeW=new Float32Array(w*h)
for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i2=y*w+x; if(!grid.bin[i2])continue; const dvv=dt[i2]; if(dvv<=0)continue;
 if(!(dvv>=dt[i2-1]&&dvv>=dt[i2+1]&&dvv>=dt[i2-w]&&dvv>=dt[i2+w]&&dvv>=dt[i2-w-1]&&dvv>=dt[i2-w+1]&&dvv>=dt[i2+w-1]&&dvv>=dt[i2+w+1]))continue;
 const rr=dvv*dvv,val=2*dvv/pxPerMm,r0=Math.ceil(dvv);
 for(let yy=Math.max(0,y-r0);yy<=Math.min(h-1,y+r0);yy++){const dy2=yy-y,sp2=Math.floor(Math.sqrt(Math.max(0,rr-dy2*dy2))),row=yy*w;
  for(let xx=Math.max(0,x-sp2);xx<=Math.min(w-1,x+sp2);xx++) if(grid.bin[row+xx]&&strokeW[row+xx]<val)strokeW[row+xx]=val}}
const swAt=(p)=>{const xi=Math.round(p.x*pxPerMm+padPx),yi=Math.round(p.y*pxPerMm+padPx); return (xi<0||yi<0||xi>=w||yi>=h)?0:strokeW[yi*w+xi]}
const rows=debugStones.filter(s=>WALL.has(s.cat)).map(s=>{const d=dv(s); const half=swAt(s)/2; const err=half>0&&half<4.2*0.55?Math.min(d,Math.abs(d-half)):d; return {cat:s.cat,x:+s.x.toFixed(1),y:+s.y.toFixed(1),err:+err.toFixed(2),dVec:+d.toFixed(2),halfW:+dtAt(s).toFixed(2)}})
rows.sort((a,b)=>b.err-a.err)
console.log(JSON.stringify(rows.slice(0,8),null,0).replaceAll('},','},\n'))
