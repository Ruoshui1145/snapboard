import assert from 'node:assert/strict'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {unzipSync,strFromU8} from 'fflate'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const server=await createServer({root,configFile:false,appType:'custom',server:{middlewareMode:true}})
try{
 const [{createPreparedManufacturing3MF,packManufacturingObjects},{PEGBOARD_DEFAULT_CONFIG},{PREPARED_OPTICAL_PATH_SETTINGS}]=await Promise.all([
  server.ssrLoadModule('/src/utils/export3mf.ts'),server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
  server.ssrLoadModule('/src/utils/bambuPrintProfile.ts')])
 const native=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'../vendor/lumina-studio/source/bambu_config_template.json'),'utf8'))
 for(const [key,value] of Object.entries(PREPARED_OPTICAL_PATH_SETTINGS)) assert.equal(value,native[key],`optical ${key} must match the existing Lumina profile`)
 const box=(z,h)=>({name:'box',vertices:[[0,0,z],[20,0,z],[20,20,z],[0,20,z],[0,0,z+h],[20,0,z+h],[20,20,z+h],[0,20,z+h]],
  triangles:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]})
 const object=(key,parts,optical)=>({key,name:key,parts,frontOnBed:optical,mesh:box(0,2.4),kind:'part',quantity:1,preferredRotation:0,settings:{}})
 const optical=object('colour-board',[
  {name:'白色结构背托',extruder:1,color:'#FFFFFF',mesh:box(1,1.4),settings:{layer_height:'0.20'}},
  {name:'白色承托层',extruder:1,color:'#FFFFFF',mesh:box(.4,.6),settings:{layer_height:'0.20',sparse_infill_density:'100%'}},
  // This is the actual failing input: an unsupported enum and zero skins.
  {name:'colour',extruder:4,color:'#0064F0',mesh:box(0,.4),settings:{layer_height:'0.08',wall_loops:'0',top_shell_layers:'0',bottom_shell_layers:'0',sparse_infill_density:'100%',sparse_infill_pattern:'rectilinear',sparse_infill_speed:'30',initial_layer_line_width:'0.5',inner_wall_line_width:'0.45',sparse_infill_line_width:'0.45',wall_generator:'classic'}},
 ],true)
 const base=object('base',[{name:'base',extruder:1,color:'#FFFFFF',mesh:box(0,2.4),settings:{layer_height:'0.20'}}],false)
 Object.assign(optical,{printGroup:'optical',printGroupName:'叠色板'})
 Object.assign(base,{printGroup:'base',printGroupName:'白色基体'})
 const cfg={...PEGBOARD_DEFAULT_CONFIG,printerPreset:'bambu-p1s',bedW:256,bedH:256}
 const result=await createPreparedManufacturing3MF({objects:[optical,base],cfg,colors:['#FFFFFF','#DC143C','#FFE600','#0064F0'],title:'optical import regression'})
 const zip=unzipSync(result.data),project=JSON.parse(strFromU8(zip['Metadata/project_settings.config'])),model=strFromU8(zip['Metadata/model_settings.config'])
 assert.equal(project.sparse_infill_density,'100%','lost object/part overrides must inherit dense optical fill')
 assert.equal(project.sparse_infill_pattern,'zig-zag')
 assert.equal(project.internal_solid_infill_pattern,'zig-zag')
 assert.equal(project.enable_prime_tower,'1')
 assert.equal(project.layer_height,'0.2')
 assert.equal(project.initial_layer_print_height,'0.08')
 assert.equal(project.initial_layer_line_width,'0.5','optical body width must not overwrite standard bed-contact width')
 assert.doesNotMatch(model,/key="initial_layer(?:_infill)?_line_width"/,'all objects and child volumes inherit editable first-layer width')
 assert.equal(result.plateCount,2,'optical and structural print groups must not share a bed')
 assert.deepEqual(result.plates.map(p=>p.printGroup),['optical','base'])
 assert.match(model,/key="plater_name" value="叠色板 01 · colour-board"/)
 assert.match(model,/key="plater_name" value="白色基体 01 · base"/)
 const large={...optical,mesh:{...box(0,2.4),vertices:box(0,2.4).vertices.map(([x,y,z])=>[x*10,y*7,z])}}
 const overflow=packManufacturingObjects([large,base,{...large,key:'second-optical'}],cfg)
 assert.deepEqual(overflow.map(p=>p.printGroup),['optical','optical','base'],'later optical beds remain before structural beds')
 overflow.forEach((p,i)=>p.instances.forEach(instance=>assert.equal(instance.plate,i)))
 assert.equal(project.precise_z_height,'0')
 const ranges=strFromU8(zip['Metadata/layer_config_ranges.xml'])
 const schedules=[...ranges.matchAll(/<object id="\d+">([\s\S]*?)<\/object>/g)].map(m=>m[1])
 assert.equal(new Set(schedules).size,1,'mechanical and colour objects must share every height range')
 assert.match(schedules[0],/min_z="0" max_z="0.4"[\s\S]*?>0.08</)
 assert.match(schedules[0],/min_z="0.4"[\s\S]*?>0.2</)
 assert.equal(project.wipe_tower_x.length,result.plateCount)
 for(const plate of result.plates) for(const item of plate.instances) {
  const b=item.worldBounds
  assert.ok(b.maxX<=176||b.minX>=251||b.maxY<=186||b.minY>=251,'objects must leave room for the prime tower')
 }
 assert.equal(project.locked_skin_infill_pattern,undefined,'unrelated experimental defaults are omitted')
 for(const [key,value] of Object.entries(PREPARED_OPTICAL_PATH_SETTINGS)) {
  assert.equal(project[key],value,`project fallback ${key}`)
  assert.ok(project.different_settings_to_system[0].split(';').includes(key),`import must retain ${key}`)
 }
 assert.doesNotMatch(model,/value="rectilinear"/)
 const objects=[...model.matchAll(/<object id="\d+">([\s\S]*?)<\/object>/g)].map(m=>m[1])
 const mechanical=objects.find(s=>s.includes('value="base"'));assert.match(mechanical,/key="sparse_infill_density" value="15%"/)
 const coloured=objects.find(s=>s.includes('value="colour-board"'));assert.match(coloured,/key="sparse_infill_density" value="100%"/)
 const part=[...coloured.matchAll(/<part [^>]+>([\s\S]*?)<\/part>/g)].map(m=>m[1]).find(s=>s.includes('value="colour"'))
 assert.match(part,/key="sparse_infill_pattern" value="zig-zag"/)
 assert.match(part,/key="wall_loops" value="1"/)
 assert.match(part,/key="bottom_shell_layers" value="1"/)
 for(const [key,value] of Object.entries(PREPARED_OPTICAL_PATH_SETTINGS)) {
  assert.ok(part.includes(`key="${key}" value="${value}"`),`optical part ${key}`)
  assert.ok(coloured.includes(`key="${key}" value="${value}"`),`optical parent ${key}`)
 }
 assert.match(mechanical,/key="wall_generator" value="classic"/,'mechanical body retains ordinary paths')
 assert.match(mechanical,/key="inner_wall_line_width" value="0.45"/)
 const backing=[...coloured.matchAll(/<part [^>]+>([\s\S]*?)<\/part>/g)].map(m=>m[1]).find(s=>s.includes('value="白色结构背托"'))
 assert.match(backing,/key="wall_generator" value="classic"/)
 assert.match(backing,/key="inner_wall_line_width" value="0.45"/)
 assert.doesNotMatch(part,/key="[^"]*speed"/,'speed remains editable')
 // Object and project defaults remain dense if an import drops the child override.
 assert.equal(project.sparse_infill_density,'100%');assert.match(coloured,/key="sparse_infill_density" value="100%"/)
 console.log('PASS separate print groups and named beds; standard 0.50 mm editable first layer; 0.42 mm optical body paths; shared heights and dense fill')
}finally{await server.close()}
