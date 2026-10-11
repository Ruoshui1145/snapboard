import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const directory=await mkdtemp(path.join(tmpdir(),'snapboard-worker-check-'))
const server=await createServer({configFile:false,appType:'custom',cacheDir:path.join(directory,'vite'),server:{middlewareMode:true,hmr:false}})
const previous=globalThis.Worker
class WorkerFixture {
  static instances=[]
  constructor(){WorkerFixture.instances.push(this)}
  terminate(){this.terminated=true}
  postMessage(request){this.request=request}
  message(data){this.onmessage({data:{jobId:this.request.jobId,...data}})}
  error(message='',filename=''){this.onerror({message,filename,lineno:1})}
}
try {
  const {startSplitWorker}=await server.ssrLoadModule('/src/utils/splitWorkerClient.ts')
  const {PEGBOARD_DEFAULT_CONFIG}=await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const request={jobId:1,targets:[{contourId:'rectangle',name:'fixture',sourceIds:['rectangle'],points:[{x:0,y:0},{x:160,y:0},{x:160,y:120},{x:0,y:120}],cornerPolicy:'auto'}],config:PEGBOARD_DEFAULT_CONFIG,holes:[]}
  globalThis.Worker=WorkerFixture
  const before=()=>WorkerFixture.instances.length,last=()=>WorkerFixture.instances.at(-1)
  let count=before(),progress=[]
  const retry=startSplitWorker(request,(done,total)=>progress.push([done,total]));const failed=last()
  failed.error();assert.equal(before(),count+2);assert.equal(failed.terminated,true)
  failed.message({type:'result',sources:[]});assert.equal(last().terminated,undefined,'Old worker messages are discarded')
  last().message({type:'progress',completed:0,total:1});last().message({type:'progress',completed:1,total:1})
  last().message({type:'result',sources:[{contourId:'rectangle',panels:[],warnings:[],coverageRatio:1}]})
  assert.equal((await retry.promise).length,1);assert.deepEqual(progress,[[0,1],[1,1]])
  count=before();const unavailable=startSplitWorker(request);last().error();last().error()
  await assert.rejects(unavailable.promise,/自动重试仍失败/);assert.equal(before(),count+2,'Startup retries stop after one retry')
  count=before();const crash=startSplitWorker(request);last().message({type:'progress',completed:0,total:1});last().error('fixture runtime error','worker.js')
  await assert.rejects(crash.promise,/fixture runtime error.*worker\.js/);assert.equal(before(),count+1,'A calculation crash is not retried as a startup failure')
  const controller=new AbortController(),cancelled=startSplitWorker(request,undefined,controller.signal),initial=last()
  initial.error();const replacement=last();controller.abort()
  await assert.rejects(cancelled.promise,error=>error.name==='AbortError');assert.equal(replacement.terminated,true)
  count=before();replacement.error();assert.equal(before(),count,'Cancellation prevents further workers')
  const calculation=startSplitWorker(request);last().message({type:'error',message:'invalid geometry'})
  await assert.rejects(calculation.promise,/invalid geometry/)
  globalThis.Worker=undefined
  const result=await startSplitWorker(request).promise;assert.ok(result[0].panels.length);assert.equal(result[0].coverageRatio,1)
  console.log('PASS split worker: transient startup recovery, bounded retry, runtime diagnostics, stale-response filtering, cancellation during retry, algorithm errors and Node fallback')
}finally{globalThis.Worker=previous;await server.close();await rm(directory,{recursive:true,force:true})}
