import type {MultiPolygon} from 'polygon-clipping'
import type {BoardTextureConfig,LatticeFaceData,SplitConfig,SplitPanel} from '../types/geometry'
import type {AssemblyMarkingConfig} from './assemblyMarking'
import {createBoardTextureCanvas,createBoardTextureManufacturingData,getSplitPanelTextureBounds,hasBoardTextureSource,backTextureForRendering,texturePanelsForSide} from './boardTexture'
import {loadSnapColorLut,matchSnapColor,snapColorMeasuredColor,snapColorStackMaterial,SNAPCOLOR_LUTS,normalizeSnapColorLutId,type SnapColorLut} from './snapColorLut'
import {buildTextureVectorRegions} from './textureVectorRegions'
import {createSplitPanelShape} from './boardMesh'
import {currentSvgFace} from './svgLattice'
import {isPlainRetainedFront} from './latticeFaceMesh'
import {textureLayerDomains} from './textureManufacturingDomain'
import {texturePolygon as pc} from './texturePolygon'
import {textureLayerDepths} from './textureLayerDepths'
import {woodGrainVeneerDepth,normalizeWoodGrainTexture} from './woodGrain'

export interface LayerPreviewMaterial {name:string;color:string}
interface ColorSource {
  config:BoardTextureConfig;lut:SnapColorLut;bounds:ReturnType<typeof getSplitPanelTextureBounds>
  side:'front'|'back';width:number;height:number;recipes:Uint16Array|null
  regions:Array<{polygons:MultiPolygon;recipe:number}>|null
}
export interface LayerPreviewSources {front:ColorSource|null;back:ColorSource|null}
interface Band {lo:number;hi:number;name:string;kind:'core'|'carrier'|'optical'|'veneer'|'face';material:number;source?:ColorSource;domain?:MultiPolygon;side?:'front'|'back';note?:string;colors?:string[];opticalLayerCount?:number;opticalLayerHeight?:number}
export interface LayerPreviewSection {lo:number;hi:number;name:string;group:string;kind:Band['kind'];side?:'front'|'back';note:string;colors:string[];opticalLayerCount?:number;opticalLayerHeight?:number}
export interface LayerPreviewPlate {
  panel:SplitPanel;bands:Band[];sections:LayerPreviewSection[];materials:LayerPreviewMaterial[]
  face:LatticeFaceData|null;base:MultiPolygon;rear:MultiPolygon;chamferMm:number
}
export interface LayerPreviewTile {width:number;height:number;materialIds:Uint8Array;counts:number[];rgba?:Uint8ClampedArray<ArrayBuffer>;materials?:LayerPreviewMaterial[]}
const rgb=(color:string)=>[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)) as [number,number,number]
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('预览已取消','AbortError')}
const yieldBrowser=()=>new Promise<void>(resolve=>setTimeout(resolve,0))
const polygons=(layer:LatticeFaceData['layers'][number]):MultiPolygon=>layer.polygons.map(p=>p.map(r=>{const ring=r.map(p=>[p.x,p.y] as [number,number]);return [...ring,ring[0]]}))

async function prepareColorSource(config:BoardTextureConfig,panels:SplitPanel[],side:'front'|'back',signal?:AbortSignal):Promise<ColorSource>{
  const bounds=getSplitPanelTextureBounds(panels),lut=await loadSnapColorLut(config.lutId)
  check(signal)
  if(config.modelingMode==='vector'&&config.manufacturingContours!==false){
    const vector=await buildTextureVectorRegions(config,bounds,panels);check(signal)
    if(vector.eligible)return {config,lut,bounds,side,width:0,height:0,recipes:null,regions:vector.regions.map(r=>({polygons:r.polygons,recipe:matchSnapColor(rgb(r.color),lut,config.hueWeight)}))}
  }
  if(config.manufacturingEdgeQuality==='fine'&&config.modelingMode==='high-fidelity'){
    const data=await createBoardTextureManufacturingData(config,panels,Math.max(bounds.width,bounds.height)/1024);check(signal)
    if(data?.recipeIds)return {config,lut,bounds,side,width:data.canvas.width,height:data.canvas.height,recipes:data.recipeIds,regions:null}
  }
  // Reuse the existing bounded colour solve. Never extrude colour paths or run CSG here.
  const canvas=await createBoardTextureCanvas(config,bounds.width/bounds.height,panels);check(signal)
  if(!canvas)throw new Error('无法读取叠色图案')
  const pixels=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data
  const recipes=new Uint16Array(canvas.width*canvas.height),matches=new Map<number,number>()
  for(let i=0;i<recipes.length;i++){
    const j=i*4,key=(pixels[j]<<16)|(pixels[j+1]<<8)|pixels[j+2]
    let recipe=matches.get(key)
    if(recipe===undefined){recipe=matchSnapColor([pixels[j],pixels[j+1],pixels[j+2]],lut,config.hueWeight);matches.set(key,recipe)}
    recipes[i]=recipe
    if(i>0&&i%65536===0){await yieldBrowser();check(signal)}
  }
  return {config,lut,bounds,side,width:canvas.width,height:canvas.height,recipes,regions:null}
}

/** One immutable recipe grid per face, shared by every selected board and section. */
export async function prepareLayerPreviewSources(panels:SplitPanel[],cfg:SplitConfig,texture:BoardTextureConfig,marking:AssemblyMarkingConfig,name:string,signal?:AbortSignal):Promise<LayerPreviewSources>{
  if(!texture.enabled||texture.surfaceMode!=='snapcolor'||!panels.some(p=>!p.latticeFace||isPlainRetainedFront(p)))return {front:null,back:null}
  if(!hasBoardTextureSource(texture))throw new Error('请先在纹理工作室添加图案，或关闭纹理查看普通板')
  const frontPanels=panels.map(p=>isPlainRetainedFront(p)?{...p,latticeFace:undefined,latticeCutouts:undefined}:p)
  const front=await prepareColorSource(texture,frontPanels,'front',signal)
  const backConfig=texture.backEnabled?backTextureForRendering(texture,panels,cfg,marking,name):null
  if(texture.backEnabled&&!backConfig)throw new Error('背面图案缺失，请在纹理工作室补齐')
  const back=backConfig?await prepareColorSource(backConfig,texturePanelsForSide(panels,'back'),'back',signal):null
  return {front,back}
}

function boardDomain(panel:SplitPanel,cfg:SplitConfig,clearLattice=false):MultiPolygon {
  const shape=createSplitPanelShape({...panel,latticeFace:undefined,...(clearLattice?{latticeCutouts:undefined}:{})},cfg,16).extractPoints(24)
  const ring=(p:Array<{x:number;y:number}>)=>{const r=p.map(v=>[v.x,v.y] as [number,number]);return [...r,r[0]]}
  return [[ring(shape.shape),...shape.holes.map(ring)]]
}

export function createLayerPreviewPlate(panel:SplitPanel,cfg:SplitConfig,texture:BoardTextureConfig,sources:LayerPreviewSources={front:null,back:null}):LayerPreviewPlate {
  const face=panel.latticeFace?currentSvgFace(panel,cfg):null,total=cfg.thickness
  if(!Number.isFinite(total)||total<=0)throw new Error('板厚无效，请先检查板材设计')
  const textured=texture.enabled&&(!face||isPlainRetainedFront(panel)&&texture.surfaceMode!=='woodgrain'),wood=textured&&texture.surfaceMode==='woodgrain'
  const config=wood?normalizeWoodGrainTexture(texture):texture
  const materials:LayerPreviewMaterial[]=[{name:config.baseMaterialName||'结构基材',color:config.baseColor}]
  const bands:Band[]=[],base=boardDomain(panel,cfg,!!face),rear=boardDomain(panel,cfg)
  const material=(name:string,color:string)=>{const i=materials.findIndex(m=>m.name===name&&m.color===color);if(i>=0)return i;materials.push({name,color});return materials.length-1}
  const add=(lo:number,hi:number,name:string,kind:Band['kind'],id=0,extra:Partial<Band>={})=>{if(hi-lo>1e-6)bands.push({lo,hi,name,kind,material:id,...extra})}
  if(textured&&config.surfaceMode==='snapcolor'){
    const lut=sources.front?.lut??SNAPCOLOR_LUTS.find(l=>l.id===normalizeSnapColorLutId(config.lutId))
    if(!lut)throw new Error('叠色档案不存在，请重新选择耗材档案')
    const fd=textureLayerDepths(config,total,lut),bd=config.backEnabled?textureLayerDepths(config,total,sources.back?.lut??lut):null
    if(face&&fd.textureThickness>face.source!.options.backingMm+1e-6)throw new Error('正面保留厚度不足以容纳彩色层，请先调整镂空参数')
    if(bd&&total-fd.textureThickness-bd.textureThickness<2.5)throw new Error('双面彩印后的结构芯不足 2.5mm，请增加板厚或减薄彩色层')
    add(bd?.textureThickness??0,fd.structuralThickness,'基层','core',0,{note:config.baseMaterialName})
    add(fd.structuralThickness,fd.opticalStart,bd?'正面承托层':'承托层','carrier',0,{side:'front',note:'连接图案与基层，提供连续承托'})
    for(const side of (bd?['front','back']:['front']) as Array<'front'|'back'>){
      const source=sources[side],faceLut=source?.lut??lut,d=side==='front'?fd:bd!,name=bd?(side==='front'?'正面叠色层':'背面叠色层'):'叠色层'
      if(side==='back')add(total-d.opticalStart,d.textureThickness,'背面承托层','carrier',0,{side,domain:rear,note:'承托背面图案'})
      add(side==='front'?d.opticalStart:0,side==='front'?total:total-d.opticalStart,name,'optical',material(name,'#79AEDD'),{
        side,source:source??undefined,domain:side==='front'?base:rear,colors:faceLut.materials.map(m=>m.color),
        opticalLayerCount:faceLut.layerCount,opticalLayerHeight:faceLut.layerHeight,
        note:`${faceLut.layerCount} 个光学层 · ${faceLut.materials.map(m=>m.name).join(' / ')}`})
    }
  }else if(textured&&(wood||config.surfaceMode==='veneer')){
    const depth=wood?woodGrainVeneerDepth(total,config.textureThickness):textureLayerDepths(config,total,{layerHeight:.08,layerCount:5})
    const start='base'in depth?depth.base:depth.structuralThickness
    add(0,start,'基层','core',0,{note:config.baseMaterialName})
    add(start,total,'质感贴面','veneer',material(config.surfaceMaterialName,config.surfaceColor),{note:config.surfaceMaterialName})
  }else if(face){
    const baseColor=face.source?.options.sourceLayerId?texture.baseColor:'#3EC6B0'
    materials[0]={name:'板件基材',color:baseColor}
    for(const layer of face.layers){
      const detail=layer.role==='detail',id=detail&&face.contrastColor?material('线稿镶嵌',face.contrastColor):0
      add(layer.zMin,layer.zMax,{structure:'镂空基层',backing:'承托层',face:'图案细节层',detail:'图案细节层'}[layer.role],layer.role==='structure'?'core':layer.role==='backing'?'carrier':'face',id,{domain:polygons(layer)})
    }
  }else add(0,total,'基层','core',0,{note:config.baseMaterialName})
  const groups=new Map<string,LayerPreviewSection>()
  for(const band of bands){
    const key=`${band.kind}-${band.side??''}`,last=groups.get(key)
    if(last){last.lo=Math.min(last.lo,band.lo);last.hi=Math.max(last.hi,band.hi)}
    else groups.set(key,{lo:band.lo,hi:band.hi,name:band.name,group:key,kind:band.kind,side:band.side,note:band.note??'',colors:band.colors??[materials[band.material].color],opticalLayerCount:band.opticalLayerCount,opticalLayerHeight:band.opticalLayerHeight})
  }
  const sections=[...groups.values()].sort((a,b)=>b.hi-a.hi||b.lo-a.lo)
  return {panel,bands,sections,materials,face,base,rear,chamferMm:cfg.manufacturingChamfer}
}

const paths=new WeakMap<MultiPolygon,Path2D>()
function trace(domain:MultiPolygon):Path2D{
  const cached=paths.get(domain);if(cached)return cached
  const path=new Path2D()
  for(const p of domain)for(const ring of p){ring.forEach(([x,y],i)=>i?path.lineTo(x,y):path.moveTo(x,y));path.closePath()}
  paths.set(domain,path);return path
}

// Only the last crop is retained per immutable face. All optical thumbnails
// share it, avoiding a full-assembly raster and colour solve for each layer.
const cropCache=new WeakMap<ColorSource,{key:string;recipes:Uint16Array}>()
function recipeCrop(source:ColorSource,panel:SplitPanel,width:number,height:number):Uint16Array{
  const key=[panel.x,panel.y,panel.w,panel.h,width,height].join(','),cached=cropCache.get(source)
  if(cached?.key===key)return cached.recipes
  const recipes=new Uint16Array(width*height),b=source.bounds
  for(let y=0;y<height;y++){
    const worldY=panel.y+panel.h-(y+.5)/height*panel.h
    const row=Math.max(0,Math.min(source.height-1,Math.floor((b.maxY-worldY)/b.height*source.height)))
    for(let x=0;x<width;x++){
      const worldX=panel.x+(x+.5)/width*panel.w
      const col=Math.max(0,Math.min(source.width-1,Math.floor((source.side==='back'?b.maxX-worldX:worldX-b.minX)/b.width*source.width)))
      recipes[y*width+x]=source.recipes![row*source.width+col]
    }
  }
  cropCache.set(source,{key,recipes});return recipes
}

/** Outer viewing face first; uses exactly the same stack lookup as 3MF export. */
export function opticalPreviewMaterials(lut:SnapColorLut,layerFromFace:number):Int16Array{
  if(!Number.isInteger(layerFromFace)||layerFromFace<0||layerFromFace>=lut.layerCount)throw new Error('光学层序号无效')
  return Int16Array.from({length:lut.colorCount},(_,recipe)=>snapColorStackMaterial(lut,recipe,lut.layerCount-1-layerFromFace))
}

/** Material footprints are projected once; no printing layers or 3D slices are built. */
export async function renderLayerPreviewTile(plate:LayerPreviewPlate,index:number,signal?:AbortSignal,options:{opticalLayerFromFace?:number;maxEdge?:number}={}):Promise<LayerPreviewTile>{
  check(signal)
  const {panel,materials}=plate,section=plate.sections[index]
  if(!section)throw new Error('分层位置无效')
  const opticalLayer=options.opticalLayerFromFace
  if(opticalLayer!==undefined&&section.kind!=='optical')throw new Error('当前材料层不是叠色层')
  const scale=Math.min(768,Math.max(64,options.maxEdge??768))/Math.max(panel.w,panel.h),width=Math.max(1,Math.round(panel.w*scale)),height=Math.max(1,Math.round(panel.h*scale))
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!
  ctx.setTransform(width/panel.w,0,0,-height/panel.h,-panel.x*width/panel.w,(panel.y+panel.h)*height/panel.h)
  // Spaced channels survive Canvas edge premultiplication; raw IDs 1/2 can
  // round into each other and invent a second material around curved holes.
  const fill=(domain:MultiPolygon,id:number)=>{ctx.fillStyle=`rgb(${id%16*16+8},${Math.floor(id/16)*16+8},0)`;ctx.fill(trace(domain),'evenodd')}
  let colorCanvas:HTMLCanvasElement|null=null
  let palette=materials,raster:{source:ColorSource;recipes:Uint16Array;ids:Int16Array|null;material:number}|null=null
  for(const band of plate.bands.filter(b=>b.kind===section.kind&&b.side===section.side)){
    const domain=band.kind==='core'&&plate.face?pc.union(...plate.face.layers.filter(l=>l.role==='structure').map(polygons)):band.domain??(plate.face?plate.base:plate.rear)
    if(band.kind!=='optical'){fill(domain,band.material);continue}
    const source=band.source
    if(!source)throw new Error('请先载入此层图案')
    const ids=opticalLayer===undefined?null:opticalPreviewMaterials(source.lut,opticalLayer)
    if(ids)palette=[materials[0],...source.lut.materials]
    const inset=opticalLayer===undefined?0:Math.max(0,plate.chamferMm-(opticalLayer+.5)*source.lut.layerHeight)
    const b=source.bounds,domains=textureLayerDomains(domain,domain,inset,source.config.edgeSealEnabled?source.config.edgeSealWidth:0)
    fill(domains.seal,0)
    if(!ids||!source.regions)fill(domains.color,band.material)
    if(!source.regions){raster={source,recipes:recipeCrop(source,panel,width,height),ids,material:band.material};continue}
    if(ids){
      ctx.save();ctx.clip(trace(domains.color),'evenodd')
      if(source.side==='back'){ctx.translate(b.minX+b.maxX,0);ctx.scale(-1,1)}
      for(const region of source.regions){const m=ids[region.recipe];if(m>=0)fill(region.polygons,m+1)}
      ctx.restore();continue
    }
    colorCanvas=document.createElement('canvas');colorCanvas.width=width;colorCanvas.height=height
    const colorCtx=colorCanvas.getContext('2d')!
    colorCtx.setTransform(width/panel.w,0,0,-height/panel.h,-panel.x*width/panel.w,(panel.y+panel.h)*height/panel.h)
    colorCtx.fillStyle=materials[0].color;colorCtx.fill(trace(domains.seal),'evenodd')
    colorCtx.save();colorCtx.clip(trace(domains.color),'evenodd')
    if(source.regions){
      if(source.side==='back'){colorCtx.translate(b.minX+b.maxX,0);colorCtx.scale(-1,1)}
      for(const region of source.regions){
        colorCtx.fillStyle=`rgb(${snapColorMeasuredColor(source.lut,region.recipe).join(',')})`
        colorCtx.fill(trace(region.polygons),'evenodd')
      }
    }
    colorCtx.restore()
  }
  const pixels=ctx.getImageData(0,0,width,height).data,materialIds=new Uint8Array(width*height).fill(255),counts=palette.map(()=>0)
  const rgba=raster&&!raster.ids?new Uint8ClampedArray(width*height*4):colorCanvas?.getContext('2d')!.getImageData(0,0,width,height).data
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const src=y*width+x;let id=Math.round((pixels[src*4]-8)/16)+16*Math.round((pixels[src*4+1]-8)/16)
    if(pixels[src*4+3]<=127)continue
    if(raster&&id===raster.material){
      if(raster.ids){const m=raster.ids[raster.recipes[src]];if(m<0)continue;id=m+1}
      else if(rgba){const r=raster.recipes[src]*3,j=src*4;rgba[j]=raster.source.lut.measured[r];rgba[j+1]=raster.source.lut.measured[r+1];rgba[j+2]=raster.source.lut.measured[r+2];rgba[j+3]=255}
    }else if(raster&&rgba){const j=src*4,c=rgb(materials[id].color);rgba[j]=c[0];rgba[j+1]=c[1];rgba[j+2]=c[2];rgba[j+3]=255}
    if(id>=0&&id<palette.length){materialIds[src]=id;counts[id]++}
  }
  check(signal)
  return {width,height,materialIds,counts,rgba,materials:opticalLayer===undefined?undefined:palette}
}

export function layerPreviewPixels(tile:LayerPreviewTile,materials:LayerPreviewMaterial[],highlight:number|null=null):Uint8ClampedArray<ArrayBuffer>{
  const pixels=new Uint8ClampedArray(tile.width*tile.height*4),colors=(tile.materials??materials).map(m=>rgb(m.color))
  for(let i=0;i<tile.materialIds.length;i++){
    const id=tile.materialIds[i];if(id===255)continue
    const muted=highlight!==null&&id!==highlight
    const j=i*4,c=colors[id]
    if(tile.rgba&&!muted){pixels[j]=tile.rgba[j];pixels[j+1]=tile.rgba[j+1];pixels[j+2]=tile.rgba[j+2];pixels[j+3]=tile.rgba[j+3];continue}
    pixels[j]=muted?87:c[0];pixels[j+1]=muted?100:c[1];pixels[j+2]=muted?114:c[2];pixels[j+3]=muted?45:255
  }
  return pixels
}
