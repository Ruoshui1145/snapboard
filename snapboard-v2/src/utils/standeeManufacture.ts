import type { MultiPolygon, Pair } from 'polygon-clipping'
import { extrudeTexturePartition } from './textureRegionExtrusion'
import { buildRasterTextureLayerResponsive } from './textureRasterLayer'
import { loadSnapColorLut, matchSnapColor } from './snapColorLut'
import { createPreparedManufacturing3MF, type ManufacturingObject, type ManufacturingPart } from './export3mf'
import { PEGBOARD_DEFAULT_CONFIG } from './pegboardSplit'
import { actorDomain, actorWidth, plannedSlots, RYBW_COLORS, shapeOutline, slotKey, stageParts, validateStandee, waveParts, type StandeeProject, type StandeeActor, type StandeeImage } from './standeeDesign'
import { backgroundArtwork, imageElement, waveArtwork } from './standeeImages'

const dense={layer_height:'0.20',wall_loops:'3',top_shell_layers:'3',bottom_shell_layers:'3',top_shell_thickness:'0.6',bottom_shell_thickness:'0.6',sparse_infill_density:'100%',sparse_infill_pattern:'zig-zag'}
const optical={...dense,layer_height:'0.08',wall_loops:'1',top_shell_layers:'0',bottom_shell_layers:'1',bottom_shell_thickness:'0'}
function prism(shape:MultiPolygon,lo:number,hi:number,name:string){
  const raw=extrudeTexturePartition(shape.flatMap(p=>[{outer:p[0],holes:p.slice(1)}]),lo,hi)
  const vertices:Array<[number,number,number]>=[],triangles:Array<[number,number,number]>=[]
  for(let i=0;i<raw.vertices.length;i+=3)vertices.push([raw.vertices[i],raw.vertices[i+1],raw.vertices[i+2]])
  for(let i=0;i<raw.triangles.length;i+=3)triangles.push([raw.triangles[i],raw.triangles[i+1],raw.triangles[i+2]])
  return {name,vertices,triangles}
}
function object(key:string,name:string,parts:ManufacturingPart[]):ManufacturingObject {
  let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity
  for(const p of parts)for(const [x,y] of p.mesh.vertices){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y)}
  return {key,name,parts,mesh:{name,vertices:[[xmin,ymin,0],[xmax,ymin,0],[xmax,ymax,0],[xmin,ymax,0]],triangles:[]},kind:'part',quantity:1,preferredRotation:0,frontOnBed:true}
}
function baseRing(project:StandeeProject,inset:number):Pair[]{
  const {width:w,depth:h,shape}=project.base
  if(shape!=='rounded')return shapeOutline(shape,w-2*inset,h-2*inset).map(([x,y])=>[x+inset,y+inset])
  const r=Math.min(w*.08,h*.16,12)-inset,points:Pair[]=[]
  for(const [cx,cy,start] of [[w-r-inset,r+inset,-Math.PI/2],[w-r-inset,h-r-inset,0],[r+inset,h-r-inset,Math.PI/2],[r+inset,r+inset,Math.PI]])
    for(let i=0;i<=12;i++)points.push([cx+r*Math.cos(start+i/12*Math.PI/2),cy+r*Math.sin(start+i/12*Math.PI/2)])
  return points
}
function baseSection(project:StandeeProject,inset:number,holes:boolean,opening=0):Pair[][]{
  const outer=baseRing(project,inset)
  const inner=holes?plannedSlots(project).map(s=>{
    const x=s.x-s.width/2-opening,y=s.y-s.depth/2-opening,w=s.width+2*opening,h=s.depth+2*opening
    return [[x,y],[x,y+h],[x+w,y+h],[x+w,y]] as Pair[]
  }):[]
  return [outer,...inner]
}
function transition(lower:Pair[][],upper:Pair[][],lo:number,hi:number,name:string){
  const vertices:Array<[number,number,number]>=[],triangles:Array<[number,number,number]>=[],byPoint=new Map<string,number>()
  const index=(v:[number,number,number])=>{const point=v.map(n=>Math.round(n*1e5)/1e5) as [number,number,number],key=point.join(',');let i=byPoint.get(key);if(i===undefined){i=vertices.length;vertices.push(point);byPoint.set(key,i)}return i}
  for(const [rings,z] of [[lower,lo],[upper,hi]] as const){
    const cap=prism([rings],lo,hi,name)
    for(const face of cap.triangles)if(face.every(i=>Math.abs(cap.vertices[i][2]-z)<1e-8))triangles.push(face.map(i=>index(cap.vertices[i])) as [number,number,number])
  }
  lower.forEach((ring,r)=>ring.forEach((a,i)=>{
    const b=ring[(i+1)%ring.length],c=upper[r][(i+1)%ring.length],d=upper[r][i]
    const ids=[index([a[0],a[1],lo]),index([b[0],b[1],lo]),index([c[0],c[1],hi]),index([d[0],d[1],hi])]
    triangles.push([ids[0],ids[1],ids[2]],[ids[0],ids[2],ids[3]])
  }))
  return {name,vertices,triangles}
}
export function createStandeeBase(project:StandeeProject):ManufacturingObject {
  const {height}=project.base,slotStart=height-8.2,pieces=[]
  pieces.push(transition(baseSection(project,.5,false),baseSection(project,0,false),0,.5,'底座底边导角'))
  const grooved=project.base.style==='podium',bands=grooved?[[2.4,2.8],[height-3,height-2.6]]:[]
  const breaks=[...new Set([.5,slotStart,height-.5,...bands.flat()])].filter(z=>z>=.5&&z<=height-.5).sort((a,b)=>a-b)
  for(let i=0;i<breaks.length-1;i++){
    const lo=breaks[i],hi=breaks[i+1],mid=(lo+hi)/2,inset=bands.some(([a,b])=>mid>a&&mid<b)?.4:0
    pieces.push(prism([baseSection(project,inset,mid>slotStart)],lo,hi,'底座实体'))
  }
  pieces.push(transition(baseSection(project,0,true),baseSection(project,.18,true),height-.5,height-.32,'顶面外周倒角'))
  pieces.push(transition(baseSection(project,.18,true),baseSection(project,.5,true,.32),height-.32,height,'槽口导角'))
  const mesh={name:'底座',vertices:[] as Array<[number,number,number]>,triangles:[] as Array<[number,number,number]>}
  for(const piece of pieces){const offset=mesh.vertices.length;for(const v of piece.vertices)mesh.vertices.push(v);for(const t of piece.triangles)mesh.triangles.push(t.map(i=>i+offset) as [number,number,number])}
  return object('base','底座 · 已按最终位置开槽',[{name:'底座实体',mesh,
    extruder:1,color:RYBW_COLORS[0],settings:{...dense,sparse_infill_density:'15%',sparse_infill_pattern:'gyroid'}}])
}
// Keep only the last two prepared panels. Placement changes do not change the
// local mesh; size, outline, image and raised support changes invalidate it.
const panelCacheKey=(shape:MultiPolygon,art:string,w:number,h:number,thickness:number)=>JSON.stringify([shape,w,h,thickness])+art
const preparedPanelCache=new Map<string,{object:ManufacturingObject;prediction:string}>()
async function colourPanel(key:string,name:string,shape:MultiPolygon,art:string,artW:number,artH:number,thickness:number,onProgress:(message:string)=>void){
  const cacheKey=panelCacheKey(shape,art,artW,artH,thickness)
  const cached=preparedPanelCache.get(cacheKey)
  if(cached){
    preparedPanelCache.delete(cacheKey);preparedPanelCache.set(cacheKey,cached)
    return {...cached.object,key,name,parts:cached.object.parts.map(p=>({...p,name:p.name.replace(cached.object.name,()=>name)}))}
  }
  const points=shape.flat(2),xmin=Math.min(...points.map(p=>p[0])),ymin=Math.min(...points.map(p=>p[1])),xmax=Math.max(...points.map(p=>p[0])),ymax=Math.max(...points.map(p=>p[1]))
  const width=xmax-xmin,height=ymax-ymin,pitch=.4,nx=Math.ceil(width/pitch),ny=Math.ceil(height/pitch)
  const dx=width/nx,dy=height/ny
  const normalized:MultiPolygon=shape.map(p=>p.map(r=>r.map(([x,y])=>[x-xmin,y-ymin] as Pair)))
  const canvas=document.createElement('canvas');canvas.width=nx;canvas.height=ny
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,nx,ny)
  const image=await imageElement(art)
  ctx.drawImage(image,-xmin/dx,(ymax-artH)/dy,artW/dx,artH/dy)
  const rgba=ctx.getImageData(0,0,nx,ny).data,lut=await loadSnapColorLut('snapcolor-petg-rybw')
  const cache=new Map<number,number>(),recipes=new Uint16Array(nx*ny)
  for(let row=0;row<ny;row++)for(let col=0;col<nx;col++){
    const offset=((ny-1-row)*nx+col)*4
    const r=Math.min(255,Math.round(rgba[offset]/8)*8),g=Math.min(255,Math.round(rgba[offset+1]/8)*8),b=Math.min(255,Math.round(rgba[offset+2]/8)*8),color=r*65536+g*256+b
    let recipe=cache.get(color)
    if(recipe===undefined){recipe=matchSnapColor([r,g,b],lut);cache.set(color,recipe)}
    recipes[row*nx+col]=recipe
  }
  const materialParts=new Map<number,ManufacturingPart>()
  const prediction=ctx.createImageData(nx,ny)
  for(let row=0;row<ny;row++)for(let col=0;col<nx;col++){
    const source=recipes[row*nx+col]*3,target=((ny-1-row)*nx+col)*4
    prediction.data[target]=lut.measured[source];prediction.data[target+1]=lut.measured[source+1];prediction.data[target+2]=lut.measured[source+2];prediction.data[target+3]=255
  }
  ctx.putImageData(prediction,0,0)
  const predictionData=canvas.toDataURL('image/png')
  for(let layer=0;layer<5;layer++){
    onProgress(`${name}：生成第 ${layer+1}/5 层叠色`)
    // The LUT stack starts at the viewing surface. Face-down printing writes
    // it directly from the bed upward, matching the existing Lumina pipeline.
    const materials=Int16Array.from(recipes,recipe=>lut.stacks[recipe*5+layer])
    const result=await buildRasterTextureLayerResponsive({materials,width:nx,height:ny,
      xBoundaries:Array.from({length:nx+1},(_,i)=>i*dx),yBoundaries:Array.from({length:ny+1},(_,i)=>i*dy),
      colorDomain:normalized,panelId:key,panelX:0,panelY:0,layer,zMin:layer*.08,zMax:(layer+1)*.08,straightFit:true})
    for(const [material,mesh] of result.meshes){
      let part=materialParts.get(material)
      if(!part){part={name:`${name} · RYBW ${['白','红','黄','蓝'][material]}`,mesh:{name:key,vertices:[],triangles:[]},extruder:material+1,color:RYBW_COLORS[material],settings:optical};materialParts.set(material,part)}
      const offset=part.mesh.vertices.length;for(const v of mesh.vertices)part.mesh.vertices.push(v)
      for(const t of mesh.triangles)part.mesh.triangles.push(t.map(i=>i+offset) as [number,number,number])
    }
  }
  const parts=[...materialParts.values(),
    {name:`${name} · 白色承托0.6mm`,mesh:prism(normalized,.4,1,'白承托'),extruder:1,color:'#FFFFFF',settings:dense},
    {name:`${name} · 白色结构背托`,mesh:prism(normalized,1,thickness,'结构背托'),extruder:1,color:'#FFFFFF',settings:dense}]
  // One horizontal mirror compensates for the artwork facing the build plate.
  for(const part of parts){for(const v of part.mesh.vertices)v[0]=width-v[0];for(const t of part.mesh.triangles)[t[1],t[2]]=[t[2],t[1]]}
  const result=object(key,name,parts)
  preparedPanelCache.set(cacheKey,{object:result,prediction:predictionData})
  while(preparedPanelCache.size>2)preparedPanelCache.delete(preparedPanelCache.keys().next().value!)
  return result
}
export type StandeeImportKind='background'|'actor'
export interface PreparedStandeePlate {
  kind:StandeeImportKind; image:StandeeImage; height:number; width:number; thickness:number;
  object:ManufacturingObject; prediction:string; actor?:StandeeActor; stage?:StandeeProject['stage'];
}
export async function prepareStandeeImagePlate(project:StandeeProject,kind:StandeeImportKind,image:StandeeImage,height:number,
  stageOptions:Pick<StandeeProject['stage'],'shape'|'frame'|'innerFrame'|'imageFit'>,onProgress:(message:string)=>void):Promise<PreparedStandeePlate>{
  if(kind==='background'){
    const stage={...project.stage,...stageOptions,height,image,enabled:true}
    const draft={...project,stage},s=stageParts(draft)
    if(height+8>248)throw new Error('背景板过高，含插脚需在248mm内。')
    const art=backgroundArtwork(draft),prepared=await colourPanel('stage','自定义背景板',s.combined,art,s.width,s.height,3.2,onProgress)
    return {kind,image,height,width:s.width,thickness:3.2,stage,object:prepared,prediction:preparedPanelCache.get(panelCacheKey(s.combined,art,s.width,s.height,3.2))!.prediction}
  }
  const actor:StandeeActor={id:`actor-${crypto.randomUUID()}`,name:image.name.replace(/\.[^.]+$/,''),image,height,x:project.base.width/2,y:40,raise:0}
  if(actorWidth(actor)>Math.min(240,project.base.width))throw new Error('角色板太宽，请降低板件高度，或作为背景板导入。')
  const shape=actorDomain(actor)
  if(shape.length!==1)throw new Error('插脚未能连接到主体，请选择轮廓连续的图片，或改为矩形照片板。')
  const prepared=await colourPanel(actor.id,actor.name,shape,image.data,actorWidth(actor),height,2.4,onProgress)
  return {kind,image,height,width:actorWidth(actor),thickness:2.4,actor,object:prepared,prediction:preparedPanelCache.get(panelCacheKey(shape,image.data,actorWidth(actor),height,2.4))!.prediction}
}
export async function exportPreparedStandeePlate(plate:PreparedStandeePlate){
  return createPreparedManufacturing3MF({objects:[plate.object],cfg:{...PEGBOARD_DEFAULT_CONFIG,printerPreset:'bambu-p1s',bedW:256,bedH:256,manufacturingChamfer:0,thickness:plate.thickness},
    colors:RYBW_COLORS,title:`${plate.image.name} · ${plate.kind==='background'?'背景板':'角色立牌'}`,
    metadata:{format:'standee-image-plate',kind:plate.kind,imageName:plate.image.name,width:plate.width,height:plate.height,thickness:plate.thickness,
      preparedBeforePlacement:true,colourLayers:5,colourLayerHeight:.08,whiteCarrierThickness:.6}})
}
export async function generateStandee3MF(project:StandeeProject,onProgress:(message:string)=>void){
  const issues=validateStandee(project)
  if(issues.length)throw new Error(issues[0])
  if(project.slotsKey!==slotKey(project))throw new Error('布局已改变，请先重新生成插槽。')
  onProgress('生成底座与最终插槽…')
  const objects=[createStandeeBase(project)]
  if(project.stage.enabled){const s=stageParts(project);objects.push(await colourPanel('stage','一体背景板与边框',s.combined,backgroundArtwork(project),s.width,s.height,3.2,onProgress))}
  for(const actor of project.actors)objects.push(await colourPanel(actor.id,actor.name,actorDomain(actor),actor.image.data,actorWidth(actor),actor.height,2.4,onProgress))
  if(project.wave){const s=waveParts(project);objects.push(await colourPanel('wave','波浪前景',s.combined,waveArtwork(s.width),s.width,s.height,2.4,onProgress))}
  objects.sort((a,b)=>{
    const area=(o:ManufacturingObject)=>Math.abs((o.mesh.vertices[2][0]-o.mesh.vertices[0][0])*(o.mesh.vertices[2][1]-o.mesh.vertices[0][1]))
    return area(b)-area(a)
  })
  onProgress('排盘并生成全套3MF…')
  return createPreparedManufacturing3MF({objects,cfg:{...PEGBOARD_DEFAULT_CONFIG,printerPreset:'bambu-p1s',bedW:256,bedH:256,manufacturingChamfer:0,thickness:2.4},
    colors:RYBW_COLORS,title:project.name,metadata:{format:project.format,version:project.version,base:project.base,stage:{...project.stage,image:undefined},
      actors:project.actors.map(a=>({...a,image:{name:a.image.name,outline:a.image.outline,anchor:a.image.anchor}})),slots:plannedSlots(project),
      backgroundConstruction:'integral 3.2mm with 0.4 colour + 0.6 carrier + 2.2 white backing',slicerLaunched:false}})
}
