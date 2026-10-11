import assert from 'node:assert/strict'
import {createServer} from 'vite'
import pc from 'polygon-clipping'
import {fileURLToPath} from 'node:url'
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',server:{middlewareMode:true,hmr:false}})
try {
 const {textureLayerDomains}=await server.ssrLoadModule('/src/utils/textureManufacturingDomain.ts')
 const {extrudeTextureRegions}=await server.ssrLoadModule('/src/utils/textureRegionContours.ts')
 const {extrudeTexturePartition}=await server.ssrLoadModule('/src/utils/textureRegionExtrusion.ts')
 const rect=(x,y,w,h)=>[[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]]]
 const ring=Array.from({length:129},(_,i)=>[15+3*Math.cos(i*Math.PI/64),15+3*Math.sin(i*Math.PI/64)])
 ring[128]=ring[0]
 const domain=pc.difference(rect(0,0,30,30),[[ring]])
 const area=mp=>mp.reduce((sum,p)=>sum+p.reduce((s,r,i)=>{const a=Math.abs(r.slice(1).reduce((v,b,j)=>v+r[j][0]*b[1]-b[0]*r[j][1],0)/2);return s+(i?-a:a)},0),0)
 for(const inset of [0,.03,.11,.19,.27]) {
  const d=textureLayerDomains(domain,domain,inset,.5)
  assert(area(pc.intersection(d.color,d.seal))<1e-8,'overlapping materials')
  assert(Math.abs(area(d.effective)-area(d.color)-area(d.seal))<1e-7,'coverage gap')
  for(const r of d.color.flat()) for(const [x,y]of r)if(Math.hypot(x-15,y-15)<5)assert(Math.abs(Math.hypot(x-15,y-15)-3.5)<.008,'seal outer edge must follow offset circle')
  for(const polys of [d.color,d.seal])extrudeTextureRegions(polys.map(p=>({outer:p[0],holes:p.slice(1)})),0,.08)
 }
 const coupon=pc.intersection(domain,rect(8,8,14,14)),d=textureLayerDomains(coupon,domain,0,.5)
 assert(!pc.intersection(d.seal,rect(8,8,1,1)).length,'new coupon edge gained a seal')
 const off=textureLayerDomains(domain,domain,.1,0)
 assert.equal(off.seal.length,0,'disabled seal')
 const contact={outer:[[0,0],[4,0],[4,4],[0,4]],holes:[[[0,0],[1,2],[2,1]]]}
 const mesh=extrudeTexturePartition([contact],0,.08)
 let volume=0
 for(let i=0;i<mesh.triangles.length;i+=3){const [a,b,c]=mesh.triangles.slice(i,i+3).map(id=>mesh.vertices.slice(id*3,id*3+3));volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6}
 assert(Math.abs(volume-(16-1.5)*.08)<1e-8,'point-contact partition changed volume')
 const incidence=new Map()
 for(let i=0;i<mesh.triangles.length;i+=3)for(let j=0;j<3;j++){const a=mesh.triangles[i+j],b=mesh.triangles[i+(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;incidence.set(key,(incidence.get(key)??0)+1)}
 assert([...incidence.values()].every(n=>n===2),'point contact must not share a nonmanifold vertical edge')
 console.log('Exact domains: all 5 layer offsets, round outer seal, closure, no material overlap/gap, coupon inheritance, disabled seal passed')
} finally {await server.close()}
