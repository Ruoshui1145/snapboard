import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import os from 'node:os'
const root=path.resolve('output/lattice-comparison'), presets='D:/Bambu Studio/resources/profiles/BBL'
const all=[]
async function collect(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())await collect(p);else if(entry.name.endsWith('.json')){try{all.push({file:p,data:JSON.parse(await fs.readFile(p,'utf8'))})}catch{}}}}
for(const category of ['machine','process','filament'])await collect(path.join(presets,category))
const resolve=file=>{const record=all.find(x=>x.file===file);if(!record)throw new Error('preset missing '+file);const parent=record.data.inherits?all.find(x=>x.data.name===record.data.inherits&&x.data.type===record.data.type):null;return {...(parent?resolve(parent.file):{}),...record.data}}
await fs.mkdir(path.join(root,'profiles'),{recursive:true})
const chosen=[['machine',path.join(presets,'machine','Bambu Lab P1S 0.4 nozzle.json')],['process',path.join(presets,'process','0.20mm Standard @BBL X1C.json')],['filament',path.join(presets,'filament','P1P','Generic PETG @BBL P1P.json')]]
for(const [kind,file]of chosen){const data=resolve(file);data.inherits='';data.from='user';data.instantiation='true';
  if(kind==='process')Object.assign(data,{layer_height:'0.2',wall_loops:'2',sparse_infill_density:'10%',top_shell_layers:'3',bottom_shell_layers:'3',top_shell_thickness:'0.6',bottom_shell_thickness:'0.6',brim_type:'no_brim',enable_support:'0',outer_wall_line_width:'0.42',inner_wall_line_width:'0.42'})
  await fs.writeFile(path.join(root,'profiles',kind+'.json'),JSON.stringify(data,null,2))}
const report=JSON.parse(await fs.readFile(path.join(root,'comparison-estimates.json'),'utf8'))
const only=process.argv[2]
for(const row of report.rows.filter(r=>!only||r.id===only)){
  const out=path.join(os.tmpdir(),'snapboard-lattice-slice',row.id);await fs.mkdir(out,{recursive:true})
  for(const name of ['machine','process','filament'])await fs.copyFile(path.join(root,'profiles',name+'.json'),path.join(out,name+'.json'))
  const input=path.join(out,'input.3mf');await fs.copyFile(path.join(root,row.id+'.3mf'),input)
  const log=await new Promise((resolve,reject)=>{
    const args=['--estimate-mode','--datadir',path.join(os.tmpdir(),'snapboard-lattice-cli-data'),'--load-settings',path.join(out,'machine.json')+';'+path.join(out,'process.json'),
      '--load-filaments',path.join(out,'filament.json'),'--arrange','1','--orient','0','--slice','0','--mstpp','90','--skip-useless-pick','1','--debug','2','--export-3mf',row.id+'-sliced.3mf','--outputdir',out,input]
    const child=spawn('D:/Bambu Studio/bambu-studio.exe',args,{windowsHide:true,cwd:'D:/Bambu Studio'});let text='';console.log('CLI',row.id,'PID',child.pid)
    const logChunk=b=>{text+=b;process.stdout.write(b);void fs.appendFile(path.join(out,'live.log'),b)};child.stdout.on('data',logChunk);child.stderr.on('data',logChunk)
    const timeout=setTimeout(()=>child.kill(),120000)
    child.on('error',error=>{clearTimeout(timeout);reject(error)});child.on('exit',code=>{clearTimeout(timeout);resolve({code,text})})
  })
  await fs.writeFile(path.join(out,'cli.log'),log.text)
  row.sliceExitCode=log.code
  try{row.sliceResult=JSON.parse(await fs.readFile(path.join(out,'result.json'),'utf8'))}catch{row.sliceResult=null}
  const saved=path.join(root,'sliced',row.id);await fs.mkdir(saved,{recursive:true})
  for(const entry of await fs.readdir(out))if(entry.endsWith('.json')||entry.endsWith('.3mf')||entry.endsWith('.gcode')||entry.endsWith('.log'))await fs.copyFile(path.join(out,entry),path.join(saved,entry))
  await fs.writeFile(path.join(root,'comparison-sliced.json'),JSON.stringify(report,null,2))
  console.log(row.id,'exit',log.code,log.text.slice(-900))
}
