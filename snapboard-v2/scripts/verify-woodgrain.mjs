import assert from 'node:assert/strict'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { unzipSync,strFromU8 } from 'fflate'
// Bambu Studio v02.08.02.60 PresetBundle.cpp:3791-3809; missing indices default to [1].
function checkBambuImportConfig(settings) {
  const count=settings.filament_colour.length,variants=settings.filament_extruder_variant??['Direct Drive Standard']
  const indices=settings.filament_self_index??['1']
  assert.ok(count>0&&variants.length===indices.length&&variants.length>=count,'Bambu 拒绝：耗材变体与 self_index 长度不一致')
  assert.deepEqual(indices.map(Number),Array.from({length:count},(_,i)=>i+1),'两个料槽不能都指向第一种耗材')
  for(const kind of ['printer','print']){
    const variants=settings[`${kind}_extruder_variant`],ids=settings[`${kind}_extruder_id`]
    assert.equal(ids.length,variants.length,`${kind} 挤出变体与喷头 ID 须逐项对应`)
    assert.ok(ids.every(id=>Number(id)>=1&&Number(id)<=settings.nozzle_diameter.length))
  }
  assert.equal(settings.nozzle_type.length,settings.printer_extruder_variant.length)
  assert.equal(settings.machine_max_speed_x.length,settings.printer_extruder_variant.length*2,'运动参数须覆盖每种喷嘴变体的常规/静音模式')
  for(const key of ['outer_wall_speed','inner_wall_speed','sparse_infill_speed','internal_solid_infill_speed','top_surface_speed','initial_layer_speed','initial_layer_infill_speed'])
    assert.equal(settings[key].length,settings.print_extruder_variant.length,`${key} 须按工艺变体排列，不能按料槽排列`)
  assert.ok(Array.isArray(settings.print_compatible_printers))
  assert.equal(settings.extruder_printable_height.length,settings.nozzle_diameter.length,'喷头可打印高度不能为空，且须对应每个物理喷头')
  assert.ok(settings.extruder_printable_height.every(h=>Number.isFinite(Number(h))&&Number(h)>0))
  assert.equal(settings.different_settings_to_system.length,count+2,'工艺/耗材/打印机覆盖项须按项目顺序排列')
  assert.ok(settings.different_settings_to_system[0].split(';').includes('sparse_infill_density'),'基材低填充不能在导入时被系统预设覆盖')
  assert.ok(settings.different_settings_to_system.at(-1).split(';').includes('extruder_printable_height'),'导入恢复系统预设后也不能把喷头高度重新变成空数组')
}
const server=await createServer({appType:'custom',server:{middlewareMode:true}})
try {
  const { normalizeWoodGrain,normalizeWoodGrainTexture,DEFAULT_WOOD_GRAIN,woodGrainModifier,createWoodGrainField,createWoodGrainPanelField }=await server.ssrLoadModule('/src/utils/woodGrain.ts')
  const { createDefaultBoardTexture,hasBoardTextureSource }=await server.ssrLoadModule('/src/utils/boardTexture.ts')
  const { createManufacturing3MF,packManufacturingObjects }=await server.ssrLoadModule('/src/utils/export3mf.ts')
  const { getPrintBedBounds,polygonIntersectsRect }=await server.ssrLoadModule('/src/utils/printBed.ts')
  const { PEGBOARD_DEFAULT_CONFIG,splitOrthogonalPolygon }=await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const { createDefaultAssemblyMarking }=await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
  const { serializeProjectFile,parseProjectFile }=await server.ssrLoadModule('/src/utils/projectFile.ts')
  const { useAppStore }=await server.ssrLoadModule('/src/store/useAppStore.ts')
  const { createSplitPanelShape }=await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const { texturePolygon }=await server.ssrLoadModule('/src/utils/texturePolygon.ts')
  const { BAMBU_PRINTER_PRESETS,splitConfigForPrinter }=await server.ssrLoadModule('/src/utils/bambuPrinterPresets.ts')
  const cfg={...PEGBOARD_DEFAULT_CONFIG},bounds={minX:0,minY:0,width:100,height:100}
  const panel=splitOrthogonalPolygon({points:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],holes:[]},cfg).panels[0]
  const wood={...DEFAULT_WOOD_GRAIN},field=createWoodGrainField(wood,bounds)
  assert.equal(normalizeWoodGrain({scale:NaN,seed:-1}).scale,1)
  assert.deepEqual(normalizeWoodGrain({...wood,source:{data:'old-large-mesh'},rotationXDegrees:90}),wood,'旧工程应去除原件依赖与嵌入网格')
  const samples=Array.from({length:1000},(_,i)=>field.sample(i%100,Math.floor(i/100)*10))
  assert.ok(samples.filter(n=>n>0).length>100&&samples.filter(n=>n<0).length>100)
  assert.notDeepEqual(samples,samples.map((_,i)=>createWoodGrainField({...wood,seed:1},bounds).sample(i%100,Math.floor(i/100)*10)))
  const modifier=await woodGrainModifier(panel,cfg,wood,bounds)
  assert.ok(modifier.mesh&&modifier.mesh.triangles.length>0)
  assert.equal(Math.min(...modifier.mesh.vertices.filter((_,i)=>i%3===2)),4,'修改器只从木纹薄层底部开始，不能进入基材')
  assert.ok(modifier.mesh.triangles.length<300_000,'单板不应嵌入百万面圆柱')
  const shape=createSplitPanelShape(panel,cfg,24).extractPoints(24)
  const holeArea=texturePolygon.intersection(modifier.polygons,texturePolygon.union(...shape.holes.map(r=>[[r.map(p=>[p.x,p.y])]])))
  assert.equal(holeArea.length,0,'算法修改区域不得覆盖已开启的功能孔')
  for(let i=0;i<modifier.mesh.vertices.length;i+=3){
    const [x,y,z]=modifier.mesh.vertices.slice(i,i+3)
    assert.ok(x>=-.00001&&x<=100.00001&&y>=-.00001&&y<=100.00001&&z>=4&&z<=cfg.thickness,'修改区域必须限制在上方 1 mm 质感层内')
  }
  const edges=new Map()
  for(let i=0;i<modifier.mesh.triangles.length;i+=3)for(let j=0;j<3;j++){
    const a=modifier.mesh.triangles[i+j],b=modifier.mesh.triangles[i+(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`
    edges.set(key,(edges.get(key)??0)+1)
  }
  assert.ok([...edges.values()].every(n=>n===2),'修改器必须是闭合网格')
  const translatedPanel={...panel,x:panel.x-215,y:panel.y+137,
    contour:panel.contour?.map(p=>({x:p.x-215,y:p.y+137})),
    slots:panel.slots.map(p=>({...p,x:p.x-215,y:p.y+137})),
    round_holes:panel.round_holes.map(p=>({...p,x:p.x-215,y:p.y+137})),
    edge_holes:panel.edge_holes.map(p=>({...p,x:p.x-215,y:p.y+137}))}
  const moved=await woodGrainModifier(translatedPanel,cfg,wood,{minX:-215,minY:137,width:100,height:100})
  for(let i=0;i<moved.mesh.vertices.length;i+=3)assert.ok(moved.mesh.vertices[i]>=-.00001&&moved.mesh.vertices[i]<=100.00001&&
    moved.mesh.vertices[i+1]>=-.00001&&moved.mesh.vertices[i+1]<=100.00001,'草图原点改变后，修改器仍须使用板件局部坐标')
  const controller=new AbortController();controller.abort()
  await assert.rejects(woodGrainModifier(panel,cfg,wood,bounds,controller.signal),{name:'AbortError'})
  const seamX=43.37,blank={...panel,slots:[],round_holes:[],edge_holes:[],cutouts:[],outerCorners:[false,false,false,false]}
  const continuous={...wood,distribution:'continuous'}
  const left=await woodGrainModifier({...blank,x:0,w:seamX,contour:undefined},{...cfg,cornerRadius:0},continuous,bounds)
  const right=await woodGrainModifier({...blank,x:seamX,w:100-seamX,contour:undefined},{...cfg,cornerRadius:0},continuous,bounds)
  const seam=regions=>regions.flatMap(p=>p.flatMap(r=>r.flatMap((a,i)=>{
    const b=r[(i+1)%r.length];return Math.abs(a[0]-seamX)<1e-6&&Math.abs(b[0]-seamX)<1e-6?[Math.min(a[1],b[1]),Math.max(a[1],b[1])]:[]
  }))).sort((a,b)=>a-b)
  assert.deepEqual(seam(left.polygons),seam(right.polygons),'非网格整数尺寸分板也须保持木纹接缝一致')
  const texture=normalizeWoodGrainTexture({...createDefaultBoardTexture(),enabled:true,surfaceMode:'woodgrain',woodGrain:wood})
  assert.equal(hasBoardTextureSource(texture),true,'新工程无需导入即可启用和导出木纹')
  const input={panels:[panel],cfg,placedParts:[],boardTexture:texture,assemblyMarking:{...createDefaultAssemblyMarking(),enabled:false},projectName:'algorithm-woodgrain'}
  const model=await createManufacturing3MF(input),zip=unzipSync(model.data)
  const catalog=JSON.parse(strFromU8(zip['Metadata/snapboard-manufacturing-catalog.json']))
  assert.equal(catalog.product.mappingCode,'MV','new woodgrain manufacturing files use the material veneer category')
  assert.equal(catalog.product.colourCode,'C00');assert.equal(catalog.product.profile,'woodgrain-veneer-v2')
  const settings=JSON.parse(strFromU8(zip['Metadata/project_settings.config']))
  checkBambuImportConfig(settings)
  const missingIndices={...settings};delete missingIndices.filament_self_index
  assert.throws(()=>checkBambuImportConfig(missingIndices),/self_index/,'必须复现并拦住旧文件的真实导入报错')
  assert.throws(()=>checkBambuImportConfig({...settings,printer_extruder_id:['1']}),/喷头 ID/)
  assert.throws(()=>checkBambuImportConfig({...settings,extruder_printable_height:[]}),/可打印高度/,'必须拦住旧文件的空高度向量')
  assert.deepEqual(settings.filament_type,['PETG','PETG']);assert.equal(settings.single_extruder_multi_material,'1')
  assert.equal(settings.layer_height,'0.28');assert.equal(settings.sparse_infill_density,'10%');assert.equal(settings.sparse_infill_pattern,'gyroid')
  assert.deepEqual(settings.filament_colour,[texture.baseColor,texture.surfaceColor],'普通料与仿木料应有独立料槽')
  assert.equal(settings.printer_model,'Bambu Lab P1S');assert.match(settings.machine_start_gcode,/P1S/);assert.doesNotMatch(settings.machine_start_gcode,/machine: H2D/)
  assert.deepEqual(settings.print_extruder_id,['1','1'],'P1S 必须沿用本机两个挤出变体，不能混入 H2D 的双喷头配置')
  assert.deepEqual(settings.nozzle_volume_type,['Standard'])
  const official=JSON.parse(await readFile('src/assets/woodgrain-bambu-printer-configs.json','utf8'))
  const smallPanel={...panel,w:40,h:40,contour:undefined,slots:[],round_holes:[],edge_holes:[]}
  for(const preset of BAMBU_PRINTER_PRESETS){
    const printerCfg={...cfg,...splitConfigForPrinter(preset.id)}
    const data=unzipSync((await createManufacturing3MF({...input,cfg:printerCfg,panels:[smallPanel]})).data)
    const config=JSON.parse(strFromU8(data['Metadata/project_settings.config']))
    checkBambuImportConfig(config)
    assert.deepEqual(config.printer_extruder_id,({...official.common,...official.printers[preset.id]}).printer_extruder_id,'不能用物理喷头数覆盖官方的变体索引')
    const heights=({...official.common,...official.printers[preset.id]}).extruder_printable_height
    assert.deepEqual(config.extruder_printable_height,heights.length?heights:Array.from({length:preset.extruderCount??1},()=>String(preset.printableHeight)),'单喷头补齐高度；双喷头须保留官方不同的高度限制')
    assert.equal(config.version,'02.08.02.60');assert.equal(config.sparse_infill_density,'10%')
    assert.match(strFromU8(data['3D/Objects/object_1.model']),/<triangle /,'配置检查不能用空模型蒙混通过')
  }
  const metadata=strFromU8(zip['Metadata/model_settings.config'])
  assert.match(metadata,/subtype="modifier_part"/)
  assert.match(metadata,/<metadata key="infill_direction" value="45"\/>/);assert.match(metadata,/<metadata key="infill_direction" value="135"\/>/)
  const partMeta=[...metadata.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)]
  assert.equal(partMeta.length,3,'基材、木纹薄层、表层修改器应分别独立')
  assert.match(partMeta[0][2],/key="extruder" value="1"/);assert.match(partMeta[0][2],/key="sparse_infill_density" value="10%"/)
  assert.match(partMeta[0][2],/key="fuzzy_skin" value="none"/);assert.doesNotMatch(partMeta[0][2],/key="layer_height"/,'volume settings must not override whole-object layer height')
  assert.match(partMeta[1][2],/key="extruder" value="2"/);assert.match(partMeta[1][2],/key="sparse_infill_density" value="100%"/)
  assert.match(partMeta[2][1],/subtype="modifier_part"/);assert.match(partMeta[2][2],/key="extruder" value="2"/)
  assert.match(strFromU8(zip['Metadata/layer_config_ranges.xml']),/min_z="0" max_z="3.84"><option opt_key="layer_height">0.28/)
  assert.match(strFromU8(zip['Metadata/layer_config_ranges.xml']),/min_z="3.84" max_z="4"><option opt_key="layer_height">0.16/,'only a short transition aligns the real veneer interface')
  assert.match(strFromU8(zip['Metadata/layer_config_ranges.xml']),/min_z="4" max_z="4.88"><option opt_key="layer_height">0.08/)
  assert.match(strFromU8(zip['Metadata/layer_config_ranges.xml']),/min_z="4.88" max_z="5"><option opt_key="layer_height">0.12/,'the final legal layer preserves actual 5mm height')
  const report=JSON.parse(strFromU8(zip['Metadata/snapboard-export-report.json']))
  assert.equal(report.woodGrain.algorithm,'growth-rings-v2');assert.equal(report.woodGrain.source,undefined)
  assert.deepEqual(report.woodGrain.materialSlots,{base:1,woodVeneer:2});assert.equal(report.woodGrain.surfaceThicknessMm,1)
  const shiftedPanels=[[-320,-180],[120,200]].map(([x,y],i)=>({...splitOrthogonalPolygon({points:[{x,y},{x:x+200,y},{x:x+200,y:y+210},{x,y:y+210}],holes:[]},cfg).panels[0],id:`offset-${i}`,printRotation:90}))
  const shiftedModel=await createManufacturing3MF({...input,panels:shiftedPanels})
  assert.equal(shiftedModel.plateCount,2)
  const shiftedZip=unzipSync(shiftedModel.data),rootXml=strFromU8(shiftedZip['3D/3dmodel.model']),meshXml=strFromU8(shiftedZip['3D/Objects/object_1.model'])
  const attr=(text,key)=>new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(text)?.[1]
  const meshes=new Map([...meshXml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)].map(m=>[attr(m[1],'id'),{
    modifier:attr(m[1],'type')==='other',points:[...m[2].matchAll(/<vertex\b([^>]*)\/>/g)].map(v=>['x','y','z'].map(axis=>Number(attr(v[1],axis))))}]))
  const parents=new Map([...rootXml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)].map(m=>[attr(m[1],'id'),[...m[2].matchAll(/<component\b([^>]*)\/>/g)].map(c=>({id:attr(c[1],'objectid'),matrix:attr(c[1],'transform').split(' ').map(Number)}))]))
  const apply=(p,m)=>[m[0]*p[0]+m[3]*p[1]+m[6]*p[2]+m[9],m[1]*p[0]+m[4]*p[1]+m[7]*p[2]+m[10],m[2]*p[0]+m[5]*p[1]+m[8]*p[2]+m[11]]
  const box=points=>({minX:Math.min(...points.map(p=>p[0])),minY:Math.min(...points.map(p=>p[1])),maxX:Math.max(...points.map(p=>p[0])),maxY:Math.max(...points.map(p=>p[1]))})
  for(const [plate,item]of [...rootXml.matchAll(/<item\b([^>]*)\/>/g)].entries()){
    const transform=attr(item[1],'transform').split(' ').map(Number)
    const components=parents.get(attr(item[1],'objectid')).map(c=>({...meshes.get(c.id),points:meshes.get(c.id).points.map(p=>apply(apply(p,c.matrix),transform))}))
    const body=box(components.find(c=>!c.modifier).points),modifier=box(components.find(c=>c.modifier).points)
    const normals=components.filter(c=>!c.modifier),zRange=c=>[Math.min(...c.points.map(p=>p[2])),Math.max(...c.points.map(p=>p[2]))]
    assert.deepEqual(zRange(normals[0]),[0,4],'基材只到质感层下沿')
    assert.deepEqual(zRange(normals[1]),[4,5],'昂贵木纹料只出现在上方质感层')
    assert.deepEqual(zRange(components.find(c=>c.modifier)),[4,5],'修改器不得进入基材')
    assert.ok(modifier.minX>=body.minX-.001&&modifier.maxX<=body.maxX+.001&&modifier.minY>=body.minY-.001&&modifier.maxY<=body.maxY+.001,
      '实际 3MF 中，旋转、平移和第二盘变换后的修改器也必须与板件重合')
    const originX=plate*cfg.bedW*1.2
    assert.ok(body.minX>=originX+5-.001&&body.maxX<=originX+cfg.bedW-5+.001&&body.minY>=5-.001&&body.maxY<=cfg.bedH-5+.001)
    assert.ok(Math.abs((body.minX+body.maxX)/2-originX-cfg.bedW/2)<.001&&Math.abs((body.minY+body.maxY)/2-cfg.bedH/2)<.001,'单板盘应在安全区域居中')
  }
  const clone={...panel,id:'second-board'}
  const cloneField=createWoodGrainPanelField(wood,clone,bounds),firstField=createWoodGrainPanelField(wood,panel,bounds)
  assert.notEqual(cloneField.variantSeed,firstField.variantSeed)
  const at=i=>[5+i%9*10,5+Math.floor(i/9)*10]
  const firstSamples=Array.from({length:81},(_,i)=>firstField.sample(...at(i))>0)
  const secondSamples=Array.from({length:81},(_,i)=>cloneField.sample(...at(i))>0)
  assert.notDeepEqual(firstSamples,secondSamples,'同尺寸的独立板件默认应生成不同纹路')
  assert.deepEqual(firstSamples,firstSamples.map((_,i)=>createWoodGrainPanelField(wood,panel,bounds).sample(...at(i))>0),'重复预览/导出不能重新抽随机数')
  const twins=await createManufacturing3MF({...input,panels:[panel,clone]})
  const twinZip=unzipSync(twins.data),twinReport=JSON.parse(strFromU8(twinZip['Metadata/snapboard-export-report.json']))
  const rootItems=[...strFromU8(twinZip['3D/3dmodel.model']).matchAll(/<item objectid="([^"]+)"/g)]
  assert.equal(new Set(rootItems.map(m=>m[1])).size,2,'同尺寸板件不得复用第一个木纹对象')
  assert.notEqual(twinReport.woodGrain.panelVariants[0].variantSeed,twinReport.woodGrain.panelVariants[1].variantSeed)
  const modifierBodies=[...strFromU8(twinZip['3D/Objects/object_1.model']).matchAll(/<object[^>]*type="other"[^>]*>([\s\S]*?)<\/object>/g)].map(m=>m[1])
  assert.equal(modifierBodies.length,2);assert.notEqual(modifierBodies[0],modifierBodies[1],'实际 3MF 中两个修改器的几何必须不同')
  await assert.rejects(createManufacturing3MF({...input,boardTexture:{...texture,textureThickness:5}}),/木纹质感层/)
  const legacyCfg={...cfg,bedMarginLeft:0,bedMarginRight:0,bedMarginBottom:0,bedMarginTop:0}
  assert.equal(getPrintBedBounds(legacyCfg).minX,5,'旧工程的零边距也不得贴热床边缘')
  assert.equal(getPrintBedBounds({...cfg,bedMarginLeft:12}).minX,12)
  const packingMesh={name:'fixture',vertices:[[0,0,0],[80,0,0],[80,40,0],[0,40,0]],triangles:[]}
  const packingObject={key:'fixture',name:'fixture',mesh:packingMesh,parts:[{mesh:packingMesh}],preferredRotation:0,quantity:2,kind:'part'}
  for(const bedKeepouts of [[],[{id:'center',enabled:true,x:90,y:100,w:50,h:60}]]){
    const packed=packManufacturingObjects([packingObject],{...legacyCfg,bedKeepouts})
    assert.equal(packed.length,1,'整盘居中不得破坏原先能同盘排放的紧凑布局')
    for(const instance of packed[0].instances){const b=instance.worldBounds
      assert.ok(b.minX>=5&&b.maxX<=cfg.bedW-5&&b.minY>=5&&b.maxY<=cfg.bedH-5)
      assert.ok(bedKeepouts.every(zone=>!polygonIntersectsRect([{x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}],{minX:zone.x,minY:zone.y,maxX:zone.x+zone.w,maxY:zone.y+zone.h})))
    }
  }
  const state=useAppStore.getState(),project={project:state.project,boards:state.boards,placedParts:[],splitConfig:cfg,splitResult:null,
    assemblyScene:state.assemblyScene,assemblyMarking:state.assemblyMarking,spatialLayout:state.spatialLayout,boardTexture:{...texture,woodGrain:{...wood,source:{data:'obsolete'}}},lastTextureSampling:null}
  const opened=parseProjectFile(serializeProjectFile(project))
  assert.equal(opened.workspace.boardTexture.enabled,true);assert.equal(opened.workspace.boardTexture.surfaceMode,'woodgrain');assert.deepEqual(opened.workspace.boardTexture.woodGrain,wood)
  assert.deepEqual(firstSamples,firstSamples.map((_,i)=>createWoodGrainPanelField(opened.workspace.boardTexture.woodGrain,panel,bounds).sample(...at(i))>0),'保存重开必须保留相同逐板纹路')
  const legacy=normalizeWoodGrainTexture({...texture,baseColor:'#A57B4B',woodGrain:{...wood,algorithm:'growth-rings-v1'}},true)
  assert.equal(legacy.baseColor,'#F3F3EE');assert.equal(legacy.surfaceColor,'#A57B4B')
  await mkdir('output/woodgrain-algorithm',{recursive:true});await writeFile('output/woodgrain-algorithm/algorithm.3mf',model.data)
  const pla=await createManufacturing3MF({...input,boardTexture:{...texture,woodGrain:{...wood,filamentType:'PLA'}}})
  checkBambuImportConfig(JSON.parse(strFromU8(unzipSync(pla.data)['Metadata/project_settings.config'])))
  await writeFile('output/woodgrain-algorithm/algorithm-pla.3mf',pla.data)
  await writeFile('output/woodgrain-algorithm/aligned-two-plate.3mf',shiftedModel.data)
  await writeFile('output/woodgrain-algorithm/wood-veneer-repaired.3mf',twins.data)
  await writeFile('output/woodgrain-algorithm/wood-veneer-config-fixed.3mf',twins.data)
  await writeFile('output/woodgrain-algorithm/wood-veneer-height-fixed.3mf',twins.data)
  console.log(`木纹薄贴面回归通过：4mm 普通基材/10% 填充 + 1mm 木纹层；修改器限于 4..5mm；两块同尺寸板独立变化且重开可复现，坐标和安全边距通过。`)
}finally{await server.close()}
