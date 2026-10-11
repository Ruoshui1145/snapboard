import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { installNativeSvgDom } from './native-svg-dom.mjs'
import { unzipSync, strFromU8 } from 'fflate'

installNativeSvgDom()
const vite = await createServer({ appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false} })
try {
  const [{ workshopSvgArtwork, sharedSvgStructureOnly }, { generateSvgLattice, DEFAULT_SVG_LATTICE_OPTIONS },
    { createDefaultBoardTexture }, { createManufacturing3MF }, { splitOrthogonalPolygon, PEGBOARD_DEFAULT_CONFIG },
    { useAppStore }, { serializeProjectFile, parseProjectFile }] = await Promise.all([
    vite.ssrLoadModule('/src/utils/workshopSvgLattice.ts'),vite.ssrLoadModule('/src/utils/svgLattice.ts'),
    vite.ssrLoadModule('/src/utils/boardTexture.ts'),vite.ssrLoadModule('/src/utils/export3mf.ts'),
    vite.ssrLoadModule('/src/utils/pegboardSplit.ts'),vite.ssrLoadModule('/src/store/useAppStore.ts'),vite.ssrLoadModule('/src/utils/projectFile.ts'),
  ])
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#222"/></svg>'
  const asset={id:'svg',name:'test.svg',mime:'image/svg+xml',dataUrl:`data:image/svg+xml,${encodeURIComponent(svg)}`,width:100,height:100,aspect:1,revision:'1'}
  const layer={id:'layer-svg',kind:'image',name:'test',assetId:asset.id,visible:true,locked:false,opacity:1,
    placement:{mode:'free',fit:'stretch',crop:{x:0,y:0,width:1,height:1},transform:{xMm:80,yMm:80,widthMm:80,heightMm:40,rotationDeg:0,flipX:false,flipY:false}}}
  const cfg={...PEGBOARD_DEFAULT_CONFIG,bedW:220,bedH:220,thickness:5}
  const panel=splitOrthogonalPolygon({points:[{x:0,y:0},{x:160,y:0},{x:160,y:160},{x:0,y:160}],holes:[]},cfg).panels[0]
  const bounds={minX:0,minY:0,width:160,height:160}
  const bbox=art=>art.fills.flat(3).reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity])
  const original=workshopSvgArtwork(asset,layer,bounds,[panel])
  assert.deepEqual(bbox(original).map(v=>Math.round(v)),[56,68,104,92], 'nonuniform dimensions must match the existing layer millimetres')
  const rotated=workshopSvgArtwork(asset,{...layer,placement:{...layer.placement,transform:{...layer.placement.transform,rotationDeg:90}}},bounds,[panel])
  assert.deepEqual(bbox(rotated).map(v=>Math.round(v)),[68,56,92,104])
  const cropped=workshopSvgArtwork(asset,{...layer,placement:{...layer.placement,crop:{x:0,y:0,width:.5,height:1}}},bounds,[panel])
  assert.deepEqual(bbox(cropped).map(v=>Math.round(v)),[72,68,120,92], 'source crop and target clipping must remain aligned')
  const repeat={...layer,placement:{...layer.placement,mode:'repeat',repeat:{kind:'grid',gapXmm:10,gapYmm:10,alternateFlipX:false,alternateFlipY:false}}}
  assert.ok(workshopSvgArtwork(asset,repeat,bounds,[panel]).fills.length>1)
  const strokeAsset={...asset,dataUrl:`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M20 50 L80 50" fill="none" stroke="#222" stroke-width="2"/></svg>')}`}
  assert.ok(workshopSvgArtwork(strokeAsset,layer,bounds,[panel]).fills.length, 'ordinary stroked line drawings must work too')
  const texture={...createDefaultBoardTexture(),enabled:true,source:'composition',baseColor:'#eeeeee',composition:{schemaVersion:1,assets:[asset],layers:[layer]}}
  assert.equal(sharedSvgStructureOnly(texture,[panel],[layer.id]),true)
  assert.equal(sharedSvgStructureOnly({...texture,composition:{...texture.composition,layers:[layer,{...layer,id:'second'}]}},[panel],[layer.id]),false)
  for (const baseStyle of ['hex','organic','diamond']) {
    const opts={...DEFAULT_SVG_LATTICE_OPTIONS,coverage:'whole',baseStyle,sourceLayerId:layer.id}
    const lattice=generateSvgLattice(panel,cfg,original,3.5,'svg',opts)
    assert.equal(lattice.face.source.templateStyle,baseStyle,'SVG source must not override the selected skeleton')
    const result=await createManufacturing3MF({panels:[{...panel,latticeCutouts:lattice.holes,latticeFace:lattice.face}],cfg,boardTexture:texture,placedParts:[],partDefinitions:[]})
    const files=unzipSync(result.data)
    assert.ok(/#eeeeee/i.test(strFromU8(files['Metadata/project_settings.config'])), 'shared structural face must retain the workshop base material colour')
  }
  useAppStore.setState({splitConfig:cfg,splitResult:{sources:[],panels:[panel],warnings:[],config:cfg,ts:Date.now()}})
  const before=useAppStore.getState().splitResult
  useAppStore.getState().setUI({structureOpen:true,structurePreviewPanels:[{...panel,latticeCutouts:original.fills.map(p=>p[0].slice(0,-1).map(([x,y])=>({x,y})))}]})
  assert.equal(useAppStore.getState().splitResult,before,'candidate preview must not write applied geometry')
  const state=useAppStore.getState()
  const saved=parseProjectFile(serializeProjectFile({project:state.project,boards:state.boards,placedParts:state.placedParts,boardTexture:state.boardTexture,
    assemblyMarking:state.assemblyMarking,lastTextureSampling:state.lastTextureSampling,assemblyScene:state.assemblyScene,
    splitConfig:state.splitConfig,splitResult:state.splitResult,spatialLayout:state.spatialLayout}))
  assert.equal(saved.workspace.splitResult.panels[0].latticeCutouts,undefined,'unsaved candidates must not leak into project or exports')
  console.log('Structure/workshop passed: placement, nonuniform size, rotation, crop, repeat, stroked SVG, independent skeletons, shared single-layer 3MF and unsaved candidates')
} finally { await vite.close() }
