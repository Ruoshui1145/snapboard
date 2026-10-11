import {useEffect,useId,useMemo,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {useAppStore} from '../../store/useAppStore'
import {createLayerPreviewPlate,prepareLayerPreviewSources,renderLayerPreviewTile,layerPreviewPixels,
  type LayerPreviewSources,type LayerPreviewTile,type LayerPreviewPlate,type LayerPreviewSection} from '../../utils/manufacturingLayerPreview'
import './layer-preview.css'

const mm=(v:number)=>Number(v.toFixed(3)).toString()

export function LayerPreviewPanel(){
  const panels=useAppStore(s=>s.splitResult?.panels),cfg=useAppStore(s=>s.splitConfig)
  const texture=useAppStore(s=>s.boardTexture),marking=useAppStore(s=>s.assemblyMarking)
  const projectName=useAppStore(s=>s.project.metadata.name),spatial=useAppStore(s=>s.spatialLayout.enabled)
  const pending=useAppStore(s=>s.splitJob),resultCfg=useAppStore(s=>s.splitResult?.config)
  const [requested,setRequested]=useState(false),[sources,setSources]=useState<LayerPreviewSources|null>(null)
  const [reload,setReload]=useState(0)
  const [selectedId,setSelectedId]=useState(''),[index,setIndex]=useState(0)
  const [previewMode,setPreviewMode]=useState<'composite'|'layers'|'single'>('composite'),[opticalIndex,setOpticalIndex]=useState(0)
  const [tileResult,setTileResult]=useState<{plate:LayerPreviewPlate;key:string;data:LayerPreviewTile}|null>(null)
  const [galleryResult,setGalleryResult]=useState<{plate:LayerPreviewPlate;index:number;tiles:LayerPreviewTile[]}|null>(null)
  const galleryCache=useRef<typeof galleryResult>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[highlight,setHighlight]=useState<number|null>(null)
  const [expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,y:0})
  const largeCanvas=useRef<HTMLCanvasElement>(null),dialog=useRef<HTMLDialogElement>(null)
  const layerList=useRef<HTMLDivElement>(null)
  const drag=useRef<{x:number;y:number;px:number;py:number}|null>(null)
  const tiles=useRef(new Map<string,LayerPreviewTile>())
  const outdated=!!panels?.length&&JSON.stringify(resultCfg)!==JSON.stringify(cfg)
  const panel=panels?.find(p=>p.id===selectedId)??panels?.[0]
  const plan=useMemo(()=>{
    if(!panel||spatial||outdated||pending)return null
    try{return {plate:createLayerPreviewPlate(panel,cfg,texture,sources??undefined),error:''}}
    catch(e){return {plate:null,error:e instanceof Error?e.message:String(e)}}
  },[panel,cfg,texture,sources,spatial,outdated,pending])
  const plate=plan?.plate,section=plate?.sections[Math.min(index,plate.sections.length-1)]
  const optical=section?.kind==='optical',isGallery=optical&&previewMode==='layers',isSingle=optical&&previewMode==='single'
  const renderKey=`${index}:${isSingle?opticalIndex:'composite'}`
  // Bind each bitmap to its exact plate and layer. Effects run after render;
  // a material-mode change must never paint yesterday's IDs with today's palette.
  const tile=!isGallery&&tileResult?.plate===plate&&tileResult?.key===renderKey?tileResult.data:null
  const gallery=galleryResult?.plate===plate&&galleryResult?.index===index?galleryResult.tiles:[]

  useEffect(()=>{
    setSources(null);setTileResult(null);setError('');setBusy(false)
    if(!requested||!panels?.length||spatial||outdated||pending)return
    const abort=new AbortController();setBusy(true)
    void prepareLayerPreviewSources(panels,cfg,texture,marking,projectName,abort.signal).then(data=>{
      if(!abort.signal.aborted){setSources(data);setBusy(false)}
    }).catch(e=>{if(!abort.signal.aborted){setError(e instanceof Error?e.message:String(e));setBusy(false)}})
    return ()=>abort.abort()
  },[requested,reload,panels,cfg,texture,marking,projectName,spatial,outdated,pending])
  useEffect(()=>{tiles.current.clear();galleryCache.current=null;setGalleryResult(null);setIndex(i=>Math.min(i,(plate?.sections.length??1)-1));setHighlight(null);setZoom(1);setPan({x:0,y:0});setTileResult(null)},[plate])
  useEffect(()=>{
    if(!expanded||!plate||!plate.sections[index]||isGallery||optical&&!sources)return
    const cached=tiles.current.get(renderKey)
    if(cached){setTileResult({plate,key:renderKey,data:cached});setBusy(false);return}
    const abort=new AbortController();setTileResult(null);setBusy(true);setError('')
    void renderLayerPreviewTile(plate,index,abort.signal,{opticalLayerFromFace:isSingle?opticalIndex:undefined}).then(data=>{
      if(abort.signal.aborted)return
      tiles.current.set(renderKey,data)
      while(tiles.current.size>3)tiles.current.delete(tiles.current.keys().next().value!)
      setTileResult({plate,key:renderKey,data});setBusy(false)
    }).catch(e=>{if(!abort.signal.aborted){setError(e instanceof Error?e.message:String(e));setBusy(false)}})
    return ()=>abort.abort()
  },[plate,index,expanded,sources,isGallery,optical,isSingle,opticalIndex,renderKey])
  useEffect(()=>{
    if(!expanded||!isGallery||!plate||!sources)return
    const cached=galleryCache.current
    if(cached?.plate===plate&&cached.index===index){setGalleryResult(cached);setBusy(false);return}
    const abort=new AbortController(),generated:LayerPreviewTile[]=[]
    setGalleryResult({plate,index,tiles:[]});setBusy(true);setError('')
    void (async()=>{
      for(let layer=0;layer<(section?.opticalLayerCount??0);layer++){
        const data=await renderLayerPreviewTile(plate,index,abort.signal,{opticalLayerFromFace:layer,maxEdge:256})
        if(abort.signal.aborted)return
        generated.push(data);setGalleryResult({plate,index,tiles:[...generated]})
      }
      if(!abort.signal.aborted){galleryCache.current={plate,index,tiles:generated};setBusy(false)}
    })().catch(e=>{if(!abort.signal.aborted){setError(e instanceof Error?e.message:String(e));setBusy(false)}})
    return ()=>abort.abort()
  },[expanded,isGallery,plate,sources,index,section?.opticalLayerCount])
  useEffect(()=>{
    if(!tile||!plate)return
    const image=new ImageData(new Uint8ClampedArray(layerPreviewPixels(tile,plate.materials,highlight)),tile.width,tile.height)
    const canvas=largeCanvas.current
    if(canvas){canvas.width=tile.width;canvas.height=tile.height;canvas.getContext('2d')!.putImageData(image,0,0)}
  },[tile,plate,highlight,expanded,previewMode])
  useEffect(()=>{
    if(expanded&&!dialog.current?.open)dialog.current?.showModal()
    if(!expanded&&dialog.current?.open)dialog.current.close()
  },[expanded])
  useEffect(()=>{if(expanded)layerList.current?.querySelector('[aria-pressed=true]')?.scrollIntoView({block:'nearest'})},[expanded,index])

  const total=tile?.counts.reduce((a,b)=>a+b,0)??0
  const selectLayer=(next:number)=>{
    const selected=Math.max(0,Math.min((plate?.sections.length??1)-1,next));setIndex(selected)
    setOpticalIndex(0);setHighlight(null)
    if(expanded&&plate?.sections[selected]?.kind==='optical'){setRequested(true);setPreviewMode('layers')}
    else setPreviewMode('composite')
  }
  const showOpticalLayer=(layer:number)=>{setOpticalIndex(layer);setPreviewMode('single');setHighlight(null);setZoom(1);setPan({x:0,y:0})}
  const filters=(full=false)=><div className="layer-materials" aria-label="层内区域">
    <button type="button" aria-pressed={highlight===null} onClick={()=>setHighlight(null)}>全部区域</button>
    {(tile?.materials??plate?.materials)?.map((m,i)=>((tile?.counts[i]??0)>0||highlight===i)&&<button type="button" key={i} aria-pressed={highlight===i} onClick={()=>setHighlight(highlight===i?null:i)} title={`突出显示${m.name}`}><i style={{background:m.color}}/><span>{m.name}</span><small>{total?Math.round(tile!.counts[i]/total*100):0}%</small></button>)}
    {full&&<small>点选区域以突出显示。</small>}
  </div>
  const selector=<label className="layer-board-select">板件<select aria-label="分层预览板件" value={panel?.id??''} onChange={e=>{setSelectedId(e.target.value);setIndex(0)}}>{panels?.map((p,i)=><option key={p.id} value={p.id}>{`P${String(i+1).padStart(2,'0')} · ${mm(p.w)} × ${mm(p.h)} mm`}</option>)}</select></label>
  const transport=<div className="layer-transport">
    <button type="button" aria-label={isSingle?'上一光学层':'上一层'} disabled={!plate||(isSingle?opticalIndex===0:index===0)} onClick={()=>isSingle?showOpticalLayer(opticalIndex-1):selectLayer(index-1)}>‹</button>
    <span>{isSingle?`${opticalIndex+1} / ${section?.opticalLayerCount??0} 个光学层`:`${index+1} / ${plate?.sections.length??0} 个材料层`}</span>
    <button type="button" aria-label={isSingle?'下一光学层':'下一层'} disabled={!plate||(isSingle?opticalIndex>=(section?.opticalLayerCount??1)-1:index>=plate.sections.length-1)} onClick={()=>isSingle?showOpticalLayer(opticalIndex+1):selectLayer(index+1)}>›</button>
  </div>
  const info=<div className="layer-current"><strong>{isSingle?`${section?.name} · 光学第 ${opticalIndex+1} 层`:section?.name??'材料结构'}</strong><span>{mm(isSingle?section?.opticalLayerHeight??0:(section?.hi??0)-(section?.lo??0))} mm</span><small>{isSingle?'观看面 → 承托层 · 显示本层耗材本色':section?.note}</small></div>
  const hint=spatial?'当前是立体版面。此预览用于平面板件；立体制造请在 3MF 中检查。':outdated?'分板参数已改变，请先更新板件再查看材料层。':pending?'正在更新板件，完成后可查看材料层。':!panels?.length?'先在板材设计中生成板件，即可检查叠色、承托和基材的每层分布。':'选板件、逐层检查颜色与孔洞，再导出制造文件。'
  const problem=error||plan?.error
  const openDetail=(mode:'composite'|'layers'='composite')=>{if(optical)setRequested(true);setPreviewMode(mode);setHighlight(null);setExpanded(true);if(problem)setReload(n=>n+1)}
  return <section className="layer-preview-panel" aria-label="材料层结构预览">
    <header><div><span className="layer-preview-icon" aria-hidden="true">▱</span><strong>材料层结构</strong></div><small>{cfg.thickness} mm</small></header>
    {!plate?<div className="layer-preview-empty"><b>从贴面到基层，看清结构</b><p>{hint}</p></div>:<>
      {selector}
      <LayerStackDiagram layers={plate.sections} selected={index} onSelect={selectLayer}/>
      {info}
      {optical?<div className="layer-optical-actions"><button type="button" onClick={()=>openDetail('composite')}>合成图案 ↗</button><button type="button" className="layer-detail-action" onClick={()=>openDetail('layers')}>逐层预览 · {section?.opticalLayerCount} 层 ↗</button></div>:<button type="button" className="layer-detail-action" onClick={()=>openDetail()}>查看这一层的平面图 ↗</button>}
    </>}
    {problem&&<p className="layer-preview-error" role="alert">{problem}</p>}
    <footer>从正面向背面排列；重复层已合并。示意间距不代表实际厚度。</footer>
    {expanded&&createPortal(<dialog ref={dialog} className="layer-preview-dialog" aria-label="材料层平面预览" onCancel={()=>setExpanded(false)} onClose={()=>setExpanded(false)}>
      <header><div><strong>材料层结构与平面图</strong><small>从正面向背面 · 相同结构合并展示 · 只查看，不修改工程</small></div><button type="button" aria-label="关闭平面预览" onClick={()=>setExpanded(false)}>✕</button></header>
      {problem&&<p className="layer-preview-error" role="alert">{problem}</p>}
      <div className="layer-dialog-body"><aside>{selector}{plate&&<LayerStackDiagram layers={plate.sections} selected={index} onSelect={selectLayer}/>}<div ref={layerList} className="layer-section-list" aria-label="材料层列表">{plate?.sections.map((s,i)=><button type="button" key={i} aria-pressed={i===index} onClick={()=>selectLayer(i)}><span>{String(i+1).padStart(2,'0')}</span><div><strong>{s.name}</strong><small>厚 {mm(s.hi-s.lo)} mm</small></div></button>)}</div></aside>
        <main>{optical&&<div className="layer-optical-tabs" role="tablist" aria-label="叠色查看方式"><button type="button" role="tab" aria-selected={previewMode==='composite'} onClick={()=>{setPreviewMode('composite');setHighlight(null)}}>合成图案</button><button type="button" role="tab" aria-selected={previewMode!=='composite'} onClick={()=>{setPreviewMode('layers');setHighlight(null)}}>逐层配方 · {section?.opticalLayerCount} 层</button></div>}
          <div className="layer-detail-toolbar"><span>{isSingle?`光学第 ${opticalIndex+1} 层`:section?.name}</span>{isGallery?<small>观看面 → 承托层 · 点击小图放大</small>:<div>{isSingle&&<button type="button" onClick={()=>setPreviewMode('layers')}>返回分层小图</button>}<button type="button" aria-label="缩小预览" onClick={()=>setZoom(z=>Math.max(1,z/1.5))}>−</button><button type="button" onClick={()=>{setZoom(1);setPan({x:0,y:0})}}>适合窗口</button><button type="button" aria-label="放大预览" onClick={()=>setZoom(z=>Math.min(8,z*1.5))}>＋</button></div>}</div>
          {isGallery?<div className="optical-layer-gallery" aria-label="叠色光学层小图">{Array.from({length:section?.opticalLayerCount??0},(_,layer)=>{
            const data=gallery[layer],palette=data?.materials??plate?.materials??[]
            return <button type="button" className="optical-layer-card" key={layer} aria-label={`放大光学第 ${layer+1} 层`} disabled={!data} onClick={()=>showOpticalLayer(layer)}><header><strong>第 {layer+1} 层</strong><small>{mm(section?.opticalLayerHeight??0)} mm</small></header><div className="optical-layer-image">{data?<OpticalLayerThumbnail tile={data} materials={palette} label={`光学第 ${layer+1} 层耗材分布`}/>:<span>正在准备…</span>}</div><div className="optical-layer-swatches">{data?palette.map((m,i)=>data.counts[i]>0&&<span key={i}><i style={{background:m.color}}/>{m.name}</span>):<span>共用同一份叠色配方</span>}</div></button>
          })}</div>:<div className="layer-detail-stage" onPointerDown={e=>{if(zoom<=1)return;e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y}}} onPointerMove={e=>{if(drag.current)setPan({x:drag.current.px+e.clientX-drag.current.x,y:drag.current.py+e.clientY-drag.current.y})}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}><canvas ref={largeCanvas} style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}} aria-label="放大的材料层分布"/>{(!tile||busy)&&<span role="status">正在读取此层…</span>}</div>}
          {isGallery?<small className="optical-layer-note">每层可包含多种耗材；小图显示实际分布，不计算打印走线。已准备 {gallery.length}/{section?.opticalLayerCount} 层。</small>:<>{info}{transport}{filters(true)}</>}
        </main></div>
      <footer>结构保持材料分组；叠色可展开实际光学层。基层高低筋和重复打印层仍合并展示，预览不修改工程。</footer>
    </dialog>,document.body)}
  </section>
}

function OpticalLayerThumbnail({tile,materials,label}:{tile:LayerPreviewTile;materials:LayerPreviewPlate['materials'];label:string}){
  const canvas=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{if(canvas.current){canvas.current.width=tile.width;canvas.current.height=tile.height;canvas.current.getContext('2d')!.putImageData(new ImageData(layerPreviewPixels(tile,materials),tile.width,tile.height),0,0)}},[tile,materials])
  return <canvas ref={canvas} aria-label={label}/>
}

function LayerStackDiagram({layers,selected,onSelect}:{layers:LayerPreviewSection[];selected:number;onSelect:(index:number)=>void}){
  const id=useId().replace(/:/g,'')
  return <svg className="layer-stack-diagram" viewBox={`0 0 340 ${layers.length*48+22}`} aria-label="材料层结构示意图">
    <defs>{layers.map((s,i)=><linearGradient key={i} id={`${id}-${i}`}>{s.colors.map((color,n)=><stop key={n} offset={`${s.colors.length===1?0:n/(s.colors.length-1)*100}%`} stopColor={color}/>)}</linearGradient>)}</defs>
    {[...layers.keys()].reverse().map(i=>{const s=layers[i],y=10+i*48,active=i===selected;return <g key={i} role="button" tabIndex={0} aria-label={`${s.name}，厚 ${mm(s.hi-s.lo)} mm`} aria-pressed={active} onClick={()=>onSelect(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(i)}}}>
      <polygon points={`18,${y+22} 148,${y+40} 148,${y+49} 18,${y+31}`} fill="#405a68"/>
      <polygon points={`148,${y+40} 208,${y+18} 208,${y+27} 148,${y+49}`} fill="#2f4753"/>
      <polygon points={`18,${y+22} 78,${y} 208,${y+18} 148,${y+40}`} fill={`url(#${id}-${i})`} stroke={active?'#8df4da':'#7c929c'} strokeWidth={active?2:1}/>
      <path d={`M204 ${y+26}H216`} stroke={active?'#8df4da':'#718893'}/>
      <text x="222" y={y+22} fill={active?'#b9f9e6':'#dde6ec'} fontSize="13" fontWeight="600">{s.name}</text>
      <text x="222" y={y+39} fill="#9eafbc" fontSize="12">{mm(s.hi-s.lo)} mm</text>
    </g>})}
  </svg>
}
