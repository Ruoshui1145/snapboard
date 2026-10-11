import type { MultiPolygon, Pair } from 'polygon-clipping'
import { texturePolygon as pc } from './texturePolygon'

export type StandeePoint = [number, number]
export type StageShape = 'arch' | 'rounded' | 'oval'
export type BaseShape = 'rounded' | 'oval' | 'rectangle'
export interface StandeeImage { data: string; width: number; height: number; outline: StandeePoint[]; anchor: number; name: string }
export interface StandeeActor { id: string; name: string; image: StandeeImage; height: number; x: number; y: number; raise: number }
export interface StandeeProject {
  format: 'snapboard-standee'; version: 1; name: string;
  base: { shape: BaseShape; width: number; depth: number; height: number; style?: 'plain' | 'podium' };
  stage: { enabled: boolean; shape: StageShape; height: number; frame: boolean; frameWidth: number; innerFrame: boolean; color: string; rearInset?: number; imageFit?: 'cover' | 'contain'; image?: StandeeImage };
  wave: boolean; actors: StandeeActor[]; clearance: number; slotsKey?: string;
}
export interface StandeeSlot { id: string; label: string; x: number; y: number; width: number; depth: number; insertion: number }
export const RYBW_COLORS = ['#FFFFFF', '#DC143C', '#FFE600', '#0064F0']
export const rect = (x: number, y: number, w: number, h: number): MultiPolygon => [[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]]]
export function tab(x:number,y:number,w:number,h:number):MultiPolygon {
  const c=.32
  return [[[[x+c,y],[x+w-c,y],[x+w,y+c],[x+w,y+h],[x,y+h],[x,y+c],[x+c,y]]]]
}
export function outlinePath(points: StandeePoint[]) { return points.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ')+'Z' }
export function shapeOutline(shape: BaseShape | StageShape, w: number, h: number): StandeePoint[] {
  if(shape==='oval') return Array.from({length:96},(_,i)=>[w/2+w/2*Math.cos(i/96*Math.PI*2),h/2+h/2*Math.sin(i/96*Math.PI*2)])
  if(shape==='arch') {
    const r=Math.min(w*.28,h*.42)
    return [[0,0],[w,0],[w,h-r],...Array.from({length:65},(_,i)=>[w/2+w/2*Math.cos(i/64*Math.PI),h-r+r*Math.sin(i/64*Math.PI)] as StandeePoint),[0,0]]
  }
  if(shape==='rectangle') return [[0,0],[w,0],[w,h],[0,h]]
  const r=Math.min(w*.08,h*.16,12),points:StandeePoint[]=[]
  for(const [cx,cy,start] of [[w-r,r,-Math.PI/2],[w-r,h-r,0],[r,h-r,Math.PI/2],[r,r,Math.PI]])
    for(let i=0;i<=12;i++)points.push([cx+r*Math.cos(start+i/12*Math.PI/2),cy+r*Math.sin(start+i/12*Math.PI/2)])
  return points
}
export const domain = (outline: StandeePoint[]): MultiPolygon => [[[...outline,outline[0]]]]
export function inside(point: StandeePoint, polygon: StandeePoint[]) {
  let result=false
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j]
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])result=!result
  }
  return result
}
export const actorWidth = (actor: StandeeActor) => actor.height*actor.image.width/actor.image.height
export function actorBody(actor: StandeeActor): StandeePoint[] {
  const w=actorWidth(actor)
  return actor.image.outline.map(([x,y])=>[x*w,y*actor.height])
}
export function actorDomain(actor: StandeeActor): MultiPolygon {
  const anchor=actor.image.anchor*actorWidth(actor)
  return pc.union(domain(actorBody(actor)),tab(anchor-8,-actor.raise-8,16,actor.raise+11),rect(anchor-11,-actor.raise,22,actor.raise+3))
}
export function stageParts(project: StandeeProject) {
  const width=project.base.width-8,height=project.stage.height,x=4,y=Math.max(6,Math.min(project.base.depth-6,project.base.depth-(project.stage.rearInset??12)))
  const centers=project.base.shape==='oval'?[70,width-70]:[28,width-28]
  const body=domain(shapeOutline(project.stage.shape,width,height))
  const combined=pc.union(body,...centers.map(cx=>tab(cx-12,-8,24,8+(project.stage.shape==='oval'?height*.35:.5))))
  return {width,height,x,y,centers,body,combined}
}
export function waveParts(project: StandeeProject) {
  const width=project.base.width-22,height=14,x=11,y=10
  const outer:StandeePoint[]=[[0,0],[width,0],...[...Array(49)].map((_,i)=>{const xx=width-i/48*width;return [xx,10+2.6*Math.sin(xx/width*Math.PI*4)] as StandeePoint})]
  const centers=project.base.shape==='oval'?[72,width-72]:[24,width-24]
  return {width,height,x,y,centers,body:domain(outer),combined:pc.union(domain(outer),...centers.map(cx=>tab(cx-10,-8,20,8.5)))}
}
export function plannedSlots(project: StandeeProject): StandeeSlot[] {
  const slots:StandeeSlot[]=project.actors.map(a=>({id:a.id,label:a.name,x:a.x-actorWidth(a)/2+a.image.anchor*actorWidth(a),y:a.y,width:16.4,depth:2.4+project.clearance,insertion:8.2}))
  if(project.stage.enabled){const s=stageParts(project);s.centers.forEach((cx,i)=>slots.push({id:`stage-${i}`,label:'背景板',x:s.x+cx,y:s.y,width:24.4,depth:3.2+project.clearance,insertion:8.2}))}
  if(project.wave){const s=waveParts(project);s.centers.forEach((cx,i)=>slots.push({id:`wave-${i}`,label:'波浪前景',x:s.x+cx,y:s.y,width:20.4,depth:2.4+project.clearance,insertion:8.2}))}
  return slots
}
export function slotKey(project: StandeeProject) {
  return JSON.stringify({base:project.base,slots:plannedSlots(project),actors:project.actors.map(a=>({id:a.id,x:a.x,y:a.y,height:a.height,raise:a.raise,outline:a.image.outline})),stage:project.stage.enabled,wave:project.wave})
}
export function validateStandee(project: StandeeProject): string[] {
  const errors:string[]=[],slots=plannedSlots(project),base=shapeOutline(project.base.shape,project.base.width,project.base.depth)
  if(project.actors.length>12)errors.push('角色超过12块，请分为两套立牌。')
  if(project.base.width<80||project.base.width>240||project.base.depth<50||project.base.depth>160||project.base.height<12||project.base.height>30)errors.push('底座尺寸超出当前模板范围。')
  for(const s of slots){
    const corners=[[-1,-1],[-1,1],[1,-1],[1,1]].map(([xx,yy])=>[s.x+xx*(s.width/2+2),s.y+yy*(s.depth/2+2)] as StandeePoint)
    if(!corners.every(c=>inside(c,base)))errors.push(`${s.label}的插槽太靠近底座边缘，请在俯视图中移入底座。`)
  }
  for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++){
    const a=slots[i],b=slots[j]
    if(Math.abs(a.x-b.x)<(a.width+b.width)/2+1&&Math.abs(a.y-b.y)<(a.depth+b.depth)/2+1)errors.push(`${a.label}与${b.label}的插槽重叠，请调整前后或左右位置。`)
  }
  for(const a of project.actors){
    if(a.height<25||a.height>210||a.raise<0||a.raise>20||actorWidth(a)>240||a.height+a.raise+8>248)errors.push(`${a.name}过大，无法整件平放打印。`)
    if(a.x-actorWidth(a)/2<0||a.x+actorWidth(a)/2>project.base.width)errors.push(`${a.name}超出了画幅左右边缘。`)
    if(project.stage.enabled&&Math.abs(a.y-stageParts(project).y)<3.1)errors.push(`${a.name}与背景板相互穿过，请拉开前后间距。`)
  }
  for(let i=0;i<project.actors.length;i++)for(let j=i+1;j<project.actors.length;j++){
    const a=project.actors[i],b=project.actors[j]
    if(Math.abs(a.y-b.y)>=2.8)continue
    const translate=(actor:StandeeActor):MultiPolygon=>actorDomain(actor).map(p=>p.map(r=>r.map(([x,z])=>[x+actor.x-actorWidth(actor)/2,z+actor.raise] as Pair)))
    if(pc.intersection(translate(a),translate(b)).length)errors.push(`${a.name}与${b.name}在同一排相互穿过，请拉开前后间距。`)
  }
  return [...new Set(errors)]
}
export function assertStandeeProject(value: unknown): asserts value is StandeeProject {
  const p=value as StandeeProject
  if(!p||p.format!=='snapboard-standee'||p.version!==1||!p.base||!p.stage||!Array.isArray(p.actors)||p.actors.length>12)throw new Error('这不是有效的立牌工程文件。')
  if(!['rounded','oval','rectangle'].includes(p.base.shape)||!['arch','rounded','oval'].includes(p.stage.shape))throw new Error('工程中的底座或背景形状无效。')
  const numbers=[p.base.width,p.base.depth,p.base.height,p.stage.height,p.stage.frameWidth,p.clearance,...p.actors.flatMap(a=>[a.height,a.x,a.y,a.raise])]
  if(!numbers.every(n=>Number.isFinite(n)))throw new Error('工程含无效尺寸。')
  for(const image of [...p.actors.map(a=>a.image),...(p.stage.image?[p.stage.image]:[])]){
    if(!image||!/^data:image\/(png|jpeg|webp|svg\+xml)[;,]/.test(image.data)||image.data.length>8_000_000||!Array.isArray(image.outline)||image.outline.length<3||image.outline.length>12000||!image.outline.every(q=>q.length===2&&q.every(Number.isFinite))||!(image.width>0&&image.height>0)||!Number.isFinite(image.anchor))throw new Error('工程中的图片或轮廓无效。')
  }
}
