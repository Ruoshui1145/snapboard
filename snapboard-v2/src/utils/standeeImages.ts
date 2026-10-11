import { buildTextureRegionContours } from './textureRegionContours'
import { shapeOutline, outlinePath, inside, type StandeeImage, type StandeeProject, type StandeePoint } from './standeeDesign'

export const svgData = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
export const imageElement = (src: string) => new Promise<HTMLImageElement>((resolve,reject)=>{
  const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图片无法读取，请使用 PNG、JPG、WebP 或 SVG。'));image.src=src
})
export async function readStandeeImage(source: File | string, name: string, background=false): Promise<StandeeImage> {
  let src:string
  if(typeof source==='string')src=source
  else{
    if(source.size>16*1024*1024)throw new Error('图片不能超过16MB。')
    if(!/\.(png|jpe?g|webp|svg)$/i.test(source.name))throw new Error('请选择PNG、JPG、WebP或SVG图片。')
    src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败。'));reader.readAsDataURL(source)})
  }
  const image=await imageElement(src),ratio=Math.min(1,1000/Math.max(image.naturalWidth,image.naturalHeight))
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio))
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(image,0,0,canvas.width,canvas.height)
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),data=pixels.data,w=canvas.width,h=canvas.height
  if(!background){
    let transparent=false
    for(let i=3;i<data.length;i+=4)if(data[i]<128){transparent=true;break}
    if(!transparent){
      // Remove only near-white background connected to the image border.
      // White faces and clothing enclosed by line art remain intact.
      const seen=new Uint8Array(w*h),queue=new Int32Array(w*h);let start=0,end=0
      const add=(x:number,y:number)=>{if(x<0||y<0||x>=w||y>=h)return;const i=y*w+x;if(seen[i])return;seen[i]=1;const k=i*4;if(data[k]>235&&data[k+1]>235&&data[k+2]>235)queue[end++]=i}
      for(let x=0;x<w;x++){add(x,0);add(x,h-1)}for(let y=0;y<h;y++){add(0,y);add(w-1,y)}
      while(start<end){const i=queue[start++],x=i%w,y=Math.floor(i/w);data[i*4+3]=0;add(x-1,y);add(x+1,y);add(x,y-1);add(x,y+1)}
      ctx.putImageData(pixels,0,0)
    }
  }
  let xmin=w,ymin=h,xmax=0,ymax=0
  if(background){xmin=0;ymin=0;xmax=w-1;ymax=h-1}
  else for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>=128){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y)}
  if(xmin>xmax||ymin>ymax)throw new Error('没有找到角色轮廓，请选择主体清晰的图片。')
  const crop=document.createElement('canvas');crop.width=xmax-xmin+1;crop.height=ymax-ymin+1;crop.getContext('2d')!.drawImage(canvas,xmin,ymin,crop.width,crop.height,0,0,crop.width,crop.height)
  if(background)return {data:crop.toDataURL('image/png'),width:crop.width,height:crop.height,outline:[[0,0],[1,0],[1,1],[0,1]],anchor:.5,name}
  const r=Math.min(1,320/Math.max(crop.width,crop.height)),mask=document.createElement('canvas');mask.width=Math.max(3,Math.round(crop.width*r));mask.height=Math.max(3,Math.round(crop.height*r));mask.getContext('2d')!.drawImage(crop,0,0,mask.width,mask.height)
  const alpha=mask.getContext('2d')!.getImageData(0,0,mask.width,mask.height).data
  const materials=new Int16Array(mask.width*mask.height)
  for(let i=0;i<materials.length;i++)materials[i]=alpha[i*4+3]>=128?0:-1
  const {regions}=buildTextureRegionContours({materials,width:mask.width,height:mask.height,xBoundaries:Array.from({length:mask.width+1},(_,i)=>i),yBoundaries:Array.from({length:mask.height+1},(_,i)=>i),toleranceMm:0,straightFit:true})
  const polygons=regions.get(0)??[]
  const area=(points:number[][])=>Math.abs(points.reduce((s,a,i)=>{const b=points[(i+1)%points.length];return s+a[0]*b[1]-b[0]*a[1]},0)/2)
  polygons.sort((a,b)=>area(b.outer)-area(a.outer))
  if(!polygons.length)throw new Error('未提取到完整轮廓。')
  const outline=polygons[0].outer.map(([x,y])=>[x/mask.width,1-y/mask.height] as [number,number])
  const bottom=Math.min(...outline.map(p=>p[1])),scan=bottom+2/mask.height,hits:number[]=[]
  for(let i=0;i<outline.length;i++){
    const a=outline[i],b=outline[(i+1)%outline.length]
    if((a[1]>scan)!==(b[1]>scan))hits.push(a[0]+(scan-a[1])*(b[0]-a[0])/(b[1]-a[1]))
  }
  hits.sort((a,b)=>a-b)
  const supports:Array<{center:number;width:number}>=[]
  for(let i=0;i+1<hits.length;i+=2)supports.push({center:(hits[i]+hits[i+1])/2,width:hits[i+1]-hits[i]})
  supports.sort((a,b)=>(Math.abs(a.center-.5)-a.width*.03)-(Math.abs(b.center-.5)-b.width*.03))
  const lowest=outline.filter(p=>p[1]<=bottom+1e-6)
  const anchor=supports[0]?.center??lowest.reduce((best,p)=>Math.abs(p[0]-.5)<Math.abs(best-.5)?p[0]:best,lowest[0][0])
  return {data:crop.toDataURL('image/png'),width:crop.width,height:crop.height,outline,anchor,name}
}

const mascot=(variant:number)=>svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160"><g stroke="#29416F" stroke-width="3" stroke-linejoin="round"><path fill="${['#779DF3','#96BEEA','#83A7E0'][variant%3]}" d="M32 61 Q5 49 12 27 Q22 5 50 10 Q60 -1 71 10 Q106 2 110 36 Q119 55 90 68 L101 109 Q109 134 86 140 L83 155 H66 L62 142 H55 L51 155 H33 L32 138 Q12 125 24 102Z"/><ellipse cx="60" cy="55" rx="35" ry="30" fill="#FFF5E8"/><path d="M23 43 Q25 6 60 13 Q101 12 98 45 Q77 35 64 24 L52 47 L45 33 L30 47" fill="#5B81D8"/><ellipse cx="45" cy="58" rx="5" ry="7" fill="#264779"/><ellipse cx="76" cy="58" rx="5" ry="7" fill="#264779"/><path d="M53 72 Q60 77 67 72" fill="none"/><path fill="#EDF5FF" d="M38 89 Q59 79 81 90 L87 127 Q60 141 31 127Z"/><path d="M42 100 Q60 94 75 100 L68 108 Q56 119 46 108Z" fill="#6495ED"/><path d="M75 99 L88 93 L82 108" fill="#6495ED"/><path d="M30 101 L16 112 L26 121 M90 101 L105 113 L95 120" fill="#FFF5E8"/></g></svg>`)
export async function createStandeeSample(): Promise<StandeeProject> {
  const images=await Promise.all([0,1,2].map(i=>readStandeeImage(mascot(i),'星旅伙伴')))
  return {format:'snapboard-standee',version:1,name:'我的星旅舞台',base:{shape:'rounded',width:240,depth:100,height:18,style:'podium'},
    stage:{enabled:true,shape:'arch',height:218,frame:true,frameWidth:6,innerFrame:false,color:'#0064F0'},wave:true,clearance:.3,
    actors:[{id:'actor-main',name:'主角色',image:images[0],height:170,x:120,y:53,raise:0},
      {id:'actor-1',name:'左侧伙伴',image:images[1],height:64,x:40,y:24,raise:0},
      {id:'actor-2',name:'右侧伙伴',image:images[2],height:64,x:200,y:24,raise:0}]}
}
export function backgroundArtwork(project: StandeeProject) {
  const w=project.base.width-8,h=project.stage.height,t=project.stage.frame?project.stage.frameWidth:0
  const inner=outlinePath(shapeOutline(project.stage.shape,w-2*t,h-2*t).map(([x,y])=>[x+t,h-y-t]))
  let imageX=t,imageY=t,imageW=w-2*t,imageH=h-2*t
  if(project.stage.imageFit==='contain'&&project.stage.image){
    const outline=shapeOutline(project.stage.shape,imageW,imageH),source=project.stage.image
    let lo=0,hi=Math.min(imageW/source.width,imageH/source.height)
    for(let i=0;i<24;i++){
      const scale=(lo+hi)/2,ww=source.width*scale,hh=source.height*scale
      const corners=[[-1,-1],[-1,1],[1,-1],[1,1]].map(([x,y])=>[imageW/2+x*ww/2,imageH/2+y*hh/2] as StandeePoint)
      if(corners.every(p=>inside(p,outline)))lo=scale;else hi=scale
    }
    imageW=source.width*lo;imageH=source.height*lo;imageX=(w-imageW)/2;imageY=(h-imageH)/2
  }
  const safe=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><clipPath id="picture"><path d="${inner}"/></clipPath></defs><rect width="${w}" height="${h}" fill="${project.stage.color}"/><g clip-path="url(#picture)"><rect width="${w}" height="${h}" fill="#DFEDF9"/>${project.stage.image?`<image href="${safe(project.stage.image.data)}" x="${imageX}" y="${imageY}" width="${imageW}" height="${imageH}" preserveAspectRatio="xMidYMid ${project.stage.imageFit === 'contain' ? 'meet' : 'slice'}"/>`:`<g fill="#AAC6EE"><circle cx="${w*.2}" cy="${h*.26}" r="${w*.1}"/><path d="M${w*.14} ${h*.68}Q${w*.37} ${h*.56} ${w*.6} ${h*.73}T${w} ${h*.76}V${h}H0Z"/></g><g fill="#FFF"><path d="M${w*.75} ${h*.2}l3 8 8 3-8 3-3 8-3-8-8-3 8-3Z"/><circle cx="${w*.28}" cy="${h*.46}" r="3"/></g>`}</g>${project.stage.innerFrame?`<path d="${inner}" fill="none" stroke="#FFFFFF" stroke-width="2"/>`:''}</svg>`
  return svgData(svg)
}
export function waveArtwork(width:number){return svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="14"><rect width="100%" height="100%" fill="#80CEF1"/><path d="M-20 6Q10-2 40 6T100 6T160 6T220 6T280 6" fill="none" stroke="#E9F7FF" stroke-width="3"/><path d="M-20 13Q10 5 40 13T100 13T160 13T220 13T280 13" fill="none" stroke="#4398C7" stroke-width="2"/></svg>`)}
