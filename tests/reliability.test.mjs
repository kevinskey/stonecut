import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { parseProject, readProjectFileText } from '../src/project.ts'
import { preflight, validateConditions } from '../src/preflight.ts'
import { spatialCutOrder } from '../src/cut-order.ts'
import { approvedApiBase } from '../src/publish.ts'
import { toDXF, workOrderHtml, placementGuideHtml } from '../src/export.ts'
const require=createRequire(import.meta.url)
const {trustedDocument,externalUrl}=require('../electron/security.cjs')
const sizes={SS6:{stoneMm:2,holeMm:2.8}}
const job=()=>({stones:[{x:10,y:10,size:'SS6',color:'#ff0000'}],sizes:structuredClone(sizes),widthMm:100,heightMm:100})
const legacy=()=>({v:1,stones:job().stones,sizes:structuredClone(sizes),vectors:[],elements:{}})

test('legacy geometry and multicolor designs survive project parsing without mutation',()=>{
 const original=legacy();original.stones.push({x:30,y:30,size:'SS6',color:'#00ff00'})
 const before=structuredClone(original),parsed=parseProject(JSON.parse(JSON.stringify(original)))
 assert.equal(parsed.sizes.SS6.holeMm,2.8);assert.deepEqual(parsed.stones,before.stones);assert.deepEqual(original,before)
})
test('version two preserves project context and a complete saved cutter profile',()=>{
 const original={...legacy(),v:2,context:{boardWIn:12,boardHIn:18,placement:'artboard',margin:5,gap:.8,outlineColor:'#ff0000',fillColor:'#00ff00',boardColor:null,garmentColor:'#000000',cutter:{format:'gpgl',gpStep:20,originCorner:'br',sendConditions:true,swapAxes:true,wCircles:false,overcut:.5,preset:{name:'Tuned',force:30,speed:10,passes:1},linePreset:{name:'Tuned',force:30,speed:10,passes:1}}}}
 const restored=parseProject(JSON.parse(JSON.stringify(original)));assert.deepEqual(restored.context,original.context);assert.deepEqual(restored.stones,original.stones);assert.equal(restored.sizes.SS6.holeMm,2.8)
})
for(const [name,change] of [
 ['unknown version',d=>d.v=99],['nonfinite coordinates',d=>d.stones[0].x=Infinity],['undefined stone size',d=>d.stones[0].size='missing'],['negative diameter',d=>d.sizes.SS6.holeMm=-1],['invalid color',d=>d.stones[0].color='<script>'],['invalid path',d=>d.vectors=[{id:1,name:'bad',x:0,y:0,s:1,baseW:1,baseH:1,base:[[{x:NaN,y:0}]]}]],
])test(`project rejects ${name}`,()=>{const d=legacy();change(d);assert.throws(()=>parseProject(d),/Invalid project/)})
test('oversized files are refused before their contents are read',async()=>{
 let read=false;await assert.rejects(readProjectFileText({size:51*1024*1024,text:async()=>{read=true;return ''}}),/50 MB/);assert.equal(read,false)
})
test('preflight checks final holes, frame paths, finite units and physical conditions',()=>{
 assert.deepEqual(preflight(job()),[])
 const outside=job();outside.stones[0].x=.1;assert.ok(preflight(outside).some(x=>x.includes('beyond')))
 const framed=job();framed.paths=[[{x:0,y:0},{x:101,y:10}]];assert.ok(preflight(framed).some(x=>x.includes('beyond')))
 const invalid=job();invalid.stones[0].y=NaN;assert.ok(preflight(invalid).some(x=>x.includes('invalid')))
 assert.throws(()=>validateConditions({force:39,speed:1,passes:1}));assert.throws(()=>validateConditions({force:1,speed:1,passes:0}))
})
test('spacing preflight detects conflicts for custom holes wider than a former grid cell',()=>{
 const j=job();j.sizes.SS6.holeMm=30;j.stones=[{x:20,y:20,size:'SS6'},{x:38,y:20,size:'SS6'}]
 assert.ok(preflight(j).some(x=>x.includes('too close')))
})
function brute(stones,start){const remaining=[...stones],out=[];let p=start;while(remaining.length){let index=0,d=Infinity;remaining.forEach((s,i)=>{const v=(s.x-p.x)**2+(s.y-p.y)**2;if(v<d){d=v;index=i}});p=remaining.splice(index,1)[0];out.push(p)}return out}
test('spatial ordering matches the original exact nearest-neighbor algorithm, including ties',()=>{
 let seed=2026;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%50}
 for(let run=0;run<10;run++){const stones=Array.from({length:150},(_,i)=>({x:random(),y:random(),size:'SS6',i}));const start={x:run,y:run};assert.deepEqual(spatialCutOrder(stones,start),brute(stones,start));assert.equal(stones[0].i,0)}
})
test('credential destinations and desktop navigation are restricted',()=>{
 assert.equal(approvedApiBase('https://tshirtbrothers.com/'),'https://tshirtbrothers.com')
 assert.equal(approvedApiBase('http://localhost:3000'),'http://localhost:3000')
 for(const url of ['https://evil.example','https://tshirtbrothers.com.evil.example','https://tshirtbrothers.com/api','https://a:b@tshirtbrothers.com'])assert.throws(()=>approvedApiBase(url))
 assert.equal(trustedDocument('https://rhinestones.tshirtbrothers.com/'),true);assert.equal(trustedDocument('https://evil.example/'),false);assert.equal(trustedDocument('https://rhinestones.tshirtbrothers.com/untrusted'),false)
 assert.equal(externalUrl('javascript:alert(1)'),false);assert.equal(externalUrl('https://github.com/kevinskey/stonecut'),true)
})
test('print exports escape user-controlled titles and DXF identifies millimeters',()=>{
 const j=job();const title='<img src=x onerror=alert(1)>'
 assert.ok(!workOrderHtml(j,[],()=> '#ff0000',{title,boardLabel:'test',material:'test'}).includes(title))
 assert.ok(!placementGuideHtml(j,()=> '#ff0000',title).includes(title))
 assert.ok(toDXF(j).includes('$INSUNITS\r\n70\r\n4'))
})

test('quantized cutter coordinates cannot extend past a nominally fitting hole', async()=>{
 const {serializeCutJob}=await import('../src/cut-confirmation.ts')
 const j=job();j.sizes.SS6.holeMm=2.9;j.stones[0]={x:98.55,y:50,size:'SS6'}
 assert.deepEqual(preflight(j),[])
 const settings={format:'gpgl',preset:{name:'test',speed:1,force:1,passes:1},origin:'bl',unitsPerMm:10,sendConditions:false,swapAxes:false,cutOpts:{}}
 assert.throws(()=>serializeCutJob(j,settings),/toolpath exceeds/)
})

test('cut ordering keeps the default origin when no start point is supplied',()=>{
 const stones=[{x:30,y:0,size:'SS6'},{x:10,y:0,size:'SS6'},{x:20,y:0,size:'SS6'}]
 assert.deepEqual(spatialCutOrder(stones),brute(stones,{x:0,y:0}))
})
