import assert from 'node:assert/strict'
import {createServer} from 'vite'
const server=await createServer({appType:'custom',server:{middlewareMode:true}})
try{
 const {generatePreset}=await server.ssrLoadModule('/src/features/shapeLibrary/presets/index.ts')
 const {presetToShapeDraft}=await server.ssrLoadModule('/src/features/shapeLibrary/adapters.ts')
 const {applyShapeDraft}=await server.ssrLoadModule('/src/features/shapeLibrary/applyShape.ts')
 const {useAppStore}=await server.ssrLoadModule('/src/store/useAppStore.ts')
 const {createManufacturing3MF}=await server.ssrLoadModule('/src/utils/export3mf.ts')
 for(const id of ['rectangle','square','rounded-rectangle','circle','ellipse']){
  const draft=presetToShapeDraft(id,{width:160,height:120,cornerRadius:18})
  applyShapeDraft(draft,'replace-outer')
  await useAppStore.getState().runAutoSplit()
  const s=useAppStore.getState();assert.ok(s.splitResult?.panels.length>0,id+' splits')
  const output=await createManufacturing3MF({panels:s.splitResult.panels,cfg:s.splitConfig,placedParts:[],partDefinitions:[]})
  assert.ok(output.data.length>1000,id+' exports closed 3MF')
  if(id==='square'||id==='circle')assert.equal(draft.stats.width,draft.stats.height)
 }
 assert.equal(generatePreset('rounded-rectangle',{width:120,height:80,cornerRadius:0}).points.length,4)
 const max=generatePreset('rounded-rectangle',{width:120,height:80,cornerRadius:999})
 assert.equal(max.params.cornerRadius,40)
 assert.throws(()=>generatePreset('rounded-rectangle',{cornerRadius:NaN}),/radius/)
 console.log('P0: 5 presets applied, split and exported; equal dimensions and radius limits passed')
}finally{await server.close()}
