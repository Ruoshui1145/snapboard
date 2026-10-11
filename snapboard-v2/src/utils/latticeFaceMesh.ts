import * as THREE from 'three'
import { rememberPreviewMeshTopology } from './previewMeshTopology'
import {toCreasedNormals} from 'three/addons/utils/BufferGeometryUtils.js'
import type {MultiPolygon,Pair} from 'polygon-clipping'
import type {Manifold,ManifoldToplevel} from 'manifold-3d'
import type { LatticeFaceData, SplitConfig, SplitPanel } from '../types/geometry'
import { extrudeTexturePartition } from './textureRegionExtrusion'
import { currentSvgFace } from './svgLattice'
import {texturePolygon as pc,offsetTexturePolygon,insetTexturePolygon} from './texturePolygon'

type MeshData={vertices:number[];triangles:number[];label?:string;domain?:MultiPolygon;zMin?:number;zMax?:number}
const polygons=(layer:LatticeFaceData['layers'][number]):MultiPolygon=>layer.polygons.map(p=>p.map(r=>{
  const points:Pair[]=r.map(p=>[p.x,p.y]);return [...points,points[0]]
}))
const key=(x:number,y:number)=>`${Math.round(x*1e5)},${Math.round(y*1e5)}`
export type LatticeMeshPart={role:LatticeFaceData['layers'][number]['role'];contrastColor?:string;data:MeshData;rootVolumeMm3?:number;volumeAdjustmentMm3?:number}
const cache=new WeakMap<LatticeFaceData,Map<boolean,Promise<LatticeMeshPart[]>>>()

/** A real root transition, clipped to the contacting plate/low rib.
 * Functional holes and the outer boundary stay at their nominal positions. */
function chamferProfile(shape:MultiPolygon,domain:MultiPolygon,plane:number,radius:number,up=false,external=true):MeshData {
    const height=new Map<string,number>()
    for(const p of shape)for(const r of p)for(const [x,y]of r)height.set(key(x,y),0)
    const regions=shape.map(p=>p.map(r=>({r,minX:Math.min(...r.map(v=>v[0])),maxX:Math.max(...r.map(v=>v[0])),minY:Math.min(...r.map(v=>v[1])),maxY:Math.max(...r.map(v=>v[1]))})))
    const inRing=(x:number,y:number,b:typeof regions[number][number])=>{
      if(x<b.minX||x>b.maxX||y<b.minY||y>b.maxY)return false
      let inside=false
      for(let i=0,j=b.r.length-1;i<b.r.length;j=i++){
        const a=b.r[i],c=b.r[j]
        if((a[1]>y)!==(c[1]>y)&&x<(c[0]-a[0])*(y-a[1])/(c[1]-a[1])+a[0])inside=!inside
      }
      return inside
    }
    const edges=shape.flatMap(p=>p.flatMap(r=>r.slice(1).map((b,i)=>({a:r[i],b}))))
    const buckets=new Map<string,typeof edges>()
    for(const edge of edges){
      const {a,b}=edge
      for(let x=Math.floor(Math.min(a[0],b[0])-radius);x<=Math.floor(Math.max(a[0],b[0])+radius);x++)for(let y=Math.floor(Math.min(a[1],b[1])-radius);y<=Math.floor(Math.max(a[1],b[1])+radius);y++){
        const k=`${x},${y}`,list=buckets.get(k);if(list)list.push(edge);else buckets.set(k,[edge])
      }
    }
    const distance=(x:number,y:number)=>{
      const k=key(x,y),known=height.get(k);if(known!==undefined)return known
      if(external&&regions.some(p=>inRing(x,y,p[0])&&!p.slice(1).some(h=>inRing(x,y,h)))){height.set(k,0);return 0}
      let nearest=Infinity
      for(const {a,b}of buckets.get(`${Math.floor(x)},${Math.floor(y)}`)??edges){
        const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1)))
        nearest=Math.min(nearest,Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy))
      }
      const d=nearest<2e-5?0:nearest>radius-.01?radius:nearest
      height.set(k,d);return d
    }
    const minZ=up?plane:plane-radius,maxZ=up?plane+radius:plane
    const data=extrudeTexturePartition(domain.map(([outer,...holes])=>({outer,holes})),minZ,maxZ)
    // A boundary-only cap can bridge concave collars with three roof vertices
    // at the same height. Refine only where the real distance profile differs;
    // splitting both caps and walls on shared edges keeps the shell conforming.
    const edgeKey=(a:number,b:number)=>{
      const ka=key(data.vertices[a*3],data.vertices[a*3+1]),kb=key(data.vertices[b*3],data.vertices[b*3+1]);return ka<kb?`${ka}|${kb}`:`${kb}|${ka}`
    }
    // 0.05mm profile error is below the printing layer height/line width.
    // Chasing 0.015mm around scanned Voronoi corners multiplies cap triangles.
    const tolerance=external?.05:.08
    for(let pass=0;pass<10;pass++){
      const selected=new Set<string>()
      for(let i=0;i<data.triangles.length;i+=3){
        const t=data.triangles.slice(i,i+3)
        if(!t.every(v=>Math.abs(data.vertices[v*3+2]-(up?maxZ:minZ))<1e-6))continue
        const pts=t.map(v=>[data.vertices[v*3],data.vertices[v*3+1]]),ds=pts.map(p=>distance(p[0],p[1]))
        let split=false
        for(let j=0;j<3;j++){
          const a=pts[j],b=pts[(j+1)%3]
          const md=distance((a[0]+b[0])/2,(a[1]+b[1])/2),error=Math.abs(md-(ds[j]+ds[(j+1)%3])/2)
          if(error>tolerance){selected.add(edgeKey(t[j],t[(j+1)%3]));split=true}
        }
        if(!split&&Math.abs(distance(pts.reduce((s,p)=>s+p[0],0)/3,pts.reduce((s,p)=>s+p[1],0)/3)-ds.reduce((a,b)=>a+b,0)/3)>tolerance){
          let longest=0
          for(let j=1;j<3;j++)if(Math.hypot(pts[j][0]-pts[(j+1)%3][0],pts[j][1]-pts[(j+1)%3][1])>Math.hypot(pts[longest][0]-pts[(longest+1)%3][0],pts[longest][1]-pts[(longest+1)%3][1]))longest=j
          selected.add(edgeKey(t[longest],t[(longest+1)%3]))
        }
      }
      if(!selected.size)break
      const midpoints=new Map<string,number>(),next:number[]=[],pending:number[][]=[]
      for(let i=0;i<data.triangles.length;i+=3)pending.push(data.triangles.slice(i,i+3))
      while(pending.length){
        const t=pending.pop()!;let split=false
        for(let j=0;j<3;j++){
          const a=t[j],b=t[(j+1)%3],c=t[(j+2)%3]
          if(Math.abs(data.vertices[a*3+2]-data.vertices[b*3+2])>1e-6||!selected.has(edgeKey(a,b)))continue
          const k=a<b?`${a}:${b}`:`${b}:${a}`;let m=midpoints.get(k)
          if(m===undefined){m=data.vertices.length/3;midpoints.set(k,m);for(let axis=0;axis<3;axis++)data.vertices.push((data.vertices[a*3+axis]+data.vertices[b*3+axis])/2)}
          pending.push([a,m,c],[m,b,c]);split=true;break
        }
        if(!split)next.push(...t)
      }
      if(next.length>600000){
        if(external)throw new Error('筋根倒角超过网格预算，请减少结构复杂度')
        // Cosmetic curved edges keep the current conforming bevel rather than
        // recursively tessellating sub-line-width corners without a limit.
        break
      }
      data.triangles=next
    }
    const vertices:number[]=[],triangles:number[]=[],ids=new Map<string,number>(),remap:number[]=[]
    for(let i=0;i<data.vertices.length;i+=3){
      const x=data.vertices[i],y=data.vertices[i+1],z=data.vertices[i+2]
      const lifted=up?z>minZ+1e-6?maxZ-distance(x,y):z:z<maxZ-1e-6?minZ+distance(x,y):z
      const k=`${key(x,y)},${Math.round(lifted*1e5)}`
      let id=ids.get(k);if(id===undefined){id=vertices.length/3;ids.set(k,id);vertices.push(x,y,lifted)}remap.push(id)
    }
    for(let i=0;i<data.triangles.length;i+=3){
      const [a,b,c]=data.triangles.slice(i,i+3).map(v=>remap[v])
      if(a!==b&&b!==c&&a!==c)triangles.push(a,b,c)
    }
    return {vertices,triangles}
}

function rootChamfers(face:LatticeFaceData):MeshData[]{
  const result:MeshData[]=[]
  for(const source of face.layers.filter(l=>l.role==='structure')){
    const targets=face.layers.filter(l=>(l.role==='structure'||l.role==='backing')&&Math.abs(l.zMin-source.zMax)<1e-6)
    if(!targets.length)continue
    const radius=Math.min(.6,(source.zMax-source.zMin)/3),shape=polygons(source)
    const target=pc.union(polygons(targets[0]),...targets.slice(1).map(polygons))
    const domain=pc.difference(pc.intersection(offsetTexturePolygon(shape,radius),target),shape)
    if(domain.length)result.push(chamferProfile(shape,domain,source.zMax,radius))
  }
  return result
}

/** Cut only exposed edges. Material/colour interfaces and continuing ribs are
 * merged into sections first, so bevels cannot create internal layer trenches. */
function exposedEdgeCuts(face:LatticeFaceData):MeshData[]{
  const zs=[...new Set(face.layers.flatMap(l=>[l.zMin,l.zMax]))].sort((a,b)=>a-b)
  const sections:Array<{shape:MultiPolygon;zMin:number;zMax:number}>=[]
  for(let i=1;i<zs.length;i++){
    const active=face.layers.filter(l=>l.zMin<zs[i]&&l.zMax>zs[i-1])
    if(!active.length)continue
    const shape=pc.union(polygons(active[0]),...active.slice(1).map(polygons)),previous=sections.at(-1)
    if(previous&&Math.abs(previous.zMax-zs[i-1])<1e-6&&!pc.difference(shape,previous.shape).length&&!pc.difference(previous.shape,shape).length)previous.zMax=zs[i]
    else sections.push({shape,zMin:zs[i-1],zMax:zs[i]})
  }
  const cuts:MeshData[]=[]
  for(const [i,section]of sections.entries()){
    const radius=Math.min(.28,(section.zMax-section.zMin)/3)
    // Round convex upright corners without expanding into functional holes.
    const inset=insetTexturePolygon(section.shape,radius)
    if(!inset.length)throw new Error('结构过薄，无法保留有效边缘倒角')
    const rounded=pc.intersection(section.shape,offsetTexturePolygon(inset,radius))
    const corners=pc.difference(section.shape,rounded)
    // Reach outside the Float32 shell by 1 micron, rather than trapping
    // sub-print-resolution slivers/cavities between two equivalent boundaries.
    if(corners.length)cuts.push({vertices:[],triangles:[],domain:offsetTexturePolygon(corners,.001),zMin:section.zMin,zMax:section.zMax,label:`侧边 ${section.zMin}..${section.zMax}`})
    const band=pc.difference(rounded,insetTexturePolygon(rounded,radius))
    for(const up of [true,false]){
      const adjacent=sections[i+(up?-1:1)],plane=up?section.zMin:section.zMax
      const touches=adjacent&&Math.abs((up?adjacent.zMax:adjacent.zMin)-plane)<1e-6
      // Existing 0.6mm root shoulders already treat the concave contacts.
      const exposed=touches?pc.difference(band,offsetTexturePolygon(adjacent.shape,.6)):band
      if(exposed.length)cuts.push({...chamferProfile(rounded,exposed,plane,radius,up,false),label:`${up?'背缘':'正缘'} ${plane}`})
    }
  }
  return cuts
}

function solidData(solid:Manifold,origin:Pair):MeshData {
  const mesh=solid.getMesh(),vertices:number[]=[],triangles=Array.from(mesh.triVerts)
  for(let i=0;i<mesh.vertProperties.length;i+=mesh.numProp)vertices.push(mesh.vertProperties[i]+origin[0],mesh.vertProperties[i+1]+origin[1],mesh.vertProperties[i+2])
  return {vertices,triangles}
}

function nativeMesh(data:MeshData,wasm:ManifoldToplevel,origin:Pair):Manifold {
  if(data.domain){
    const section=new wasm.CrossSection(data.domain.flatMap(p=>p.map(r=>r.slice(0,-1).map(([x,y])=>[x-origin[0],y-origin[1]] as Pair))),'EvenOdd')
    try{const solid=section.extrude(data.zMax!-data.zMin!);try{return solid.translate([0,0,data.zMin!])}finally{solid.delete()}}finally{section.delete()}
  }
  const positions=Float32Array.from(data.vertices,(v,i)=>v-(i%3===0?origin[0]:i%3===1?origin[1]:0))
  // The shared extrusion already has conforming indexed fans. Rewelding
  // point-touching fans would reintroduce non-manifold vertical edges.
  try{return new wasm.Manifold(new wasm.Mesh({numProp:3,vertProperties:positions,triVerts:Uint32Array.from(data.triangles),tolerance:1e-6}))}
  catch(error){throw new Error(`${data.label??'结构网格'}未闭合：${error instanceof Error?error.message:String(error)}`)}
}

/** A continuous front with rear pockets can carry the existing image layer. */
export function isPlainRetainedFront(panel: SplitPanel): boolean {
  const face = panel.latticeFace
  return Boolean(face?.source?.options.coverage === 'whole' && !face.source.artwork.length && !face.layers.some(layer => layer.role === 'detail'))
}

/** Keep manufacturing coordinates in double precision; WebGL alone needs Float32 buffers. */
export async function extrudeLatticeFace(face: LatticeFaceData, panel?: SplitPanel, cfg?: SplitConfig, preserveFace=false, rootFace?:LatticeFaceData) {
  if (panel && cfg) face = currentSvgFace(panel, cfg)
  let modes=cache.get(face);if(!modes){modes=new Map();cache.set(face,modes)}
  const ready=modes.get(preserveFace);if(ready)return ready
  const build=(async()=>{
  const raw=face.layers.map(layer => ({ role: layer.role, contrastColor: face.contrastColor,
    data: extrudeTexturePartition(layer.polygons.map(([outer, ...holes]) => ({
      outer: outer.map(p => [p.x, p.y]), holes: holes.map(r => r.map(p => [p.x, p.y])),
    })), layer.zMin, layer.zMax),
  }))
  const {spatialManifold}=await import('./spatialSolid')
  const wasm=await spatialManifold(),origin:Pair=[Infinity,Infinity]
  for(const layer of face.layers)for(const p of layer.polygons)for(const r of p)for(const point of r){origin[0]=Math.min(origin[0],point.x);origin[1]=Math.min(origin[1],point.y)}
  const minZ=Math.min(...face.layers.map(l=>l.zMin)),maxZ=Math.max(...face.layers.map(l=>l.zMax))
  const monolithic=face.source?.templateStyle==='ribs'
  const group=raw.filter(l=>l.role==='structure'||monolithic&&(l.role==='backing'||!preserveFace&&l.role==='face'))
  if(!group.length)return raw
  const solids:Manifold[]=[],cutSolids:Manifold[]=[]
  try{
    for(const layer of group)solids.push(nativeMesh(layer.data,wasm,origin))
    const nominalVolume=solids.reduce((sum,s)=>sum+s.volume(),0)
    for(const data of rootChamfers(rootFace??face)){
      let root=nativeMesh(data,wasm,origin),kept=false
      try{
        const lower=root.trimByPlane([0,0,1],minZ);root.delete();root=lower
        const upper=root.trimByPlane([0,0,-1],-maxZ);root.delete();root=upper
        if(!root.isEmpty()){solids.push(root);kept=true}
      }finally{if(!kept)root.delete()}
    }
    const solid=wasm.Manifold.union(solids)
    try{
      if(solid.status()!=='NoError')throw new Error('筋与底面倒角无法形成闭合实体')
      for(const data of exposedEdgeCuts(rootFace??face))cutSolids.push(nativeMesh(data,wasm,origin))
      const cutter=cutSolids.length?wasm.Manifold.union(cutSolids):null
      try{
        const finish=(input:Manifold)=>{
          const carved=cutter?input.subtract(cutter):input,simplified=carved.simplify(.002)
          const components=simplified.decompose(),kept=components.filter(s=>Math.abs(s.volume())>=.01)
          // Float32 boolean seams can leave picolitre shells. Keep every
          // printable component; never hide a disconnected real rib/collar.
          const result=wasm.Manifold.compose(kept)
          try{
            if(result.status()!=='NoError')throw new Error('外露边倒角无法形成闭合实体')
            // getMesh rounds to Float32; filter again after that exact roundtrip
            // so folded zero-volume shells cannot enter WebGL or the 3MF.
            const packed=new wasm.Manifold(result.getMesh()),pieces=packed.decompose()
            const printable=wasm.Manifold.compose(pieces.filter(s=>Math.abs(s.volume())>=.01))
            try{return {data:solidData(printable,origin),volume:printable.volume()}}
            finally{printable.delete();pieces.forEach(s=>s.delete());packed.delete()}
          }finally{result.delete();components.forEach(s=>s.delete());simplified.delete();if(carved!==input)carved.delete()}
        }
        const complete=finish(solid)
        return [{role:'structure' as const,contrastColor:face.contrastColor,rootVolumeMm3:Math.max(0,solid.volume()-nominalVolume),
          volumeAdjustmentMm3:complete.volume-nominalVolume,data:complete.data},...raw.filter(l=>!group.includes(l)).map(part=>{
            const input=nativeMesh(part.data,wasm,origin)
            try{const complete=finish(input);return {...part,data:complete.data,volumeAdjustmentMm3:complete.volume-input.volume()}}finally{input.delete()}
          })]
      }finally{cutter?.delete()}
    }finally{solid.delete()}
  }finally{solids.forEach(s=>s.delete());cutSolids.forEach(s=>s.delete())}
  })()
  modes.set(preserveFace,build)
  void build.catch(()=>{if(modes.get(preserveFace)===build)modes.delete(preserveFace)})
  return build
}

/** Optical colour partitions share the exact beveled envelope of the preview.
 * Meshes are panel-local; the face blueprint keeps global manufacturing XY. */
export async function clipLatticeTextureMeshes(meshes:Array<{vertices:Array<[number,number,number]>;triangles:Array<[number,number,number]>}>,face:LatticeFaceData,origin:Pair){
  const {spatialManifold}=await import('./spatialSolid'),wasm=await spatialManifold()
  const bodies=(await extrudeLatticeFace(face)).map(({data})=>nativeMesh(data,wasm,origin))
  const envelope=wasm.Manifold.union(bodies)
  try{
    for(const mesh of meshes){
      const input=nativeMesh({vertices:mesh.vertices.flat(),triangles:mesh.triangles.flat()},wasm,[0,0])
      try{
        const clipped=input.intersect(envelope)
        try{
          if(clipped.status()!=='NoError')throw new Error('彩色边缘倒角裁剪未闭合')
          const data=solidData(clipped,[0,0])
          mesh.vertices=[];mesh.triangles=[]
          for(let i=0;i<data.vertices.length;i+=3)mesh.vertices.push(data.vertices.slice(i,i+3) as [number,number,number])
          for(let i=0;i<data.triangles.length;i+=3)mesh.triangles.push(data.triangles.slice(i,i+3) as [number,number,number])
        }finally{clipped.delete()}
      }finally{input.delete()}
    }
  }finally{envelope.delete();bodies.forEach(s=>s.delete())}
}

/** Preview and 3MF share the extrusion, while export avoids welding tiny SVG vertices. */
export async function createLatticeFaceMeshes(face: LatticeFaceData, color: number | string, panel?: SplitPanel, cfg?: SplitConfig, preserveFace=true): Promise<THREE.Mesh[]> {
  return latticeMeshesFromData(await extrudeLatticeFace(face,panel,cfg,preserveFace),color)
}

export function latticeMeshesFromData(parts:LatticeMeshPart[],color:number|string):THREE.Mesh[]{
  return parts.map(({ data, role, contrastColor }) => {
    const source = new THREE.BufferGeometry()
    source.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3))
    const positions=source.getAttribute('position'),indices:number[]=[]
    for(let i=0;i<data.triangles.length;i+=3){
      const [a,b,c]=data.triangles.slice(i,i+3),u=[positions.getX(b)-positions.getX(a),positions.getY(b)-positions.getY(a),positions.getZ(b)-positions.getZ(a)],v=[positions.getX(c)-positions.getX(a),positions.getY(c)-positions.getY(a),positions.getZ(c)-positions.getZ(a)]
      if(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])>1e-12)indices.push(a,b,c)
    }
    source.setIndex(indices)
    const geometry=toCreasedNormals(source,Math.PI/6);source.dispose()
    rememberPreviewMeshTopology(geometry,data)
    const p=geometry.getAttribute('position'),n=geometry.getAttribute('normal')
    for(let i=0;i<p.count;i+=3)if(Math.max(p.getZ(i),p.getZ(i+1),p.getZ(i+2))-Math.min(p.getZ(i),p.getZ(i+1),p.getZ(i+2))<1e-6){
      const nz=Math.sign((p.getX(i+1)-p.getX(i))*(p.getY(i+2)-p.getY(i))-(p.getY(i+1)-p.getY(i))*(p.getX(i+2)-p.getX(i)))||1
      for(let j=0;j<3;j++)n.setXYZ(i+j,0,0,nz)
    }
    const material = new THREE.MeshStandardMaterial({
      color: role === 'detail' ? contrastColor ?? color : color,
      roughness: 0.65, metalness: 0, side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `lattice-face-${role}`
    mesh.userData.latticeFaceRole = role
    return mesh
  })
}
