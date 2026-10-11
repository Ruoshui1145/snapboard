import type {BoardTextureConfig} from '../types/geometry'

export function veneerLayerHeight(config:BoardTextureConfig):number {
  const goal=config.surfaceMaterialKind==='transparent-petg'?config.surfacePrintGoal:'standard'
  return goal==='clear-experimental'?.1:goal==='frosted'?.2:.28
}

/** Physical colour/carrier depths shared by export and the lightweight section viewer. */
export function textureLayerDepths(config:BoardTextureConfig,total:number,lut:{layerHeight:number;layerCount:number}){
  const opticalThickness=lut.layerHeight*lut.layerCount
  const textureThickness=Math.max(opticalThickness+.08,Math.min(total-.2,config.textureThickness))
  return {textureThickness,structuralThickness:Math.max(.2,total-textureThickness),opticalStart:total-opticalThickness}
}

/** Same height-range resolution used in the 3MF; these are model sections, not toolpaths. */
export function manufacturingHeightRanges(layers:Array<{lo:number;hi:number;height:number}>, finish?:{depth:number;height:number}, firstLayerHeight?:number) {
  layers=layers.filter(p=>Number.isFinite(p.lo)&&Number.isFinite(p.hi)&&p.hi>p.lo&&p.height>0)
  if(!layers.length)return []
  const end=Math.max(...layers.map(p=>p.hi))
  const fine=layers.filter(p=>p.height<.28-1e-6)
  const starts=fine.map(p=>p.lo)
  if(finish&&finish.depth>0&&finish.height>0){
    const lo=Math.max(0,end-finish.depth)
    if(!fine.some(p=>p.lo<=lo+1e-6&&p.hi>lo+1e-6&&p.height<=finish.height))starts.push(lo)
    fine.push({lo,hi:end,height:finish.height})
  }
  const interfaces=[...new Set(starts.filter(z=>z>0))].sort((a,b)=>a-b)
  const resolve=()=>{
    const points=[...new Set([0,end,...fine.flatMap(p=>[Math.max(0,p.lo),p.hi])])].sort((a,b)=>a-b)
    const ranges:Array<{lo:number;hi:number;height:number}>=[]
    for(let i=0;i<points.length-1;i++){
      const lo=points[i],hi=points[i+1],mid=(lo+hi)/2
      const height=Math.min(.28,...fine.filter(p=>p.lo<mid&&p.hi>mid).map(p=>p.height))
      const last=ranges.at(-1)
      if(last&&last.height===height)last.hi=hi
      else ranges.push({lo,hi,height})
    }
    return ranges
  }
  let ranges=resolve()
  // A coarse layer can straddle a material start even with a fine range above it.
  // Land on the actual interface before printing its calibrated optical/veneer/letter layers.
  if(firstLayerHeight!==undefined)for(const start of [...interfaces,end]){
    if(start===end){
      const last=ranges.at(-1)!
      const count=(last.hi-last.lo)/last.height
      // An aligned interface followed by whole finishing layers already lands
      // on the top. Do not add a second guard based on transition sampling.
      if(Math.abs(count-Math.round(count))<1e-5)continue
    }
    let z=firstLayerHeight,currentHeight=firstLayerHeight,previousZ=0,steps=0
    while(z<start-1e-6){
      if(++steps>20000)throw new Error('逐层界面对齐超过安全范围，请核对打印方向与模型高度')
      const mid=z+currentHeight/2
      // Bambu includes the upper boundary of the preceding range when its
      // sampling plane lands exactly there (e.g. the end of a side-letter band).
      const height=ranges.find(range=>range.lo<=mid+1e-6&&range.hi>=mid-1e-6)?.height??.28
      if(z+height>start+1e-6)break
      previousZ=z;z=Number((z+height).toFixed(6));currentHeight=height
    }
    const remaining=start-z
    if(remaining<=1e-6||z>=start)continue
    const lo=remaining>=.08-1e-6?z:previousZ
    const count=start===end?Math.ceil((start-lo)/.2-1e-6):(remaining>=.08-1e-6?1:2)
    const height=Number(((start-lo)/count).toFixed(6))
    if(height<.08-1e-6||height>.28+1e-6)throw new Error('材质界面不能在当前喷嘴层高范围内对齐，请调整板厚或贴面厚度')
    // A 1 mm fine veneer is not an integer number of 0.08 mm layers. Finish
    // its real height with a legal normal top layer instead of losing 0.04 mm.
    if(start===end)for(const band of fine)if(band.hi>=end-1e-6)band.hi=Math.min(band.hi,lo)
    fine.push({lo,hi:start,height})
    ranges=resolve()
  }
  return ranges
}
