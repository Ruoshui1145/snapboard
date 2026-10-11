import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {unzipSync,strFromU8} from 'fflate'
import {readFile} from 'node:fs/promises'
import * as THREE from 'three'
const s=await createServer({appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
  const [split,lattice,svg,mark,file,exporter,side,face,store,solid]=await Promise.all([
    s.ssrLoadModule('/src/utils/pegboardSplit.ts'),s.ssrLoadModule('/src/utils/openLattice.ts'),s.ssrLoadModule('/src/utils/svgLattice.ts'),
    s.ssrLoadModule('/src/utils/assemblyMarking.ts'),s.ssrLoadModule('/src/utils/projectFile.ts'),s.ssrLoadModule('/src/utils/export3mf.ts'),
    s.ssrLoadModule('/src/utils/sideLogo.ts'),s.ssrLoadModule('/src/utils/latticeFaceMesh.ts'),s.ssrLoadModule('/src/store/useAppStore.ts'),s.ssrLoadModule('/src/utils/spatialSolid.ts')])
  const cfg={...split.PEGBOARD_DEFAULT_CONFIG,bedW:256,bedH:256,bedKeepouts:[],thickness:5}
  const panel=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:200,y:0},{x:200,y:200},{x:0,y:200}],holes:[]},cfg).panels[0]
  for(const style of ['hex','honeycomb']){
    const original=lattice.generateOpenLattice(panel,cfg,3.5,style)
    const plan=svg.applyLatticeFrontLayer(panel,cfg,original,1)
    const p={...panel,latticeCutouts:plan.holes,latticeFace:plan.face}
    for(const numberPlacement of ['auto','back']){
      const config={...mark.createDefaultAssemblyMarking(),numberPlacement}
      const layout=mark.buildSurfaceMarkingPlan([p],cfg,config)
      assert.ok(layout.panels[0].numberMark,'safe number surface required')
      assert.equal(layout.panels[0].numberMark.surface,'pocket')
      const result=await exporter.createManufacturing3MF({panels:[p],cfg,assemblyMarking:config,placedParts:[],partDefinitions:[]})
      assert.equal(result.numbering.applied,1)
      assert.equal(result.numbering.requested,1)
      assert.deepEqual(result.numbering.missing,[])
      const files=unzipSync(result.data)
      assert.match(strFromU8(files['Metadata/snapboard-assembly-map.json']),/numberMark/)
      assert.doesNotMatch(strFromU8(files['Metadata/model_settings.config']),/背腔凸号/,'assembly number must subtract from an existing carrier, never add material')
    }
  }
  assert.equal(mark.normalizeAssemblyMarking({numberPlacement:'side'}).numberPlacement,'side')
  const shifted=split.splitOrthogonalPolygon({points:[{x:-290,y:-460},{x:110,y:-460},{x:110,y:-220},{x:-290,y:-220}],holes:[]},cfg).panels.map(p=>{
    const plan=svg.applyLatticeFrontLayer(p,cfg,lattice.generateOpenLattice(p,cfg,3.5,'hex'),1)
    return {...p,latticeCutouts:plan.holes,latticeFace:plan.face}
  })
  // Old projects may enable both kit codes and orientation. Their longer rounded
  // glyphs exposed non-conforming side-cutter caps and stopped the whole viewport.
  const workspace={...file.projectWorkspaceFromState(store.useAppStore.getState()),splitConfig:cfg,
    splitResult:{panels:shifted,sources:[],warnings:[],config:cfg,ts:1,openLatticeStyle:'hex'},
    assemblyMarking:{...mark.createDefaultAssemblyMarking(),kitCode:'4SSJ',includeKitCode:true,includeOrientation:true}}
  const reopened=file.parseProjectFile(process.argv[2]?await readFile(process.argv[2],'utf8'):file.serializeProjectFile(workspace)).workspace
  const blankKit={...workspace,assemblyMarking:{...workspace.assemblyMarking,kitCode:''}}
  const locked=file.parseProjectFile(file.serializeProjectFile(blankKit)).workspace
  const kit=locked.assemblyMarking.kitCode
  assert.ok(kit)
  locked.project.metadata.name='renamed'
  assert.equal(file.parseProjectFile(file.serializeProjectFile(locked)).workspace.assemblyMarking.kitCode,kit,'saved kit code must survive project renaming')
  const plans=mark.buildSurfaceMarkingPlan(reopened.splitResult.panels,reopened.splitConfig,reopened.assemblyMarking)
  const wasm=await solid.spatialManifold()
  const {previewMeshTopology}=await s.ssrLoadModule('/src/utils/previewMeshTopology.ts')
  for(const [i,p]of reopened.splitResult.panels.entries()){
    const root=new THREE.Group()
    root.add(...await face.createLatticeFaceMeshes(p.latticeFace,0x334b55,p,reopened.splitConfig))
    assert.equal(await side.applyPanelNumberPreview(root,p,reopened.splitConfig,plans.panels[i],reopened.assemblyMarking),true,'reopened project must engrave and finish building 3D')
    root.traverse(mesh=>{
      if(!mesh.isMesh)return
      const topology=previewMeshTopology(mesh.geometry)
      assert.ok(topology,'Preview must retain indexed geometry for booleans rather than weld shading vertices')
      const data=new wasm.Mesh({numProp:3,vertProperties:Float32Array.from(topology.vertices,(v,i)=>v-(i%3===0?p.x:i%3===1?p.y:0)),triVerts:Uint32Array.from(topology.triangles),tolerance:1e-5})
      const result=new wasm.Manifold(data)
      assert.equal(result.status(),'NoError','numbered preview must remain closed')
      result.delete();mesh.geometry.dispose();mesh.material.dispose()
    })
  }
  const exported=await exporter.createManufacturing3MF({panels:shifted,cfg,assemblyMarking:workspace.assemblyMarking,placedParts:[],partDefinitions:[]})
  assert.equal(exported.numbering.applied,shifted.length,'long kit/ID/orientation text must export with the same closed cutter')
  console.log(`Save/reopen passed: ${reopened.splitResult.panels.length} hollow boards with independent back panel IDs and orientation and closed 3D meshes.`)
  console.log('Lattice numbering passed: rear carrier subtractive IDs, closed hex/honeycomb exports, unchanged original IDs and actual numbering counts.')
}finally{await s.close()}
