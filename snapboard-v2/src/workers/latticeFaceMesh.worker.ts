/// <reference lib="webworker" />
import {extrudeLatticeFace} from '../utils/latticeFaceMesh'
import type {LatticeFaceData} from '../types/geometry'
self.addEventListener('message',async(event:MessageEvent<{face:LatticeFaceData;preserveFace:boolean}>)=>{
  try{
    const parts=await extrudeLatticeFace(event.data.face,undefined,undefined,event.data.preserveFace)
    const transfer:ArrayBuffer[]=[]
    const result=parts.map(part=>{
      const vertices=Float64Array.from(part.data.vertices),triangles=Uint32Array.from(part.data.triangles)
      transfer.push(vertices.buffer,triangles.buffer)
      return {...part,data:{vertices,triangles}}
    })
    self.postMessage({parts:result},transfer)
  }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)})}
})
