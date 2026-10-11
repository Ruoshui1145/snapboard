import assert from 'node:assert/strict'
import {createServer} from 'vite'
const server=await createServer({appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
  const [split,texture,preview,depths,lattice,svg]=await Promise.all(['pegboardSplit','boardTexture','manufacturingLayerPreview','textureLayerDepths','openLattice','svgLattice'].map(n=>server.ssrLoadModule(`/src/utils/${n}.ts`)))
  const cfg={...split.PEGBOARD_DEFAULT_CONFIG,thickness:5,bedKeepouts:[],manufacturingChamfer:0}
  const panel=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:160,y:0},{x:160,y:160},{x:0,y:160}],holes:[]},cfg).panels[0]
  const config={...texture.createDefaultBoardTexture(),enabled:true,source:'preset',edgeSealEnabled:false}
  const original=JSON.stringify([panel,cfg,config]),plan=preview.createLayerPreviewPlate(panel,cfg,config)
  assert.deepEqual(plan.sections.map(s=>s.name),['叠色层','承托层','基层'])
  assert.deepEqual(plan.sections.map(s=>Number((s.hi-s.lo).toFixed(6))),[.4,.6,4])
  assert.equal(plan.sections[0].opticalLayerCount,5);assert.equal(plan.sections[0].opticalLayerHeight,.08)
  assert.equal(plan.bands.find(b=>b.kind==='optical').source,undefined,'the structure schematic must work before any canvas or LUT data is loaded')
  const up=preview.createLayerPreviewPlate(panel,cfg,{...config,surfaceFinish:'smooth-top'})
  assert.deepEqual(up.sections.map(s=>s.name),plan.sections.map(s=>s.name),'schematic order is front to back, independent of print orientation')
  const dual=preview.createLayerPreviewPlate(panel,cfg,{...config,backEnabled:true})
  assert.deepEqual(dual.sections.map(s=>s.name),['正面叠色层','正面承托层','基层','背面承托层','背面叠色层'])
  const plain=preview.createLayerPreviewPlate(panel,cfg,{...config,enabled:false})
  assert.deepEqual(plain.sections.map(s=>s.name),['基层'])
  for(const mode of ['veneer','woodgrain']){
    const p=preview.createLayerPreviewPlate(panel,cfg,{...config,surfaceMode:mode})
    assert.equal(p.materials.length,2);assert.deepEqual(p.sections.map(s=>s.name),['质感贴面','基层'])
    assert.deepEqual(p.sections.map(s=>s.hi-s.lo),[1,4])
  }
  const clear=preview.createLayerPreviewPlate(panel,cfg,{...config,surfaceMode:'veneer',surfaceMaterialKind:'transparent-petg',surfacePrintGoal:'clear-experimental'})
  assert.equal(clear.sections.length,2,'a fine transparent print process must not create more schematic layers')
  const six=preview.createLayerPreviewPlate(panel,cfg,{...config,lutId:'snapcolor-petg-5color'})
  assert.equal(six.sections.length,3);assert.equal(six.sections[0].opticalLayerCount,6,'five materials must still use the six physical layers in their LUT')
  const opticalLut={layerCount:3,colorCount:2,stacks:new Uint8Array([0,1,2,255,2,1])}
  assert.deepEqual(Array.from(preview.opticalPreviewMaterials(opticalLut,0)),[0,-1])
  assert.deepEqual(Array.from(preview.opticalPreviewMaterials(opticalLut,1)),[1,2])
  assert.deepEqual(Array.from(preview.opticalPreviewMaterials(opticalLut,2)),[2,1])
  assert.throws(()=>preview.opticalPreviewMaterials(opticalLut,-1),/序号无效/)
  assert.throws(()=>preview.opticalPreviewMaterials(opticalLut,3),/序号无效/)
  const hollow=svg.applyLatticeFrontLayer(panel,cfg,lattice.generateOpenLattice(panel,cfg,3.5,'hex'),1)
  const retained=preview.createLayerPreviewPlate({...panel,latticeFace:hollow.face,latticeCutouts:hollow.holes},cfg,config)
  assert.equal(retained.sections.length,3)
  assert.deepEqual(retained.base,plain.base,'retained front must exclude only real functional holes, never rear windows')
  assert.equal(preview.createLayerPreviewPlate(panel,{...cfg,thickness:6},config).sections.at(-1).hi,5)
  assert.equal(JSON.stringify([panel,cfg,config]),original,'schematics cannot mutate engineering data')
  assert.deepEqual(depths.manufacturingHeightRanges([{lo:0,hi:.4,height:.08},{lo:.4,hi:5,height:.28}]),[{lo:0,hi:.4,height:.08},{lo:.4,hi:5,height:.28}])
  const tile={width:3,height:1,materialIds:new Uint8Array([0,1,255]),counts:[1,1],rgba:new Uint8ClampedArray([255,255,255,255,23,45,67,255,0,0,0,0])}
  const pixels=preview.layerPreviewPixels(tile,[{color:'#ffffff'},{color:'#0064f0'}],1)
  assert.deepEqual(Array.from(pixels.slice(4,8)),[23,45,67,255]);assert.equal(pixels[3],45);assert.equal(pixels[11],0)
  const ownPalette={width:1,height:1,materialIds:new Uint8Array([0]),counts:[1],materials:[{name:'红色',color:'#dc143c'}]}
  assert.deepEqual(Array.from(preview.layerPreviewPixels(ownPalette,[{color:'#0064f0'}])),[220,20,60,255],'individual optical layers must display filament colours, not composite group colours')
  console.log('Material structure preview passed: 2/3 logical groups preserved; real optical order, empty recipe cells, five-material/six-layer LUT, own filament palette, retained holes and read-only diagrams.')
}finally{await server.close()}
