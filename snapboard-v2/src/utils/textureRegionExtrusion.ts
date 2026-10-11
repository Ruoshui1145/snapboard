import {extrudeTextureRegions,type TextureRegionPolygon} from './textureRegionContours'
import {texturePolygon as pc} from './texturePolygon'
import type {MultiPolygon,Pair} from 'polygon-clipping'
import {ShapeUtils,Vector2} from 'three'
import libtess from 'libtess'

function tessellatedShell(p:TextureRegionPolygon,zMin:number,zMax:number) {
  const origin=p.outer[0],scale=100000
  const rings=[p.outer,...p.holes].map(r=>{const q=r.map(v=>new Vector2(Math.round((v[0]-origin[0])*scale),Math.round((v[1]-origin[1])*scale)));if(q.length>1&&q[0].equals(q.at(-1)!))q.pop();return q})
  const capPoints:Vector2[]=[]
  const tess=new libtess.GluTesselator()
  tess.gluTessNormal(0,0,1)
  tess.gluTessProperty(libtess.gluEnum.GLU_TESS_WINDING_RULE,libtess.windingRule.GLU_TESS_WINDING_NONZERO)
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_VERTEX,(v:number[])=>capPoints.push(new Vector2(Math.round(v[0]),Math.round(v[1]))))
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_COMBINE,(coords:number[])=>coords)
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_EDGE_FLAG,()=>{})
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_ERROR,(code:number)=>{throw new Error(`纹理三角化失败 (${code})`)})
  tess.gluTessBeginPolygon(null)
  for(let i=0;i<rings.length;i++) {
    const r=[...rings[i]];if((ShapeUtils.area(r)>0)!==(i===0))r.reverse()
    tess.gluTessBeginContour();for(const v of r){const p=[v.x,v.y,0];tess.gluTessVertex(p,p)}tess.gluTessEndContour()
  }
  tess.gluTessEndPolygon();tess.gluDeleteTess()
  const expected=rings.reduce((n,r,i)=>n+(i?-1:1)*Math.abs(ShapeUtils.area(r)),0)
  const perimeterUnits=rings.reduce((sum,r)=>sum+r.reduce((s,v,i)=>s+v.distanceTo(r[(i+1)%r.length]),0),0)
  let area=0;const vertices:number[]=[],triangles:number[]=[],points:Vector2[]=[],caps:number[][]=[]
  const ids=new Map<string,number>(),edges=new Map<string,{a:number;b:number;count:number}>()
  const id=(v:Vector2)=>{const key=`${v.x},${v.y}`;let i=ids.get(key);if(i===undefined){i=points.length;points.push(v);ids.set(key,i)}return i}
  for(let i=0;i<capPoints.length;i+=3) {
    const [a,b,c]=capPoints.slice(i,i+3);const cross=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
    if(!cross)continue
    area+=Math.abs(cross)/2
    const t=(cross>0?[a,b,c]:[a,c,b]).map(id);caps.push(t)
    for(let j=0;j<3;j++){const a=t[j],b=t[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,edge=edges.get(key);if(edge)edge.count++;else edges.set(key,{a,b,count:1})}
  }
  if(!(expected>0)||Math.abs(area-expected)>Math.max(1,expected*1e-8,perimeterUnits*Math.SQRT2)) {
    // Shoelace area is not a coverage measure for a point-touching contour.
    // Verify the actual filled domains before deciding that the cap is invalid.
    if(capPoints.length>30000)throw new Error('纹理分区三角化面积不一致')
    const pieces:MultiPolygon[]=[]
    for(let i=0;i<capPoints.length;i+=3){const r:Pair[]=capPoints.slice(i,i+3).map(v=>[v.x/scale+origin[0],v.y/scale+origin[1]]);r.push(r[0]);pieces.push([[r]])}
    const target=pc.union([[p.outer,...p.holes]]),covered=pc.union(...pieces)
    const domainArea=(mp:MultiPolygon)=>mp.reduce((sum,p)=>sum+p.reduce((s,r,i)=>s+(i?-1:1)*Math.abs(ShapeUtils.area(r.map(v=>new Vector2(v[0]-origin[0],v[1]-origin[1])))),0),0)
    const perimeter=[p.outer,...p.holes].reduce((sum,r)=>sum+r.reduce((s,v,i)=>s+Math.hypot(v[0]-r[(i+1)%r.length][0],v[1]-r[(i+1)%r.length][1]),0),0)
    // Boolean comparison snaps the generated intersection vertices to the
    // same 1e-5 mm grid; allow its bounded boundary-strip area, not a fixed
    // tolerance smaller than one quantization cell for every polygon size.
    const quantizationArea=perimeter*Math.SQRT2/scale+1e-10
    if(domainArea(pc.difference(target,covered))+domainArea(pc.difference(covered,target))>quantizationArea)throw new Error('纹理分区三角化覆盖不一致')
  }
  // A point-touch has separate triangle fans. Give each fan its own vertex so
  // extrusion cannot weld four side walls onto one nonmanifold vertical edge.
  const parent=Array.from({length:caps.length*3},(_,i)=>i)
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i]}return i}
  const link=(a:number,b:number)=>{parent[root(a)]=root(b)}
  const shared=new Map<string,{a:number;ia:number;ib:number}>()
  caps.forEach((t,i)=>{for(let j=0;j<3;j++){const a=t[j],b=t[(j+1)%3],ia=i*3+j,ib=i*3+(j+1)%3,key=a<b?`${a}:${b}`:`${b}:${a}`,old=shared.get(key);if(old){link(ia,old.a===a?old.ia:old.ib);link(ib,old.a===a?old.ib:old.ia)}else shared.set(key,{a,ia,ib})}})
  const fanIds=new Map<number,number>(),fanPoints:Vector2[]=[]
  const fanCaps=caps.map((t,i)=>t.map((v,j)=>{const key=root(i*3+j);let id=fanIds.get(key);if(id===undefined){id=fanPoints.length;fanIds.set(key,id);fanPoints.push(points[v])}return id}))
  edges.clear()
  for(const t of fanCaps)for(let j=0;j<3;j++){const a=t[j],b=t[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,edge=edges.get(key);if(edge)edge.count++;else edges.set(key,{a,b,count:1})}
  const n=fanPoints.length
  for(const z of [zMin,zMax])for(const v of fanPoints)vertices.push(v.x/scale+origin[0],v.y/scale+origin[1],z)
  for(const [a,b,c]of fanCaps)triangles.push(c,b,a,a+n,b+n,c+n)
  for(const {a,b,count}of edges.values()){if(count>2)throw new Error('纹理三角化产生重叠边');if(count===1)triangles.push(a,b,b+n,a,b+n,a+n)}
  return {vertices,triangles}
}

/** Partition difficult caps without changing coverage. Adjacent closed pieces
 * share a material and only touch at their cut plane, never overlap in volume. */
export function extrudeTexturePartition(polygons:TextureRegionPolygon[],zMin:number,zMax:number) {
  const vertices:number[]=[],triangles:number[]=[]
  const pending=polygons.map(p=>({p,depth:0}))
  let pieces=0
  while(pending.length) {
    if(++pieces>100000||vertices.length>15000000)throw new Error('纹理分区制造超过安全预算')
    const {p,depth}=pending.pop()!,rings=[p.outer,...p.holes]
    const points=rings.flat(),box=points.reduce((b,v)=>[Math.min(b[0],v[0]),Math.min(b[1],v[1]),Math.max(b[2],v[0]),Math.max(b[3],v[1])],[Infinity,Infinity,-Infinity,-Infinity])
    // Only sub-micron remnants created during repair, not source islands.
    if(depth>0&&box[2]-box[0]<=0.0001&&box[3]-box[1]<=0.0001)continue
    if(depth>0) {
      const ox=p.outer[0][0],oy=p.outer[0][1]
      const area=rings.reduce((sum,r,k)=>sum+(k?-1:1)*Math.abs(r.reduce((a,v,i)=>{const w=r[(i+1)%r.length];return a+(v[0]-ox)*(w[1]-oy)-(w[0]-ox)*(v[1]-oy)},0)/2),0)
      const perimeter=rings.reduce((sum,r)=>sum+r.reduce((a,v,i)=>a+Math.hypot(v[0]-r[(i+1)%r.length][0],v[1]-r[(i+1)%r.length][1]),0),0)
      if(area>=0&&area<perimeter*0.00005)continue
    }
    let cause:unknown
    const count=rings.reduce((n,r)=>n+r.length,0)
    if(count<=1000000&&p.holes.length<=65536)try{
      if(count>128||p.holes.length>4) {
        const mesh=tessellatedShell(p,zMin,zMax),base=vertices.length/3
        for(const v of mesh.vertices)vertices.push(v)
        for(const t of mesh.triangles)triangles.push(t+base)
        continue
      }
      // Triangulate in local integer XY units; tiny traced regions at large
      // coordinates otherwise lose cap area through floating cancellation.
      const origin=p.outer[0],scale=100000
      const scaled=(r:Pair[])=>r.map(v=>[Math.round((v[0]-origin[0])*scale),Math.round((v[1]-origin[1])*scale)] as Pair)
      const mesh=extrudeTextureRegions([{outer:scaled(p.outer),holes:p.holes.map(scaled)}],zMin,zMax),base=vertices.length/3
      for(let i=0;i<mesh.vertices.length;i+=3)vertices.push(mesh.vertices[i]/scale+origin[0],mesh.vertices[i+1]/scale+origin[1],mesh.vertices[i+2])
      for(const t of mesh.triangles)triangles.push(t+base)
      continue
    }catch(error){
      cause=error
      try {
        // GLU produces conforming caps. Only their boundary edges need walls;
        // no internal triangle-prism walls or pixel-grid fallback are required.
        const mesh=tessellatedShell(p,zMin,zMax),base=vertices.length/3
        for(const v of mesh.vertices)vertices.push(v)
        for(const t of mesh.triangles)triangles.push(t+base)
        continue
      }catch(error){cause=error}
    }
    if(depth>=24)throw new Error(`${String(cause)}; cap=${count}, bounds=${box.join(',')}`)
    const seen=new Set<string>();let contact:Pair|undefined
    for(const r of rings){const end=r.length>1&&r[0][0]===r.at(-1)![0]&&r[0][1]===r.at(-1)![1]?r.length-1:r.length;for(let i=0;i<end;i++){const v=r[i],key=`${v[0].toFixed(5)},${v[1].toFixed(5)}`;if(seen.has(key)){contact=v;break}seen.add(key)}if(contact)break}
    let axis=box[2]-box[0]>=box[3]-box[1]?0:1,cut=(box[axis]+box[axis+2])/2
    if(contact)for(const a of [axis,1-axis])if(contact[a]>box[a]+1e-5&&contact[a]<box[a+2]-1e-5){axis=a;cut=contact[a];break}
    const rect=(b:number[]):MultiPolygon=>[[[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]],[b[0],b[1]]]]]
    const low=[...box],high=[...box];low[axis+2]=cut;high[axis]=cut
    const source:MultiPolygon=[[...rings.map(r=>[...r,r[0]])]]
    for(const bounds of [low,high])for(const part of pc.intersection(source,rect(bounds)))pending.push({p:{outer:part[0].slice(0,-1),holes:part.slice(1).map(r=>r.slice(0,-1))},depth:depth+1})
  }
  return {vertices,triangles}
}
