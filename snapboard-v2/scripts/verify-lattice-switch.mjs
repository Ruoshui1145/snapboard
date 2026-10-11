import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'vite'
const server=await createServer({configFile:false,appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
 const [file,lattice,svg,faces,native]=await Promise.all(['projectFile','openLattice','svgLattice','latticeFaceMesh','spatialSolid'].map(n=>server.ssrLoadModule(`/src/utils/${n}.ts`)))
 const w=file.parseProjectFile(await readFile('已保存项目/长亮.snapboard','utf8')).workspace,cfg=w.splitConfig
 const wasm=await native.spatialManifold()
 for(const source of w.splitResult.panels){
 for(const style of ['ribs','hex','organic','diamond','honeycomb']){
  const panel={...source,latticeFace:undefined,latticeCutouts:undefined,latticeOptions:{...source.latticeOptions,fillWindows:false}}
  const plan=svg.applyLatticeFrontLayer(panel,cfg,lattice.generateOpenLattice(panel,cfg,3.5,style),1)
  const start=performance.now()
  try{
   const parts=await faces.extrudeLatticeFace(plan.face)
   let count=0
   for(const {data} of parts){
    const solid=new wasm.Manifold(new wasm.Mesh({numProp:3,vertProperties:Float32Array.from(data.vertices,(v,i)=>v-(i%3===0?panel.x:i%3===1?panel.y:0)),triVerts:Uint32Array.from(data.triangles)}))
    try{assert.equal(solid.status(),'NoError',`${style} must be closed`);assert.ok(solid.volume()>0)}finally{solid.delete()}
    count+=data.triangles.length/3
   }
   assert.ok(count<500000,`${style} must remain within a practical mesh budget`)
   console.log(`${source.id}/${style}: closed, ${count} triangles, ${Math.round(performance.now()-start)}ms`)
  }catch(error){throw new Error(`${style}: ${error.message}`,{cause:error})}
 }
 }
 console.log('Lattice switch geometry passed: all five skeletons on all 11 real panels with retained fronts.')
}finally{await server.close()}
