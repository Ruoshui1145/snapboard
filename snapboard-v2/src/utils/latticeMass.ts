import pc, {type MultiPolygon, type Ring} from 'polygon-clipping'
import {insetTexturePolygon} from './texturePolygon'
import {createSplitPanelShape} from './boardMesh'
import {currentSvgFace} from './svgLattice'
import type {Point2D,SplitPanel,SplitConfig} from '../types/geometry'

export interface LatticeMassProfile {
  densityGcm3:number; lineWidthMm:number; wallLoops:number; layerHeightMm:number
  topLayers:number; bottomLayers:number; infillPercent:number; frontDenseMm:number
}
export const DEFAULT_LATTICE_MASS_PROFILE:LatticeMassProfile={densityGcm3:1.27,lineWidthMm:.42,wallLoops:2,layerHeightMm:.28,
  topLayers:3,bottomLayers:3,infillPercent:10,frontDenseMm:0}
const ring=(points:Point2D[]):Ring=>[...points.map(p=>[p.x,p.y] as [number,number]),[points[0].x,points[0].y]]
export const polygonArea=(g:MultiPolygon)=>g.reduce((sum,p)=>sum+p.reduce((a,r,i)=>a+(i?-1:1)*Math.abs(r.reduce((v,x,j)=>{const y=r[(j+1)%r.length];return v+x[0]*y[1]-y[0]*x[1]},0))/2,0),0)
const perimeter=(g:MultiPolygon)=>g.reduce((s,p)=>s+p.reduce((s,r)=>s+r.slice(1).reduce((v,p,i)=>v+Math.hypot(p[0]-r[i][0],p[1]-r[i][1]),0),0),0)
const merge=(list:MultiPolygon[])=>list.length?pc.union(list[0],...list.slice(1)):[]
/** Layer-area estimator, not solid volume × infill. Thin ribs can be all wall. */
export function estimateLatticeMass(panel:SplitPanel,cfg:SplitConfig,profile:Partial<LatticeMassProfile>={}) {
  const settings={...DEFAULT_LATTICE_MASS_PROFILE,...profile}
  if(panel.latticeFace?.source?.templateStyle==='ribs'){settings.wallLoops=3;settings.infillPercent=100}
  if(!Object.values(settings).every(Number.isFinite)||settings.densityGcm3<=0||settings.lineWidthMm<=0||settings.layerHeightMm<.08||settings.wallLoops<1||settings.infillPercent<0||settings.infillPercent>100)
    throw new Error('耗料估算参数无效')
  const shape=createSplitPanelShape({...panel,latticeCutouts:undefined,latticeFace:undefined},cfg,12).extractPoints(24)
  const base:MultiPolygon=[[ring(shape.shape),...shape.holes.map(ring)]]
  const face=panel.latticeFace?currentSvgFace(panel,cfg):null
  const solid=face?null:panel.latticeCutouts?.length?pc.difference(base,...panel.latticeCutouts.map(h=>[ring(h)])):base
  const sections=face?face.layers.map(l=>({...l,polygons:l.polygons.map(p=>p.map(ring))})):[]
  const cache=new Map<string,MultiPolygon>()
  const at=(printZ:number,dense=false):MultiPolygon=>{
    if(printZ<0||printZ>=cfg.thickness)return []
    const z=cfg.thickness-printZ
    if(!face)return dense&&printZ>settings.frontDenseMm?[]:solid!
    const active=sections.filter(l=>z>l.zMin&&z<=l.zMax&&(!dense||l.role!=='structure'))
    const key=active.map(l=>sections.indexOf(l)).join(',')
    if(!cache.has(key))cache.set(key,merge(active.map(l=>l.polygons)))
    return cache.get(key)!
  }
  const top=panel.latticeOptions?.openCoreCaps?0:settings.topLayers*settings.layerHeightMm
  const bottom=panel.latticeOptions?.openCoreCaps?0:settings.bottomLayers*settings.layerHeightMm
  const computed=new Map<string,{area:number,solid:number,wall:number,perimeter:number}>()
  let modelVolumeMm3=0,printedVolumeMm3=0,wallVolumeMm3=0,perimeterMm=0
  for(let z=0;z<cfg.thickness-1e-6;z+=settings.layerHeightMm){
    const dz=Math.min(settings.layerHeightMm,cfg.thickness-z),mid=z+dz/2,g=at(mid)
    const above=top?at(mid+top):g,below=bottom?at(mid-bottom):g,dense=at(mid,true)
    const key=[g,above,below,dense].map(x=>x===base?'base':JSON.stringify(x)).join('|')
    let a=computed.get(key)
    if(!a){
      const inside=insetTexturePolygon(g,settings.wallLoops*settings.lineWidthMm)
      const walls=inside.length?pc.difference(g,inside):g
      const skin=merge([top?pc.difference(g,above):[],bottom?pc.difference(g,below):[],dense,walls])
      a={area:polygonArea(g),solid:polygonArea(skin),wall:polygonArea(walls),perimeter:perimeter(g)};computed.set(key,a)
    }
    modelVolumeMm3+=a.area*dz
    printedVolumeMm3+=(a.solid+(a.area-a.solid)*settings.infillPercent/100)*dz
    wallVolumeMm3+=a.wall*dz;perimeterMm+=a.perimeter*settings.wallLoops
  }
  return {grams:printedVolumeMm3*settings.densityGcm3/1000,modelVolumeMm3,printedVolumeMm3,wallVolumeMm3,perimeterMm,settings}
}
