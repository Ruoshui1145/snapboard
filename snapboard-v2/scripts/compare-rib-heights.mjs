import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createServer} from 'vite'
const server=await createServer({configFile:false,appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
 const [file,lattice,svg,faces,native]=await Promise.all(['projectFile','openLattice','svgLattice','latticeFaceMesh','spatialSolid'].map(n=>server.ssrLoadModule(`/src/utils/${n}.ts`)))
 const w=file.parseProjectFile(await readFile('已保存项目/长亮.snapboard','utf8')).workspace,cfg=w.splitConfig,wasm=await native.spatialManifold(),rows=[]
 const volume=async(face,panel)=>{
  let totalMm3=0,backMm3=0
  for(const {data} of await faces.extrudeLatticeFace(face)){
   const solid=new wasm.Manifold(new wasm.Mesh({numProp:3,vertProperties:Float32Array.from(data.vertices,(v,i)=>v-(i%3===0?panel.x:i%3===1?panel.y:0)),triVerts:Uint32Array.from(data.triangles)}))
   try{assert.equal(solid.status(),'NoError');totalMm3+=solid.volume();const rear=solid.trimByPlane([0,0,-1],-(cfg.thickness-1));try{backMm3+=rear.volume()}finally{rear.delete()}}finally{solid.delete()}
  }
  return {totalMm3,backMm3}
 }
 for(const source of process.argv.includes('--sample')?w.splitResult.panels.slice(0,1):w.splitResult.panels){
  const panel={...source,latticeFace:undefined,latticeCutouts:undefined,latticeOptions:{...source.latticeOptions,fillWindows:false,openCoreCaps:true}}
  const face=svg.applyLatticeFrontLayer(panel,cfg,lattice.generateOpenLattice(panel,cfg,3.5,'ribs'),1).face
  const lower=face.layers.filter(l=>l.role==='structure').at(-1)
  const uniform={...face,layers:[{...lower,zMin:0},...face.layers.filter(l=>l.role!=='structure')]}
  const current=await volume(face,panel),before=await volume(uniform,panel)
  assert.ok(current.totalMm3<before.totalMm3,'high/low grid must save volume relative to the identical all-high grid')
  rows.push({id:panel.id,...current,uniformMm3:before.totalMm3,uniformBackMm3:before.backMm3})
 }
 const current={comparison:'identical grid, all-high vs high/low, same edge treatments',config:cfg,frontMm:1,rows,totalMm3:rows.reduce((s,p)=>s+p.totalMm3,0),backMm3:rows.reduce((s,p)=>s+p.backMm3,0)}
 await mkdir('output/sparse-ribs',{recursive:true})
 const beforeMm3=rows.reduce((s,p)=>s+p.uniformMm3,0),beforeBackMm3=rows.reduce((s,p)=>s+p.uniformBackMm3,0)
 const report={...current,beforeMm3,totalReductionPercent:(1-current.totalMm3/beforeMm3)*100,backReductionPercent:(1-current.backMm3/beforeBackMm3)*100}
 await writeFile(`output/sparse-ribs/cross-grid-${process.argv.includes('--sample')?'sample':'comparison'}.json`,JSON.stringify(report,null,2))
 console.log(`${rows.length} panel(s): rear structure ${report.backReductionPercent.toFixed(2)}% less volume, entire model ${report.totalReductionPercent.toFixed(2)}% less volume vs the SAME all-high grid. Not a slicer-time measurement.`)
 console.log(`Closed model volume: ${Math.round(current.totalMm3)}mm3; rear structure: ${Math.round(current.backMm3)}mm3.`)
}finally{await server.close()}
