import assert from 'node:assert/strict'
import {getEventListeners} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {createServer} from 'vite'
const directory=await mkdtemp(path.join(tmpdir(),'snapboard-preview-lifecycle-'))
const server=await createServer({configFile:false,appType:'custom',logLevel:'error',cacheDir:path.join(directory,'vite'),server:{middlewareMode:true,hmr:false}})
const previous=globalThis.Worker,originalLoad=GLTFLoader.prototype.loadAsync
class WorkerFixture {
  static instances=[]
  static throws=null
  static live=0
  static peak=0
  constructor(){if(WorkerFixture.throws==='constructor')throw new Error('worker unavailable');WorkerFixture.instances.push(this);WorkerFixture.live++;WorkerFixture.peak=Math.max(WorkerFixture.peak,WorkerFixture.live)}
  postMessage(request){this.request=request;if(WorkerFixture.throws==='post')throw new Error('cannot clone')}
  terminate(){if(!this.stopped)WorkerFixture.live--;this.stopped=(this.stopped??0)+1}
  result(data){this.onmessage?.({data})}
}
try{
  const {createLatticeFacePreview}=await server.ssrLoadModule('/src/utils/latticeFacePreview.ts')
  const {disposePreviewResources,claimPreviewBuildState,appendPreviewResource,capturePreviewReplay,invalidatePreviewReplay}=await server.ssrLoadModule('/src/utils/previewResources.ts')
  globalThis.Worker=WorkerFixture
  const invoke=(controller,face={layers:[]})=>createLatticeFacePreview(face,'#ffffff',{latticeFace:face},{},true,controller?.signal)
  const last=()=>WorkerFixture.instances.at(-1)
  const triangles={parts:[{role:'structure',data:{vertices:[0,0,0,1,0,0,0,1,0],triangles:[0,1,2]}}]}
  const disposed=resource=>{const counter={count:0};resource.addEventListener('dispose',()=>counter.count++);return counter}
  // Finish the cancelled build's awaited work after its replacement has started.
  const busyScene=new THREE.Scene(),oldBusy=claimPreviewBuildState(busyScene)
  oldBusy(true)
  let finishOld
  const oldAwait=new Promise(resolve=>{finishOld=resolve})
  const lateCleanup=(async()=>{await oldAwait;oldBusy(false)})()
  oldBusy(false) // React cleanup runs before starting the next effect.
  const newBusy=claimPreviewBuildState(busyScene);newBusy(true)
  finishOld();await lateCleanup
  assert.equal(busyScene.userData.latticeBuilding,true,'Late old completion must not clear the new build busy state')
  oldBusy(false)
  assert.equal(busyScene.userData.latticeBuilding,true,'A stale cleanup cannot clear the new task either')
  newBusy(false);assert.equal(busyScene.userData.latticeBuilding,false,'Only the owning task clears its state')
  const replayBusy=claimPreviewBuildState(busyScene);replayBusy(true)
  newBusy(false)
  assert.equal(busyScene.userData.latticeBuilding,true,'A retained replay callback claims fresh busy ownership after a failed replacement')
  replayBusy(false)
  const retainedReplayCallback=()=>capturePreviewReplay(busyScene)
  const runningReplay=retainedReplayCallback()
  assert.equal(runningReplay(),true)
  invalidatePreviewReplay(busyScene)
  assert.equal(runningReplay(),false,'Starting a replacement invalidates active replay even while the old assembly stays visible')
  const replayAfterReuse=retainedReplayCallback()
  assert.equal(replayAfterReuse(),true,'A retained replay callback must capture a fresh invocation after same-panel effect reuse')
  invalidatePreviewReplay(busyScene)
  assert.equal(replayAfterReuse(),false,'Effect cleanup also invalidates the active invocation')
  const retiredBase=new THREE.Group();let currentBase=retiredBase,finishModel
  const modelReady=new Promise(resolve=>{finishModel=resolve})
  const delayedAttach=appendPreviewResource(retiredBase,modelReady,()=>currentBase===retiredBase)
  currentBase=null;disposePreviewResources(retiredBase)
  const lateMesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial())
  const lateCounts=[lateMesh.geometry,lateMesh.material].map(disposed)
  finishModel(lateMesh)
  assert.equal(await delayedAttach,false)
  assert.equal(retiredBase.children.length,0,'Late replay models cannot attach to an already disposed group')
  assert.deepEqual(lateCounts.map(c=>c.count),[1,1],'Late mesh geometry and material must be released exactly once')
  const liveBase=new THREE.Group(),liveMesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial())
  assert.equal(await appendPreviewResource(liveBase,Promise.resolve(liveMesh),()=>true),true)
  assert.equal(liveMesh.parent,liveBase);disposePreviewResources(liveBase)
  // Long sessions repeatedly replace an in-flight build: every WASM heap is stopped.
  for(let i=0;i<200;i++){
    const controller=new AbortController(),job=invoke(controller),worker=last(),late=worker.onmessage
    controller.abort()
    await assert.rejects(job,error=>error.name==='AbortError')
    assert.equal(worker.stopped,1)
    assert.equal(getEventListeners(controller.signal,'abort').length,0)
    late({data:triangles})
    assert.equal(worker.stopped,1,'Late replies cannot settle or revive a cancelled job')
  }
  // Sharing a face does not make one viewport own another viewport's cancellation.
  const cancellationPeak=WorkerFixture.peak
  assert.equal(WorkerFixture.live,0,'No worker remains after repeated cancellation')
  const shared={layers:[]},a=new AbortController(),b=new AbortController()
  const first=invoke(a,shared),firstWorker=last(),second=invoke(b,shared),secondWorker=last()
  a.abort();await assert.rejects(first,error=>error.name==='AbortError')
  assert.equal(firstWorker.stopped,1);assert.equal(secondWorker.stopped,undefined)
  secondWorker.result(triangles)
  const meshes=await second;assert.equal(meshes.length,1);assert.equal(secondWorker.stopped,1)
  assert.equal(getEventListeners(b.signal,'abort').length,0)
  const count=WorkerFixture.instances.length,cached=await invoke(undefined,shared)
  assert.equal(WorkerFixture.instances.length,count,'Successful geometry is reused')
  assert.notEqual(cached[0].geometry,meshes[0].geometry,'Cached data creates independently owned meshes')
  for(const mesh of [...meshes,...cached])disposePreviewResources(mesh)
  for(const failure of ['onerror','onmessageerror','bad-response','post','constructor']){
    const controller=new AbortController();WorkerFixture.throws=failure
    const task=invoke(controller),worker=last()
    if(failure==='onerror')worker.onerror({message:'calculation failed'})
    if(failure==='onmessageerror')worker.onmessageerror({})
    if(failure==='bad-response')worker.result({parts:null})
    await assert.rejects(task)
    assert.equal(getEventListeners(controller.signal,'abort').length,0)
    if(failure!=='constructor')assert.equal(worker.stopped,1)
    WorkerFixture.throws=null
  }
  const pre=new AbortController();pre.abort();const before=WorkerFixture.instances.length
  await assert.rejects(invoke(pre),error=>error.name==='AbortError');assert.equal(WorkerFixture.instances.length,before)
  const oldest={layers:[]},oldJob=invoke(undefined,oldest);last().result({parts:[]});await oldJob
  const newer=[]
  for(let i=0;i<34;i++){const face={layers:[]};newer.push(face);const job=invoke(undefined,face);last().result({parts:[]});await job}
  let workers=WorkerFixture.instances.length
  await invoke(undefined,newer.at(-1));assert.equal(WorkerFixture.instances.length,workers,'Recent entries remain reusable')
  const evicted=invoke(undefined,oldest);assert.equal(WorkerFixture.instances.length,workers+1,'Undo-retained old faces do not retain unlimited preview data');last().result({parts:[]});await evicted

  // Resources shared with the retained assembly must survive old-assembly disposal.
  const geometry=new THREE.BoxGeometry(),texture=new THREE.Texture();texture.userData.snapboardTexture=true
  const material=new THREE.MeshBasicMaterial({map:texture}),g=disposed(geometry),m=disposed(material),t=disposed(texture)
  const old=new THREE.Group(),live=new THREE.Group();old.add(new THREE.Mesh(geometry,material));live.add(new THREE.Mesh(geometry,material))
  disposePreviewResources(old,live);assert.deepEqual([g.count,m.count,t.count],[0,0,0])
  disposePreviewResources(live);assert.deepEqual([g.count,m.count,t.count],[1,1,1])
  // Removing one textured panel reuses the remaining panel from the mesh cache.
  // Both panels share the uploaded image, but own their geometry and material.
  const scene=new THREE.Scene(),oldAssembly=new THREE.Group(),nextAssembly=new THREE.Group()
  const sharedMap=new THREE.Texture();sharedMap.userData.snapboardTexture=true
  const removedPanel=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial({map:sharedMap}))
  const cachedPanel=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial({map:sharedMap}))
  const sharedCount=disposed(sharedMap),removedCounts=[removedPanel.geometry,removedPanel.material].map(disposed)
  const retainedCounts=[cachedPanel.geometry,cachedPanel.material].map(disposed)
  oldAssembly.add(removedPanel,cachedPanel);scene.add(oldAssembly)
  const previousRoots=[oldAssembly];nextAssembly.add(cachedPanel)
  scene.add(nextAssembly)
  for(const root of previousRoots){scene.remove(root);disposePreviewResources(root,scene)}
  assert.equal(sharedCount.count,0,'Panel removal must not dispose the image still used by a cached live panel')
  assert.deepEqual(removedCounts.map(c=>c.count),[1,1]);assert.deepEqual(retainedCounts.map(c=>c.count),[0,0])
  scene.remove(nextAssembly);disposePreviewResources(nextAssembly,scene)
  assert.equal(sharedCount.count,1);assert.deepEqual(retainedCounts.map(c=>c.count),[1,1])
  const viewport=await readFile(new URL('../src/components/viewport/Viewport3D.tsx',import.meta.url),'utf8')
  const swap=viewport.slice(viewport.indexOf('if (previousAssembly) previousAssembly.name'),viewport.indexOf('stagedAssembly=null'))
  assert.ok(swap.indexOf('scene.add(assembly)')>=0&&swap.indexOf('scene.add(assembly)')<swap.indexOf('disposeSubtree(child)'),
    'The actual synchronous viewport swap must publish retained resources before old roots are disposed')
  // Imported texture templates are shared by cloned parts, while label canvases are owned.
  const templateTexture=new THREE.Texture(),template=disposed(templateTexture),part=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial({map:templateTexture}))
  disposePreviewResources(part);assert.equal(template.count,0)
  const labelMap=new THREE.Texture();labelMap.userData.snapboardTexture=true
  const label=new THREE.Sprite(new THREE.SpriteMaterial({map:labelMap})),labelCount=disposed(labelMap),spriteGeometry=disposed(label.geometry)
  disposePreviewResources(label);assert.equal(labelCount.count,1);assert.equal(spriteGeometry.count,0,'Global Sprite geometry must survive label removal')
  const {loadPartModel,loadPrintablePartModel}=await server.ssrLoadModule('/src/utils/glbLoader.ts')
  const originalTexture=new THREE.Texture(),originalGeometry=new THREE.BoxGeometry(),originalMaterial=new THREE.MeshStandardMaterial({map:originalTexture})
  const sourcePart=new THREE.Mesh(originalGeometry,originalMaterial),templateCounts=[originalTexture,originalGeometry,originalMaterial].map(disposed)
  let attempts=0
  GLTFLoader.prototype.loadAsync=async()=>{attempts++;if(attempts===1)throw new Error('temporary network failure');return {scene:sourcePart}}
  const url='https://fixture.invalid/retry-preview.glb'
  await assert.rejects(loadPartModel(url),/temporary network failure/)
  const firstPart=await loadPartModel(url),secondPart=await loadPrintablePartModel(url)
  assert.equal(attempts,2,'Failed loads can retry and successful templates are shared')
  for(const root of [firstPart,secondPart])root.traverse(object=>{if(object.isMesh){assert.notEqual(object.geometry,originalGeometry);assert.notEqual(object.material,originalMaterial);assert.equal(object.material.map,originalTexture)}})
  disposePreviewResources(firstPart);disposePreviewResources(secondPart)
  assert.deepEqual(templateCounts.map(count=>count.count),[0,0,0],'Instance disposal must not destroy GLB templates')
  assert.equal(WorkerFixture.live,0,'No worker remains after success or failure')
  const result={command:'node scripts/verify-preview-lifecycle.mjs',testedAt:new Date().toISOString(),cancellations:200,workerFixture:{cancellationPeak,totalPeak:WorkerFixture.peak,remaining:WorkerFixture.live,totalCreated:WorkerFixture.instances.length},checks:['abort removes listener and terminates worker','late reply ignored','consumers cancel independently','successful data cached, instance geometry isolated','error/serialization/construction/postMessage failures clean up','shared live resources preserved','owned label texture disposed, imported template retained','LRU evicts old faces despite undo references','failed GLB load retries, cloned geometry/material ownership verified'],result:'pass',scope:'Deterministic worker protocol and Three.js resource lifecycle; not browser FPS or a wall-clock soak test'}
  result.checks.push('real cached panel handoff retains shared texture until its final owner is removed','late awaited completion and stale cleanup cannot clear replacement build busy state','late replay mesh is disposed instead of attaching to a retired group; current replay mesh attaches normally')
  result.checks.push('replay invocation invalidates while old assembly remains visible; retained callback can replay again after same-panel reuse')
  if(process.argv[2]){await mkdir(path.dirname(process.argv[2]),{recursive:true});await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n')}
  console.log('PASS preview lifecycle: 200 cancellations, independent consumers, successful cache reuse, all worker error paths, retained shared texture handoff, late-build busy-state ownership, bounded cache and GLB retry/ownership')
}finally{globalThis.Worker=previous;GLTFLoader.prototype.loadAsync=originalLoad;await server.close();await rm(directory,{recursive:true,force:true})}
