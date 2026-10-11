import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {unzipSync,strFromU8,strToU8,zipSync} from 'fflate'
import {mkdir,writeFile} from 'node:fs/promises'
const server=await createServer({appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
  const [split,lattice,svg,texture,exporter]=await Promise.all(['pegboardSplit','openLattice','svgLattice','boardTexture','export3mf'].map(n=>server.ssrLoadModule(`/src/utils/${n}.ts`)))
  const {manufacturingHeightRanges}=await server.ssrLoadModule('/src/utils/textureLayerDepths.ts')
  assert.deepEqual(manufacturingHeightRanges([{lo:0,hi:3,height:.28}],{depth:.4,height:.2},.25),[{lo:0,hi:2.49,height:.28},{lo:2.49,hi:2.6,height:.11},{lo:2.6,hi:3,height:.2}],'an aligned 3mm normal top already has its complete two layers')
  const side=manufacturingHeightRanges([{lo:0,hi:5,height:.28},{lo:.75,hi:4.25,height:.2}],{depth:.4,height:.2},.25)
  assert.deepEqual(side.at(-2),{lo:4.35,hi:4.6,height:.25},'a preceding side-letter range includes its exact upper sampling boundary')
  const cfg={...split.PEGBOARD_DEFAULT_CONFIG,thickness:5,manufacturingChamfer:0,bedKeepouts:[]}
  const panel=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:160,y:0},{x:160,y:160},{x:0,y:160}],holes:[]},cfg).panels[0]
  const plan=svg.applyLatticeFrontLayer(panel,cfg,lattice.generateOpenLattice(panel,cfg,3.5,'hex'),1)
  const retained={...panel,latticeFace:plan.face,latticeCutouts:plan.holes}
  const config={...texture.createDefaultBoardTexture(),enabled:true,source:'preset',surfaceMode:'snapcolor',textureThickness:1,edgeSealEnabled:false}
  const context={config,canvas:{width:2,height:2},pixels:new Uint8ClampedArray([0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255]),
    lut:{layerCount:5,layerHeight:.08,colorCount:2,stacks:new Uint8Array([0,0,0,0,0,1,1,1,1,1]),labs:new Float32Array([0,0,0,100,0,0]),materials:[{name:'White',color:'#ffffff'},{name:'Black',color:'#111111'}]},
    colors:['#ffffff','#111111'],bounds:{minX:0,minY:0,maxX:160,maxY:160,width:160,height:160},structuralThickness:4,textureThickness:1,opticalStart:4.6,
    samplePitch:40,recipeCache:new Map(),vectorRegions:null,vectorRegionsMs:0,contourReports:[],budget:{}}
  const input={cfg,panels:[retained],boardTexture:config,sharedTextureContext:context,placedParts:[],partDefinitions:[],assemblyMarking:{enabled:false}}
  const parse=(result,requiresFine=true)=>{
    const z=unzipSync(result.data),text=n=>strFromU8(z[n]),settings=JSON.parse(text('Metadata/project_settings.config'))
    const ranges=text('Metadata/layer_config_ranges.xml')
    if(requiresFine)assert.match(ranges,/<object id="1">/,'height ranges must use model ordinal 1, not mesh resource ID')
    assert.match(text('Metadata/model_settings.config'),/<metadata key="layer_height" value="0.28"\/>/,'whole board must carry the coarse layer height')
    assert.ok(settings.sparse_infill_speed.every(v=>Number(v)>Number(settings.inner_wall_speed[0])))
    assert.ok(settings.inner_wall_speed.every(v=>Number(v)>Number(settings.outer_wall_speed[0])))
    assert.ok(settings.initial_layer_speed.every(v=>Number(v)<Number(settings.outer_wall_speed[0])))
    assert.ok(settings.initial_layer_infill_speed.every(v=>Number(v)<Number(settings.internal_solid_infill_speed[0])))
    if(requiresFine){
      assert.ok(settings.initial_layer_infill_speed.every(v=>v==='80'),'bed-facing colour fill must have its own speed instead of wall speed')
      const model=text('Metadata/model_settings.config')
      const props=p=>Object.fromEntries([...p.matchAll(/key="([^"]+)" value="([^"]*)"/g)].map(m=>[m[1],m[2]]))
      for(const match of model.matchAll(/<part\b[\s\S]*?<\/part>/g)){
        const p=props(match[0])
        if(p.name.includes('SnapColor')){
          assert.equal(p.layer_height,undefined,'layer height belongs to object Z ranges, not a material volume');assert.equal(p.sparse_infill_density,'100%')
          assert.equal(p.bottom_shell_layers,'1','contact fill must be classifiable as BottomSurface, not first-layer internal fill')
          assert.equal(p.bottom_shell_thickness,'0','do not inherit a thick bottom shell across optical slices')
          assert.equal(p.outer_wall_speed,'60');assert.equal(p.inner_wall_speed,'100')
          assert.equal(p.internal_solid_infill_speed,'140');assert.equal(p.top_surface_speed,'100')
          assert.equal(p.gap_infill_speed,'80','narrow optical gaps must not retain the global 50mm/s fallback')
        }
        if(p.name.includes('顶部模具承托')){
          assert.equal(p.top_surface_line_width,'0.8','buried carrier top must use bulk fill width')
          assert.equal(p.top_surface_speed,'180','carrier must not fall back to the fine visible-face top speed')
        }
      }
    }
    assert.ok(settings.filament_max_volumetric_speed.every(v=>v==='21'),'do not raise the existing tested flow cap to fake faster printing')
    return {ranges,settings,z}
  }
  for(const [label,panels]of [['ordinary',[panel]],['hollow',[retained]]]){
    const result=await exporter.createManufacturing3MF({...input,panels})
    const {ranges,settings,z}=parse(result)
    assert.equal(settings.initial_layer_print_height,'0.08')
    assert.match(ranges,/<range min_z="0" max_z="0.4"><option opt_key="layer_height">0.08<\/option><\/range>/,label+' needs exactly the original five optical layers')
    assert.match(ranges,/<range min_z="0.4" max_z="4.6"><option opt_key="layer_height">0.28<\/option><\/range>/,label+' backing and core must not inherit optical height')
    assert.match(ranges,/<range min_z="4.6" max_z="5"><option opt_key="layer_height">0.2<\/option><\/range>/,label+' exposed Z top finishes with normal layers')
    if(process.argv.includes('--artifacts')&&label==='hollow'){
      const out='output/print-profile-regression';await mkdir(out,{recursive:true})
      await writeFile(out+'/fixed.3mf',result.data)
      // Same geometry, old process fields: isolates process changes from material removal.
      const legacy={...settings,initial_layer_speed:settings.initial_layer_speed.map(()=>'40'),initial_layer_infill_speed:settings.initial_layer_infill_speed.map(()=>'70')}
      for(const [key,value]of Object.entries({outer_wall_speed:'60',inner_wall_speed:'120',sparse_infill_speed:'100',internal_solid_infill_speed:'120',top_surface_speed:'120'}))legacy[key]=settings[key].map(()=>value)
      z['Metadata/project_settings.config']=strToU8(JSON.stringify(legacy))
      const model=strFromU8(z['Metadata/model_settings.config']).replace(/\n\s*<metadata key="layer_height" value="0.28"\/>\n\s*<metadata face_count/g,'\n    <metadata face_count')
        .replace(/<part\b[\s\S]*?<\/part>/g,p=>/骨架|承托/.test(p)?p.replace(/(key="outer_wall_speed" value=")[^"]+/, '$1200').replace(/(key="inner_wall_speed" value=")[^"]+/,'$1300').replace(/(key="top_surface_speed" value=")[^"]+/,'$1200'):p)
      z['Metadata/model_settings.config']=strToU8(model);delete z['Metadata/layer_config_ranges.xml']
      await writeFile(out+'/legacy-process.3mf',zipSync(z))
    }
  }
  const plain=parse(await exporter.createManufacturing3MF({...input,boardTexture:{...config,enabled:false},sharedTextureContext:undefined}),false)
  assert.equal(plain.settings.initial_layer_print_height,'0.25','plain retained front must not accidentally use a SnapColor first layer')
  assert.match(plain.ranges,/min_z="0" max_z="4.45"><option opt_key="layer_height">0.28/,'plain substrate stays coarse')
  assert.match(plain.ranges,/min_z="4.45" max_z="4.6"><option opt_key="layer_height">0.15/,'a short transition lands on the normal top interface')
  assert.match(plain.ranges,/min_z="4.6" max_z="5"><option opt_key="layer_height">0.2/,'only the plain Z top finishes finer')
  const streamed=parse(await exporter.createManufacturing3MFStreamed({...input,panels:[panel]}))
  assert.match(streamed.ranges,/min_z="0.4" max_z="4.6"/,'streamed native export must preserve print-space Z after releasing its meshes')
  console.log('Print plan passed: optical layers keep 0.08mm, core stays 0.28mm, exposed Z top finishes 0.2mm; exact 5mm envelope and streamed Z ranges.')
}finally{await server.close()}
