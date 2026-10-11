import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {unzipSync,strFromU8} from 'fflate'
const vite=await createServer({appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
  const [split,lattice,svg,faces,texture,exporter]=await Promise.all([
    vite.ssrLoadModule('/src/utils/pegboardSplit.ts'),vite.ssrLoadModule('/src/utils/openLattice.ts'),
    vite.ssrLoadModule('/src/utils/svgLattice.ts'),vite.ssrLoadModule('/src/utils/latticeFaceMesh.ts'),
    vite.ssrLoadModule('/src/utils/boardTexture.ts'),vite.ssrLoadModule('/src/utils/export3mf.ts')])
  const cfg={...split.PEGBOARD_DEFAULT_CONFIG,bedW:220,bedH:220,thickness:5,manufacturingChamfer:0}
  const panel=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:160,y:0},{x:160,y:160},{x:0,y:160}],holes:[]},cfg).panels[0]
  const plan=svg.estimateLatticeVolume(panel,cfg,svg.applyLatticeFrontLayer(panel,cfg,lattice.generateOpenLattice(panel,cfg,3.5,'hex'),1))
  const retained={...panel,latticeCutouts:plan.holes,latticeFace:plan.face}
  assert.ok(faces.isPlainRetainedFront(retained))
  const config={...texture.createDefaultBoardTexture(),enabled:true,source:'preset',presetId:'mono-checker',textureThickness:.8,
    surfaceMode:'snapcolor',modelingMode:'vector',manufacturingContours:true,edgeSealEnabled:false,baseColor:'#223344'}
  // Small, explicit colour context exercises the actual closed-mesh and 3MF
  // path without requiring a browser Canvas or remote calibration files.
  const context={config,canvas:{width:2,height:2},pixels:new Uint8ClampedArray([0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255]),
    lut:{layerCount:2,layerHeight:.2,colorCount:2,stacks:new Uint8Array([0,0,1,1]),labs:new Float32Array([0,0,0,100,0,0]),materials:[{name:'Blue',color:'#1122cc'},{name:'Pink',color:'#ee3388'}]},
    colors:['#1122cc','#ee3388'],bounds:{minX:0,minY:0,maxX:160,maxY:160,width:160,height:160},
    structuralThickness:4.2,textureThickness:.8,opticalStart:4.6,samplePitch:20,recipeCache:new Map(),vectorRegions:null,vectorRegionsMs:0,contourReports:[],budget:{}}
  const volume=xml=>[...xml.matchAll(/<mesh>([\s\S]*?)<\/mesh>/g)].reduce((total,[,body])=>{
    const vertices=[...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\s*\/>/g)].map(m=>m.slice(1).map(Number))
    let signed=0
    for(const m of body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"[^>]*\/>/g)){
      const [a,b,c]=m.slice(1,4).map(i=>vertices[Number(i)])
      signed+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6
    }
    return total+Math.abs(signed)
  },0)
  for(const backEnabled of [false,true]){
    const boardTexture={...config,backEnabled,backTexture:{...config,enabled:true}}
    const result=await exporter.createManufacturing3MF({panels:[retained],cfg,boardTexture,placedParts:[],partDefinitions:[],
      sharedTextureContext:context,sharedBackTextureContext:{...context,viewedFromBack:true}})
    const files=unzipSync(result.data)
    const model=strFromU8(Object.entries(files).find(([name])=>/3D\/Objects\/object_\d+\.model$/i.test(name))[1])
    const zs=[...model.matchAll(/<vertex[^>]+z="([^"]+)"/g)].map(m=>Number(m[1]))
    assert.equal(Math.min(...zs),0);assert.equal(Math.max(...zs),5)
    const actual=volume(model)
    // Existing colour parts use finer hole arcs than the preview volume estimate.
    const extruded=await faces.extrudeLatticeFace(plan.face)
    const adjustment=extruded.reduce((sum,p)=>sum+(p.volumeAdjustmentMm3??0),0)
    assert.ok(Math.abs(actual-plan.volumeMm3-adjustment)<plan.volumeMm3*.001,`volume outside explicit edge treatments changed: ${actual} / ${plan.volumeMm3} + ${adjustment}`)
    const settings=strFromU8(files['Metadata/project_settings.config'])
    assert.match(settings,/#1122cc/i);assert.match(settings,/#ee3388/i)
    assert.match(strFromU8(files['Metadata/model_settings.config']),/保留1.0mm图案正面/)
  }
  await assert.rejects(()=>exporter.createManufacturing3MF({panels:[retained],cfg,boardTexture:config,placedParts:[],partDefinitions:[],
    sharedTextureContext:{...context,textureThickness:1.2,structuralThickness:3.8}}),/正面保留厚度/)
  console.log('Retained texture passed: front/rear colour parts, closed 3MF, original 5mm envelope, unchanged material volume and thin-face validation.')
}finally{await vite.close()}
