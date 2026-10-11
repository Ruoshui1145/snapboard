import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,stat,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'vite'
const sourcePath=path.resolve(process.argv[2]??'已保存项目/长亮.snapboard')
const outputPath=path.resolve(process.argv[3]??'../output/review-20261011/project-soak.json')
const cycles=Number(process.argv[4]??25),warmup=5
assert.ok(Number.isInteger(cycles)&&cycles>=6&&cycles<=30)
assert.notEqual(outputPath,sourcePath)
const cache=await mkdtemp(path.join(tmpdir(),'snapboard-project-soak-'))
const server=await createServer({configFile:false,appType:'custom',logLevel:'silent',cacheDir:cache,server:{middlewareMode:true,hmr:false,ws:false}})
const rows=[],startedAt=new Date().toISOString(),report={command:`node --expose-gc scripts/verify-project-soak.mjs ${sourcePath} ${outputPath} ${cycles}`,startedAt,cycles,warmup,result:'running',rows,scope:'Node/Vite SSR project codec and Zustand store load, including sketch-state settling. No browser renderer, geometry rebuild, FPS or real-time-duration soak. Source file is read-only; serialization remains in memory.',limitations:['Memory includes Node/Vite, the original 94MB source string, original and reopened normalized workspaces, in-memory serialization and SHA-256 validation temporaries. Observed pre-GC peaks are test-harness peaks, not isolated application-window peaks.','Each cycle forces GC when --expose-gc is supplied; the stable retained set does not prove natural-GC GUI behavior.','Sub-millisecond phase times are rounded to 0ms.'],gcMode:globalThis.gc?'explicit GC between cycles to measure retained working set; peak also recorded before GC':'normal automatic GC only'}
const memory=()=>{const m=process.memoryUsage();return Object.fromEntries(['rss','heapUsed','heapTotal','external','arrayBuffers'].map(key=>[`${key}MiB`,Math.round(m[key]/1048576*100)/100]))}
const hash=value=>createHash('sha256').update(value).digest('hex')
const fingerprint=workspace=>{const digests={};for(const key of Object.keys(workspace).sort())digests[key]=hash(JSON.stringify(workspace[key])??'undefined');return digests}
const save=async()=>{await mkdir(path.dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2)+'\n')}
try{
 const before=await stat(sourcePath),source=await readFile(sourcePath,'utf8'),originalHash=hash(source)
 report.source={bytes:before.size,mtimeMs:before.mtimeMs,sha256:originalHash}
 const [file,store]=await Promise.all([server.ssrLoadModule('/src/utils/projectFile.ts'),server.ssrLoadModule('/src/store/useAppStore.ts')])
 let expected
 const round=async index=>{
  let start=performance.now()
  const parsed=file.parseProjectFile(source),parseMs=performance.now()-start
  const inputFingerprint=fingerprint(parsed.workspace)
  if(!expected){expected=inputFingerprint;report.workspace={projectName:parsed.workspace.project.metadata.name,panels:parsed.workspace.splitResult?.panels.length??0,placedParts:parsed.workspace.placedParts.length,boards:parsed.workspace.boards.length,fieldDigests:expected}}
  assert.deepEqual(inputFingerprint,expected,'Repeated opening must preserve every normalized workspace field')
  start=performance.now();store.useAppStore.getState().loadProjectWorkspace(parsed.workspace)
  const loadStoreMs=performance.now()-start
  const contours=parsed.workspace.project.parts.flatMap(p=>p.features).filter(f=>f.type==='sketch').flatMap(f=>f.contours).map(c=>c.id)
  const waitStart=performance.now()
  while(contours.some(id=>!(id in store.useAppStore.getState().ui.solveStates))){
   assert.ok(performance.now()-waitStart<30000,'Sketch-state settling timed out')
   await new Promise(resolve=>setImmediate(resolve))
  }
  const settleMs=performance.now()-waitStart
  const state=store.useAppStore.getState(),workspace=file.projectWorkspaceFromState(state)
  assert.equal(state.undoStack.length,0);assert.equal(state.redoStack.length,0);assert.equal(state.splitJob,null)
  assert.equal(state.ui.structurePreviewPanels,undefined,'An old trial must not enter the newly opened project')
  assert.deepEqual(fingerprint(workspace),expected,'Store loading must not silently drop project/manufacturing/texture fields')
  start=performance.now();const serialized=file.serializeProjectFile(workspace),serializeMs=performance.now()-start
  start=performance.now();const reopened=file.parseProjectFile(serialized),reparseMs=performance.now()-start
  assert.deepEqual(fingerprint(reopened.workspace),expected,'Save/reopen must retain sketches, panels, holes, textures, assembly and order identifiers')
  return {iteration:index,parseMs:Math.round(parseMs),loadStoreMs:Math.round(loadStoreMs),sketchSettleMs:Math.round(settleMs),serializeMs:Math.round(serializeMs),reparseMs:Math.round(reparseMs),serializedBytes:Buffer.byteLength(serialized),beforeGc:memory()}
 }
 for(let i=1;i<=cycles;i++){
  const row=await round(i);await new Promise(resolve=>setImmediate(resolve));globalThis.gc?.();row.afterGc=memory();rows.push(row)
  if(i%5===0||i===cycles){await save();console.log(JSON.stringify({iteration:i,parseMs:row.parseMs,serializeMs:row.serializeMs,reparseMs:row.reparseMs,heapMiB:row.afterGc.heapUsedMiB,rssMiB:row.afterGc.rssMiB}))}
 }
 const after=await stat(sourcePath);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(hash(await readFile(sourcePath,'utf8')),originalHash)
 const measured=rows.slice(warmup),stats=key=>{const values=measured.map(r=>r[key]).sort((a,b)=>a-b);return {min:values[0],median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1],max:values.at(-1)}}
 report.summary={completedCycles:rows.length,sourceUnchanged:true,timingsMs:Object.fromEntries(['parseMs','loadStoreMs','sketchSettleMs','serializeMs','reparseMs'].map(key=>[key,stats(key)])),retainedAfterWarmup:{first:measured[0].afterGc,last:measured.at(-1).afterGc,heapGrowthMiB:Math.round((measured.at(-1).afterGc.heapUsedMiB-measured[0].afterGc.heapUsedMiB)*100)/100,rssGrowthMiB:Math.round((measured.at(-1).afterGc.rssMiB-measured[0].afterGc.rssMiB)*100)/100},peakObservedRssMiB:Math.max(...rows.map(r=>r.beforeGc.rssMiB)),peakObservedHeapMiB:Math.max(...rows.map(r=>r.beforeGc.heapUsedMiB))}
 report.result='pass';report.finishedAt=new Date().toISOString();await save();console.log('PASS project codec/store soak: '+rows.length+' full read/load/save/reopen cycles; source unchanged')
}catch(error){report.result='failed';report.error={message:error.message,stack:error.stack};await save();throw error}
finally{await server.close();await rm(cache,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
