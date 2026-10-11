import {extrudeLatticeFace,latticeMeshesFromData,type LatticeMeshPart} from './latticeFaceMesh'
import {currentSvgFace} from './svgLattice'
import type {LatticeFaceData,SplitPanel,SplitConfig} from '../types/geometry'
// Only completed data is shared: cancelling one viewport must not cancel another consumer.
const cache=new Map<LatticeFaceData,{modes:Map<boolean,LatticeMeshPart[]>;bytes:number}>()
const MAX_CACHE_BYTES=64*1024*1024
let cacheBytes=0
function remember(face:LatticeFaceData,preserveFace:boolean,parts:LatticeMeshPart[]){
  const bytes=parts.reduce((sum,part)=>sum+8*(part.data.vertices.length+part.data.triangles.length),0)
  if(bytes>MAX_CACHE_BYTES)return
  const entry=cache.get(face)??{modes:new Map<boolean,LatticeMeshPart[]>(),bytes:0}
  const previous=entry.modes.get(preserveFace)
  if(previous)return
  entry.modes.set(preserveFace,parts);entry.bytes+=bytes;cacheBytes+=bytes
  cache.delete(face);cache.set(face,entry)
  // Undo history can retain old faces, so WeakMap alone cannot bound these large arrays.
  while(cacheBytes>MAX_CACHE_BYTES||cache.size>32){
    const oldest=cache.keys().next().value!
    cacheBytes-=cache.get(oldest)!.bytes;cache.delete(oldest)
  }
}

/** Cancel stale WASM jobs immediately; successful jobs leave no idle worker heap. */
export async function createLatticeFacePreview(face:LatticeFaceData,color:number|string,panel:SplitPanel,cfg:SplitConfig,preserveFace=true,signal?:AbortSignal){
  signal?.throwIfAborted()
  face=currentSvgFace(panel,cfg)
  const entry=cache.get(face)
  let ready=entry?.modes.get(preserveFace)
  if(ready){cache.delete(face);cache.set(face,entry!)}
  if(!ready){
    ready=typeof Worker==='undefined' ? await extrudeLatticeFace(face,panel,cfg,preserveFace) : await new Promise<LatticeMeshPart[]>((resolve,reject)=>{
      let worker:Worker|undefined,settled=false
      const cleanup=()=>{signal?.removeEventListener('abort',cancel);if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate()}}
      const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(error)}
      const cancel=()=>fail(signal?.reason??new DOMException('已取消三维筋架计算','AbortError'))
      try{
        worker=new Worker(new URL('../workers/latticeFaceMesh.worker.ts',import.meta.url),{type:'module'})
        worker.onerror=event=>fail(new Error(event.message||'筋架后台计算失败'))
        worker.onmessageerror=()=>fail(new Error('筋架后台返回的数据无法读取，请重新生成'))
        worker.onmessage=event=>{
          if(settled)return
          try{
            if(event.data.error)throw new Error(event.data.error)
            const parts=event.data.parts.map((part:LatticeMeshPart)=>({...part,data:{vertices:Array.from(part.data.vertices),triangles:Array.from(part.data.triangles)}}))
            if(import.meta.env.DEV)performance.mark('snapboard:lattice-mesh-worker',{detail:{parts:parts.length}})
            settled=true;cleanup();resolve(parts)
          }catch(error){fail(error)}
        }
        signal?.addEventListener('abort',cancel,{once:true})
        if(signal?.aborted){cancel();return}
        worker.postMessage({face,preserveFace})
      }catch(error){fail(error)}
    })
    signal?.throwIfAborted()
    remember(face,preserveFace,ready)
  }
  signal?.throwIfAborted()
  return latticeMeshesFromData(ready,color)
}
