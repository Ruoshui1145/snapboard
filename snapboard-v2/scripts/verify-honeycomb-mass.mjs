import assert from 'node:assert/strict'
import {createServer} from 'vite'
const s=await createServer({appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
 const [split,lattice,svg,mass,files,store]=await Promise.all([
  s.ssrLoadModule('/src/utils/pegboardSplit.ts'),s.ssrLoadModule('/src/utils/openLattice.ts'),s.ssrLoadModule('/src/utils/svgLattice.ts'),
  s.ssrLoadModule('/src/utils/latticeMass.ts'),s.ssrLoadModule('/src/utils/projectFile.ts'),s.ssrLoadModule('/src/store/useAppStore.ts')])
 const cfg={...split.PEGBOARD_DEFAULT_CONFIG,bedW:256,bedH:256,bedKeepouts:[],thickness:5}
 const p=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:200,y:0},{x:200,y:200},{x:0,y:200}],holes:[]},cfg).panels[0]
 p.latticeOptions={fillWindows:false,cellPitchMm:24,cellRibMm:1.26,openCoreCaps:false}
 const h=lattice.generateOpenLattice(p,cfg,3.5,'honeycomb')
 assert.ok(h.holes.length>30)
 const guide=p.edge_holes.find(x=>!x.knocked)
 const changed={...p,edge_holes:p.edge_holes.filter(x=>x!==guide)}
 assert.deepEqual(lattice.generateOpenLattice(changed,cfg,3.5,'honeycomb').holes,h.holes,'unused guide circles do not become anchors')
 const profile={layerHeightMm:.2,infillPercent:10}
 const whole=svg.applyLatticeFrontLayer(p,cfg,h,1)
 const kept={...p,latticeCutouts:h.holes,latticeFace:whole.face}
 const base=mass.estimateLatticeMass(p,cfg,profile)
 assert.ok(base.printedVolumeMm3<base.modelVolumeMm3*.8,'ordinary 10% part cannot be treated as solid')
 const estimated=mass.estimateLatticeMass(kept,cfg,profile)
 assert.ok(estimated.printedVolumeMm3<=estimated.modelVolumeMm3+1)
 assert.ok(mass.estimateLatticeMass(kept,cfg,{...profile,infillPercent:30}).grams>=estimated.grams)
 assert.ok(mass.estimateLatticeMass({...kept,latticeOptions:{...p.latticeOptions,openCoreCaps:true}},cfg,profile).grams<=estimated.grams)
 assert.throws(()=>lattice.generateOpenLattice({...p,latticeOptions:{...p.latticeOptions,cellRibMm:4}},cfg,3.5,'honeycomb'),/筋宽/)
 store.useAppStore.setState({splitConfig:cfg,splitResult:{panels:[kept],sources:[],warnings:[],config:cfg,ts:Date.now()}})
 store.useAppStore.getState().setOpenLattice([{panel:kept,holes:h.holes,face:whole.face}],'honeycomb',[],undefined,undefined,undefined,1)
 const state=store.useAppStore.getState(), saved=files.parseProjectFile(files.serializeProjectFile({project:state.project,boards:state.boards,placedParts:state.placedParts,
  splitConfig:state.splitConfig,splitResult:state.splitResult,spatialLayout:state.spatialLayout,boardTexture:state.boardTexture,assemblyMarking:state.assemblyMarking,assemblyScene:state.assemblyScene}))
 assert.equal(saved.workspace.splitResult.openLatticeStyle,'honeycomb')
 assert.deepEqual(saved.workspace.splitResult.panels[0].latticeOptions,p.latticeOptions)
 console.log('Honeycomb/mass passed: connected lattice, original hole semantics, print-volume bounds, infill/cap sensitivity and project persistence.')
}finally{await s.close()}
