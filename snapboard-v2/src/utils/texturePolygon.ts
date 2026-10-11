import ClipperLib from 'clipper-lib'
import type { MultiPolygon, Ring } from 'polygon-clipping'

// Manufacturing millimetres, 0.00001 mm integer grid. This is far below the
// curve tolerance and avoids near-identical floating intersection endpoints.
const SCALE = 100000
const path = (ring: Ring): ClipperLib.Path => ring.map(([x,y]) => {
  if (![x,y].every(v=>Number.isFinite(v)&&Math.abs(v)<1e8)) throw new Error('纹理多边形坐标超出范围')
  return {X:Math.round(x*SCALE),Y:Math.round(y*SCALE)}
})
const paths = (mp: MultiPolygon): ClipperLib.Paths => mp.flatMap(p=>p.map((r,i)=>{
  const result=path(r)
  if(ClipperLib.Clipper.Orientation(result)!==(i===0))result.reverse()
  return result
}))
function polygons(tree: ClipperLib.PolyTree): MultiPolygon {
  const ring=(node:ClipperLib.PolyNode):Ring=>{const r:Ring=node.Contour().map(p=>[p.X/SCALE,p.Y/SCALE]);if(r.length)r.push(r[0]);return r}
  const result:MultiPolygon=[]
  const visit=(node:ClipperLib.PolyNode)=>{
    if(node.Contour().length&&!node.IsHole())result.push([ring(node),...node.Childs().filter(c=>c.IsHole()).map(ring)])
    node.Childs().forEach(visit)
  }
  visit(tree);return result
}
function operate(type:ClipperLib.ClipType, subject:ClipperLib.Paths, clip:ClipperLib.Paths=[], fill=ClipperLib.PolyFillType.pftNonZero):MultiPolygon {
  if(!subject.length)return []
  const c=new ClipperLib.Clipper()
  c.AddPaths(subject,ClipperLib.PolyType.ptSubject,true)
  if(clip.length)c.AddPaths(clip,ClipperLib.PolyType.ptClip,true)
  const tree=new ClipperLib.PolyTree()
  if(!c.Execute(type,tree,fill,ClipperLib.PolyFillType.pftNonZero))throw new Error('纹理多边形布尔失败')
  return polygons(tree)
}
export function fillTextureRings(rings:Ring[], rule:string):MultiPolygon {
  // Remove sub-micron duplicates/near-collinear samples before winding union.
  // Large traced scans contain many such nodes; retain tiny rings if cleaning
  // would erase them. This is separate from visible-feature simplification.
  const input=rings.map(path).map(r=>{const clean=ClipperLib.Clipper.CleanPolygon(r,0.001*SCALE);return clean.length>=3?clean:r})
  return operate(ClipperLib.ClipType.ctUnion,input,[],rule==='evenodd'?ClipperLib.PolyFillType.pftEvenOdd:ClipperLib.PolyFillType.pftNonZero)
}
export const texturePolygon = {
  union: (...items:MultiPolygon[]):MultiPolygon => operate(ClipperLib.ClipType.ctUnion,items.flatMap(paths)),
  difference: (a:MultiPolygon,b:MultiPolygon):MultiPolygon => !a.length?[]:!b.length?a:operate(ClipperLib.ClipType.ctDifference,paths(a),paths(b)),
  intersection: (a:MultiPolygon,b:MultiPolygon):MultiPolygon => !a.length||!b.length?[]:operate(ClipperLib.ClipType.ctIntersection,paths(a),paths(b)),
}
export function insetTexturePolygon(domain:MultiPolygon,distance:number):MultiPolygon {
  if(!Number.isFinite(distance)||distance<0)throw new Error('Invalid texture inset')
  return offsetTexturePolygon(domain,-distance)
}
/** Signed offset shared by manufacturing chamfers and inward texture clearances. */
export function offsetTexturePolygon(domain:MultiPolygon,distance:number):MultiPolygon {
  if(!Number.isFinite(distance))throw new Error('Invalid polygon offset')
  if(!distance||!domain.length)return domain
  const offset=new ClipperLib.ClipperOffset(2,0.005*SCALE),tree=new ClipperLib.PolyTree()
  offset.AddPaths(paths(domain),ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon)
  offset.Execute(tree,distance*SCALE)
  return polygons(tree)
}
