import * as THREE from 'three'

/** A late cancelled build/replay must not clear the replacement build's busy state. */
export function claimPreviewBuildState(scene:THREE.Object3D):(building:boolean)=>void {
  const owner=Symbol('preview-build')
  scene.userData.latticeBuildOwner=owner
  return building=>{
    if(scene.userData.latticeBuildOwner===owner)scene.userData.latticeBuilding=building
  }
}

export function invalidatePreviewReplay(scene:THREE.Object3D):void {
  scene.userData.latticeReplayGeneration=Symbol('preview-replay')
}

/** Capture per invocation: cached assemblies can keep their replay callback across effects. */
export function capturePreviewReplay(scene:THREE.Object3D):()=>boolean {
  const generation=scene.userData.latticeReplayGeneration
  return ()=>scene.userData.latticeReplayGeneration===generation
}

/** Check ownership after the await, before attaching a late model to a retired group. */
export async function appendPreviewResource(parent:THREE.Object3D,pending:Promise<THREE.Object3D>,
  isCurrent:()=>boolean,retained?:THREE.Object3D|null):Promise<boolean> {
  const object=await pending
  if(!isCurrent()){disposePreviewResources(object,retained);return false}
  parent.add(object)
  return true
}

/** Dispose owned instance resources; templates and resources still used by the scene survive. */
export function disposePreviewResources(root:THREE.Object3D, retained?:THREE.Object3D|null):void {
  const keep=new Set<THREE.BufferGeometry|THREE.Material|THREE.Texture>()
  const collect=(object:THREE.Object3D,visit:(resource:THREE.BufferGeometry|THREE.Material|THREE.Texture)=>void)=>{
    const mesh=object as THREE.Mesh
    // THREE.Sprite shares a module-level geometry across all sprites.
    if(mesh.geometry&&!(object as THREE.Sprite).isSprite)visit(mesh.geometry)
    const materials=Array.isArray(mesh.material)?mesh.material:mesh.material?[mesh.material]:[]
    for(const material of materials){
      visit(material)
      const map=(material as THREE.MeshStandardMaterial).map
      if(map?.userData.snapboardTexture)visit(map)
    }
  }
  if(retained&&retained!==root)retained.traverse(object=>collect(object,resource=>keep.add(resource)))
  const disposed=new Set<THREE.BufferGeometry|THREE.Material|THREE.Texture>()
  root.traverse(object=>collect(object,resource=>{
    if(keep.has(resource)||disposed.has(resource))return
    disposed.add(resource);resource.dispose()
  }))
}
