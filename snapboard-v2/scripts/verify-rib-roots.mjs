import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'vite'
const s=await createServer({configFile:false,appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
 const [file,lattice,svg,faces,native,polygon]=await Promise.all(['projectFile','openLattice','svgLattice','latticeFaceMesh','spatialSolid','texturePolygon'].map(n=>s.ssrLoadModule(`/src/utils/${n}.ts`)))
 const w=file.parseProjectFile(await readFile('已保存项目/长亮.snapboard','utf8')).workspace,cfg=w.splitConfig
 const pc=polygon.texturePolygon
 const p={...w.splitResult.panels[0],latticeFace:undefined,latticeCutouts:undefined}
 const plan=svg.applyLatticeFrontLayer(p,cfg,lattice.generateOpenLattice(p,cfg,3.5,'ribs'),1)
 const panel={...p,latticeFace:plan.face,latticeCutouts:plan.holes}
 const started=performance.now(),data=await faces.extrudeLatticeFace(plan.face,panel,cfg)
 console.log(`Solid construction: ${Math.round(performance.now()-started)}ms, ${data[0].data.triangles.length/3} triangles.`)
 assert.equal(data.length,1,'same-material plate and ribs must be one closed body')
 const wasm=await native.spatialManifold()
 const mesh=new wasm.Mesh({numProp:3,vertProperties:Float32Array.from(data[0].data.vertices,(v,i)=>v-(i%3===0?p.x:i%3===1?p.y:0)),triVerts:Uint32Array.from(data[0].data.triangles)})
 const solid=new wasm.Manifold(mesh)
 assert.equal(solid.status(),'NoError');const components=solid.decompose();assert.equal(components.length,1,`detached components: ${JSON.stringify(components.map(c=>c.volume()).sort((a,b)=>b-a).slice(0,8))}`);components.forEach(c=>c.delete())
 const toDomain=layer=>layer.polygons.map(poly=>poly.map(r=>{const q=r.map(v=>[v.x-p.x,v.y-p.y]);return [...q,q[0]]}))
 const area=mp=>mp.reduce((s,p)=>s+p.reduce((a,r,i)=>a+(i?-1:1)*Math.abs(r.reduce((a,v,j)=>{const n=r[(j+1)%r.length];return a+v[0]*n[1]-n[0]*v[1]},0)/2),0),0)
 const section=z=>{const c=solid.slice(z);try{return polygon.fillTextureRings(c.toPolygons(),'nonzero')}finally{c.delete()}}
 const levels=plan.face.layers.filter(l=>l.role==='structure'),high=toDomain(levels[0]),low=toDomain(levels[1])
 assert.ok(area(pc.difference(section(3.7),low))>20,'rib-to-plate shoulder must contain real added material')
 assert.ok(area(pc.difference(section(1.74),high))>1,'high-to-low rib contacts must also have a real shoulder')
 const lowPerimeter=low.reduce((sum,p)=>sum+p.reduce((s,r)=>s+r.slice(1).reduce((v,b,i)=>v+Math.hypot(b[0]-r[i][0],b[1]-r[i][1]),0),0),0)
 assert.ok(area(pc.difference(section(3.1),low))<lowPerimeter*.002+.5,'edge rounding must stay within the 0.002mm surface tolerance')
 assert.ok(area(pc.difference(low,section(3.1)))<area(low)*.005,'upright corner rounding must preserve the rib section')
 assert.ok(area(pc.difference(high,section(.14)))>1,'exposed high-rib top edges need a real cut bevel')
 assert.ok(area(pc.difference(low,section(2.18)))>1,'exposed low-rib top edges need a real cut bevel')
 const front=toDomain(plan.face.layers.find(l=>l.role==='face'))
 assert.ok(area(pc.difference(front,section(4.86)))>1,'front edge and hole mouths need real cut bevels')
 for(const z of [1.74,3.7,4.3]){
  const domain=section(z)
  for(const slot of p.slots){const q=[slot.x-p.x,slot.y-p.y],box=[[[[q[0]-.1,q[1]-.1],[q[0]+.1,q[1]-.1],[q[0]+.1,q[1]+.1],[q[0]-.1,q[1]+.1],[q[0]-.1,q[1]-.1]]]];assert.ok(area(pc.intersection(domain,box))<1e-7,'root transitions must not close functional slots')}
 }
 const preview=await faces.createLatticeFaceMeshes(plan.face,0xffd166,panel,cfg,false)
 assert.equal(preview.length,1)
 let flat=0,internal=0;const capSlopes=[0,0,0],actualHigh=section(1.1)
 const pos=preview[0].geometry.getAttribute('position'),normal=preview[0].geometry.getAttribute('normal')
 const inside=(x,y,domain)=>area(pc.intersection(domain,[[[[x-.001,y-.001],[x+.001,y-.001],[x+.001,y+.001],[x-.001,y+.001],[x-.001,y-.001]]]]))>3.9e-6
 let contacts=0
 for(const [nominal,support,z]of [[low,toDomain(plan.face.layers.find(l=>l.role==='backing')),3.7],[high,low,1.74]]){
  const actual=section(z)
  for(const poly of nominal)for(const r of poly)for(let i=0;i<r.length-1;i++){
   const a=r[i],b=r[i+1],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)
   if(len<.2)continue
   for(const sign of [-1,1]){
    const x=(a[0]+b[0])/2+sign*dy/len*.15,y=(a[1]+b[1])/2-sign*dx/len*.15
    if(!inside(x,y,nominal)&&inside(x,y,support)){
     assert.ok(inside(x,y,actual),`supported edge missing shoulder: ${JSON.stringify({x,y,z,a,b,len})}`);contacts++
    }
   }
  }
 }
 assert.ok(contacts>100)
 for(let i=0;i<pos.count;i+=3){
  const zs=[0,1,2].map(j=>pos.getZ(i+j))
  const a=[pos.getX(i),pos.getY(i),pos.getZ(i)],b=[pos.getX(i+1)-a[0],pos.getY(i+1)-a[1],pos.getZ(i+1)-a[2]],c=[pos.getX(i+2)-a[0],pos.getY(i+2)-a[1],pos.getZ(i+2)-a[2]]
  const n=[b[1]*c[2]-b[2]*c[1],b[2]*c[0]-b[0]*c[2],b[0]*c[1]-b[1]*c[0]],slope=Math.abs(n[2])/Math.hypot(...n),z=zs.reduce((a,b)=>a+b,0)/3
  if(slope>.2&&slope<.9){if(z>0&&z<.28)capSlopes[0]++;if(z>2.04&&z<2.32)capSlopes[1]++;if(z>4.72&&z<5)capSlopes[2]++}
  if(zs.every(z=>Math.abs(z)<1e-6)||zs.every(z=>Math.abs(z-5)<1e-6))for(let j=0;j<3;j++){assert.ok(Math.abs(normal.getZ(i+j))>.999,'flat faces must not inherit side-wall normals');flat++}
  if(zs.every(z=>Math.abs(z-2.04)<1e-5)){
   const x=([0,1,2].reduce((s,j)=>s+pos.getX(i+j),0)/3)-p.x,y=([0,1,2].reduce((s,j)=>s+pos.getY(i+j),0)/3)-p.y
   if(inside(x,y,actualHigh))internal++
  }
 }
 assert.ok(flat>100);assert.equal(internal,0,'the old horizontal cap inside the main rib must be removed')
 assert.ok(capSlopes.every(n=>n>100),`actual exposed-edge slope faces missing: ${capSlopes}`)
 preview.forEach(m=>{m.geometry.dispose();m.material.dispose()});solid.delete()
 console.log(`Rib edges passed: one connected solid, ${contacts} root contacts, exposed cap bevel faces ${capSlopes}, unchanged slots and no internal cap.`)
}finally{await s.close()}
