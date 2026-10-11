import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createServer} from 'vite'
import {unzipSync,strFromU8} from 'fflate'
const s=await createServer({configFile:false,appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
  const [lattice,svg,file,exporter,geometry]=await Promise.all([...['openLattice','svgLattice','projectFile','export3mf'].map(n=>s.ssrLoadModule(`/src/utils/${n}.ts`)),s.ssrLoadModule('/src/features/shapeLibrary/import/geometry.ts')])
  const w=file.parseProjectFile(await readFile('已保存项目/长亮.snapboard','utf8')).workspace,cfg=w.splitConfig
  const panels=w.splitResult.panels.map(p=>({...p,latticeFace:undefined,latticeCutouts:undefined,latticeOptions:{...p.latticeOptions,fillWindows:false,openCoreCaps:true}}))
  const out='output/sparse-ribs';await mkdir(out,{recursive:true})
  const sample={...panels[0],round_holes:[{x:panels[0].x+5,y:panels[0].y+70}],edge_holes:[],
    slots:[[20,20],[100,20],[20,100],[100,100],[45,50],[5,140]].map(([x,y])=>({x:panels[0].x+x,y:panels[0].y+y}))}
  const simplified=lattice.generateOpenLattice(sample,cfg,3.5,'ribs')
  const at=(domains,x,y)=>domains.some(([outer,...holes])=>geometry.pointInRing({x:sample.x+x,y:sample.y+y},outer,true)&&!holes.some(h=>geometry.pointInRing({x:sample.x+x,y:sample.y+y},h,true)))
  for(const x of [37,53]){
    assert.equal(at(simplified.highStructure,x,50),false,'off-grid collars must not have short high stubs')
    assert.ok(at(simplified.auxiliary,x,50),'a complete low cross rib must connect both sides of the collar')
  }
  assert.ok(at(simplified.auxiliary,40,80),'middle vertical low ribs must continue across rows')
  assert.ok(at(simplified.highStructure,60,80),'adjacent high vertical ribs must stay high')
  assert.ok(at(simplified.highStructure,80,60),'high horizontal grid rows must continue across columns')
  assert.ok(at(simplified.auxiliary,13,70)&&at(simplified.auxiliary,33,70),'round collars also need a full low cross row')
  const generated=[]
  for(const p of panels){
    const main=lattice.generateOpenLattice(p,cfg,3.5,'ribs')
    for(const slot of p.slots){
      const collar={x:slot.x+cfg.slotWidth/2+0.75,y:slot.y}
      assert.ok(main.highStructure.some(([outer,...holes])=>geometry.pointInRing(collar,outer,true)&&!holes.some(h=>geometry.pointInRing(collar,h,true))),'hook collars must retain their high support')
    }
    const plan=svg.applyLatticeFrontLayer(p,cfg,main,1)
    const layers=plan.face.layers.filter(l=>l.role==='structure')
    assert.equal(layers.length,2)
    assert.equal(layers[1].zMax-layers[1].zMin,1.96)
    assert.ok(layers[0].zMax>0)
    assert.equal(layers[0].zMax,layers[1].zMin)
    assert.equal(layers[1].zMax,4)
    assert.equal(plan.face.layers.find(l=>l.role==='backing').polygons.length,1,'front carrier must remain continuous')
    const inactive={...p,edge_holes:p.edge_holes.filter(h=>h.knocked)}
    assert.deepEqual(lattice.generateOpenLattice(inactive,cfg,3.5,'ribs').holes,main.holes,'unused round guides must not create collars or branches')
    generated.push({...p,latticeCutouts:plan.holes,latticeFace:plan.face})
    console.log(p.id,'main windows',plan.holes.length,'auxiliary regions',main.auxiliary.length)
  }
  const saved=file.parseProjectFile(file.serializeProjectFile({...w,splitResult:{...w.splitResult,panels:generated,openLatticeStyle:'ribs',openLatticeSurfaceMm:1}}))
  assert.equal(saved.workspace.splitResult.openLatticeStyle,'ribs')
  const p=generated[0],changed={...p,edge_holes:p.edge_holes.map((h,i)=>i===0?{...h,knocked:!h.knocked}:h)}
  assert.equal(svg.currentSvgFace(changed,cfg).layers.filter(l=>l.role==='structure').length,2,'hole edits must regenerate both heights')
  const result=await exporter.createManufacturing3MF({panels:generated,cfg,placedParts:[],partDefinitions:[],assemblyMarking:w.assemblyMarking,projectName:'粗疏筋架首版样板'})
  assert.equal(result.panelCount,11)
  assert.equal(result.numbering.applied,11)
  const zip=unzipSync(result.data)
  assert.match(strFromU8(zip['Metadata/model_settings.config']),/key="wall_generator" value="arachne"/)
  assert.match(strFromU8(zip['Metadata/model_settings.config']),/key="sparse_infill_density" value="100%"/)
  await writeFile(out+'/粗疏筋架-11板样板.3mf',result.data)
  const base={...panels[0]},main=lattice.generateOpenLattice(base,cfg,3.5,'ribs')
  const drawing=lattice.openLatticePlanSvg(base,main,cfg)
  const thumbnail='public/lattice-reference/ribs.svg'
  if(await readFile(thumbnail,'utf8').catch(()=>'')!==drawing)await writeFile(thumbnail,drawing)
  await writeFile(out+'/背面筋架.svg',drawing)
  console.log('Cross ribs passed: full two-sided low connections, alternating continuous grid, high collars, 11 closed numbered boards and unchanged holes.')
}finally{await s.close()}
