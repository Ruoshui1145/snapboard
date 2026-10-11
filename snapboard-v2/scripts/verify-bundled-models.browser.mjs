import * as THREE from 'three';
import {loadPartModel} from '/src/utils/glbLoader.ts';
import {partPreviewPath} from '/src/partLibrary/types.ts';
export async function run(){
 const library=await(await fetch('/partLibrary/index.json')).json();const results=[];
 for(const part of library.parts){
  try{
   const model=await loadPartModel('/partLibrary/'+partPreviewPath(part),part.model);
   const box=new THREE.Box3().setFromObject(model);let vertices=0;
   model.traverse(n=>{vertices+=n.geometry?.attributes?.position?.count??0;n.geometry?.dispose();const materials=Array.isArray(n.material)?n.material:[n.material];for(const m of materials)m?.dispose();});
   if(box.isEmpty()||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite)||vertices===0)throw Error('Empty/nonfinite mesh');
   results.push({id:part.id,passed:true,vertices});
  }catch(error){results.push({id:part.id,passed:false,error:String(error)});}
 }
 return {total:results.length,passed:results.filter(r=>r.passed).length,results};
}
