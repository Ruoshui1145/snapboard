import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {CadImportDialog} from '../cad/CadImportDialog'
import {openRailPopover} from './openRailPopover'
import {shapeLibraryPresets,parseShapeLibraryUpload,shapeDraftPreview} from '../../features/shapeLibrary/uiBridge'
import {presetToShapeDraft} from '../../features/shapeLibrary/adapters'
import {transformShapeDraft,type ShapeDraft,type ShapeApplicationMode} from '../../features/shapeLibrary/model'
import {getShapePreset,type ShapePresetId} from '../../features/shapeLibrary/presets'
import {useAppStore} from '../../store/useAppStore'
import type {Project} from '../../types/geometry'
import {useFileDrop} from '../../hooks/useFileDrop'

export type BoardDesignMode='presets'|'draw'|'import'
type ImportKind='svg'|'dxf'|'image'
type SourceKey='presets'|'svg'|'image'
type ImportOptions={threshold:number;invert:boolean;outlineInterpretation:'auto'|'silhouette'|'closed-stroke';smoothing:number;simplify:number}
type Candidate={preset:ShapePresetId;width:number;height:number;radius:number;smoothing:number;detail:number;rotation:number;flipX:boolean;flipY:boolean;locked:boolean;file:File|null;imported:ShapeDraft|null;parsedFile:File|null;parsedOptions:string;error:string;busy:boolean;active:boolean;applied:boolean;appliedIds:string[];application:ShapeApplicationMode;options:ImportOptions}
const P0=['rectangle','square','rounded-rectangle','circle','ellipse']
const presetIconCache=new Map<ShapePresetId,{d:string;viewBox:string}>()
const presetIcon=(id:ShapePresetId):{d:string;viewBox:string}=>{
 const cached=presetIconCache.get(id)
 if(cached)return cached
 const params=getShapePreset(id).defaultParams
 const preview=shapeDraftPreview(presetToShapeDraft(id,{width:params.width,height:params.height,cornerRadius:params.cornerRadius,lockAspect:false,flipX:false,flipY:false,smoothing:params.smoothing,detail:params.detail}))
 const icon={d:(preview.paths??[]).map(path=>path.d).join(' '),viewBox:preview.viewBox??'0 0 100 100'}
 presetIconCache.set(id,icon)
 return icon
}
const PresetIcon=({id}:{id:ShapePresetId})=>{
 const icon=presetIcon(id)
 return <svg className="board-preset-icon" viewBox={icon.viewBox} aria-hidden="true" focusable="false"><path d={icon.d} fillRule="evenodd" vectorEffect="non-scaling-stroke"/></svg>
}
const initialCandidate=():Candidate=>({preset:'rectangle',width:320,height:220,radius:12,smoothing:0,detail:.55,rotation:0,flipX:false,flipY:false,locked:false,file:null,imported:null,parsedFile:null,parsedOptions:'',error:'',busy:false,active:false,applied:false,appliedIds:[],application:'replace-outer',options:{threshold:220,invert:false,outlineInterpretation:'auto',smoothing:10,simplify:5}})
const contourIds=(project:Project)=>new Set(project.parts.flatMap(part=>part.features).flatMap(feature=>feature.type==='sketch'?feature.contours.map(contour=>contour.id):[]))

export function BoardDesignPanel({mode,onModeChange,onPreview,onApply,recentIds=[]}: {
 recentIds?:string[];
 mode:BoardDesignMode;onModeChange(mode:BoardDesignMode):void;onPreview(node:ReactNode):void;
 onApply(draft:ShapeDraft,mode:ShapeApplicationMode):Promise<void>;
}) {
 const [sources,setSources]=useState<Record<SourceKey,Candidate>>(()=>({presets:initialCandidate(),svg:initialCandidate(),image:initialCandidate()}))
 const [kind,setKind]=useState<ImportKind>('svg'),[cadPreview,setCadPreview]=useState<ReactNode>(null)
 const [applying,setApplying]=useState(false)
 const foldRef=useRef<HTMLDivElement|null>(null),precisionRef=useRef<HTMLDivElement|null>(null)
 const [numDraft,setNumDraft]=useState<{field:string;value:string}|null>(null)
 const setUI=useAppStore(s=>s.setUI)
 const project=useAppStore(s=>s.project)
 const hasDerived=useAppStore(s=>Boolean(s.splitResult?.panels.length||s.placedParts.length||s.assemblyScene.placements.length||s.boardTexture.enabled))
 const isPreset=mode==='presets',isDxf=mode==='import'&&kind==='dxf'
 const sourceKey:SourceKey=isPreset?'presets':kind==='image'?'image':'svg'
 const state=sources[sourceKey]
 const {preset,width,height,radius,smoothing,detail,rotation,flipX,flipY,locked,file,imported,error,busy,application,options}=state
 const currentContourIds=contourIds(project)
 const contours=project.parts.flatMap(part=>part.features).flatMap(feature=>feature.type==='sketch'?feature.contours:[])
 const existingOuterCount=contours.filter(contour=>contour.type==='outer'&&!contour.construction).length
 const applied=state.applied&&state.appliedIds.length>0&&state.appliedIds.every(id=>currentContourIds.has(id))
 const active=state.active||state.applied&&!applied
 const update=(patch:Partial<Candidate>)=>setSources(current=>({...current,[sourceKey]:{...current[sourceKey],...patch}}))
 const chooseFile=(f?:File)=>{
  if(!f)return
  const nextKind:SourceKey|null=/\.svg$/i.test(f.name)?'svg':/\.(png|jpe?g)$/i.test(f.name)?'image':null
  if(!nextKind){update({file:null,imported:null,parsedFile:null,active:false,applied:false,error:'请使用 SVG、PNG 或 JPG 文件'});return}
  if(f.size>20*1024*1024){update({file:null,imported:null,parsedFile:null,active:false,applied:false,error:'文件超过20MB，请缩小后导入'});return}
  setKind(nextKind)
  setSources(current=>({...current,[nextKind]:{...current[nextKind],file:f,imported:null,parsedFile:null,active:false,applied:false,error:''}}))
 }
 const fileDrop=useFileDrop(files=>{if(files.length!==1){update({error:'板型导入一次只接收一张图像'});return}chooseFile(files[0])},applying,{accept:'.svg,.png,.jpg,.jpeg',onError:error=>update({error})})
 const equalSides=isPreset&&(preset==='square'||preset==='circle')
 const choosePreset=(id:ShapePresetId)=>{const p=getShapePreset(id);update({preset:id,width:p.defaultParams.width,height:p.defaultParams.height,radius:p.defaultParams.cornerRadius??12,smoothing:p.defaultParams.smoothing,detail:p.defaultParams.detail,rotation:0,flipX:false,flipY:false,active:true,applied:false,error:''})}
 const chooseFromFold=(id:ShapePresetId)=>{choosePreset(id);foldRef.current?.hidePopover()}
 const dimension=(axis:'width'|'height',value:number)=>{
  if(!Number.isFinite(value)||value<=0)return
  if(equalSides)update({width:value,height:value,active:true,applied:false})
  else if(axis==='width')update({width:value,height:locked?value*height/width:height,active:true,applied:false})
  else update({height:value,width:locked?value*width/height:width,active:true,applied:false})
 }
 const optionsKey=JSON.stringify(options)
 useEffect(()=>{
  if(mode!=='import'||isDxf||!file||state.parsedFile===file&&state.parsedOptions===optionsKey)return
  const controller=new AbortController()
  setSources(current=>({...current,[sourceKey]:{...current[sourceKey],busy:true,error:'',imported:null,active:false}}))
  const timer=setTimeout(()=>{void Promise.resolve(parseShapeLibraryUpload({file,options},controller.signal)).then(result=>{
   if(controller.signal.aborted)return
   setSources(current=>({...current,[sourceKey]:{...current[sourceKey],imported:result.geometry,parsedFile:file,parsedOptions:optionsKey,active:true,busy:false}}))
  }).catch(e=>{if(!controller.signal.aborted)setSources(current=>({...current,[sourceKey]:{...current[sourceKey],error:String(e),imported:null,active:false,busy:false}}))})},150)
  return()=>{clearTimeout(timer);controller.abort()}
 },[file,options,optionsKey,mode,isDxf,sourceKey,state.parsedFile,state.parsedOptions])
 const draft=useMemo(()=>{
  if(!active||mode==='draw'||isDxf)return null
  const source=isPreset?presetToShapeDraft(preset,{width,height:equalSides?width:height,cornerRadius:radius,lockAspect:false,smoothing,detail}):imported
  if(!source||source.errors.length)return source
  return transformShapeDraft(source,{width,height:equalSides?width:height,preserveAspect:false,rotationDegrees:rotation,flipX,flipY})
 },[active,mode,isDxf,isPreset,preset,width,height,radius,equalSides,rotation,flipX,flipY,imported,smoothing,detail])
 const artwork=useMemo(()=>{
  if(!draft||draft.errors.length)return null
  const p=shapeDraftPreview(draft)
  return <svg viewBox={p.viewBox} role="img" aria-label="候选板型预览"><path d={p.paths?.map(p=>p.d).join(' ')} fill="#70d8c322" stroke="#7cdccd" strokeWidth="2" strokeDasharray="7 4" fillRule="evenodd" vectorEffect="non-scaling-stroke"/></svg>
 },[draft])
 useEffect(()=>{onPreview(mode==='draw'?null:isDxf?cadPreview:artwork)},[mode,isDxf,cadPreview,artwork,onPreview])
 useEffect(()=>()=>onPreview(null),[onPreview])
 const clearCandidate=()=>update({file:null,imported:null,parsedFile:null,active:false,applied:false,appliedIds:[],error:'',busy:false})
 const apply=async()=>{if(!canApply||!draft)return;const before=contourIds(useAppStore.getState().project);setApplying(true);try{await onApply(draft,application);const created=[...contourIds(useAppStore.getState().project)].filter(id=>!before.has(id));update({active:false,applied:true,appliedIds:created,error:''})}catch(e){update({error:e instanceof Error?e.message:String(e)})}finally{setApplying(false)}}
 const showDimensions=isPreset?(active||applied):Boolean(imported?.contours.length&&!imported.errors.length)
 const candidatePresented=active||applied
 const selectedPreset=candidatePresented?shapeLibraryPresets.find(p=>p.id===preset):undefined
 const presetChip=(p:{id:string;name:string})=><button key={p.id} aria-pressed={candidatePresented&&preset===p.id} onClick={()=>chooseFromFold(p.id as ShapePresetId)}><PresetIcon id={p.id as ShapePresetId}/><span>{p.name}</span></button>
 const needsOuter=application==='insert-inner'&&existingOuterCount===0
 const canApply=Boolean(draft&&!draft.errors.length&&!busy&&!applying&&!needsOuter)
 const missingCandidate=isPreset?'请先选择一个板型':kind==='image'?'请先选择 PNG/JPG 图片':'请先选择 SVG 文件'
 const impact=application==='replace-outer'
  ? contours.length?`将替换 ${contours.length} 个草图轮廓${hasDerived?'，并清理旧板相关的分割、配件与纹理':''}；可撤销。`:'将创建外轮廓。'
  : needsOuter?'请先创建闭合外轮廓，再添加内孔。':'将在现有外轮廓中添加内孔，原轮廓保留。'
 const dimDisabled=isPreset?!candidatePresented:!file
 const digitsOnly=(s:string)=>s.replace(/\D/g,'').replace(/^0+(?=\d)/,'')
 const numValue=(field:string,current:number)=>numDraft&&numDraft.field===field?numDraft.value:String(current)
 const numFocus=(field:string,current:number)=>(e:{currentTarget:HTMLInputElement})=>{setNumDraft({field,value:String(current)});e.currentTarget.select()}
 const numBlur=()=>setNumDraft(null)
 const unsignedChange=(field:string,apply:(n:number)=>void)=>(e:{currentTarget:HTMLInputElement})=>{
  const raw=digitsOnly(e.currentTarget.value)
  if(raw===''){setNumDraft({field,value:numDraft&&numDraft.field===field&&numDraft.value==='0'?'':'0'});return}
  setNumDraft({field,value:raw})
  apply(Number(raw))
 }
 const rotationChange=(e:{currentTarget:HTMLInputElement})=>{
  const src=e.currentTarget.value
  const raw=(src.indexOf('-')>-1?'-':'')+digitsOnly(src)
  setNumDraft({field:'rotation',value:raw})
  if(raw!==''&&raw!=='-'){const n=Number(raw);if(Number.isFinite(n))update({rotation:Math.max(-180,Math.min(180,n)),active:true,applied:false})}
 }
 const rotationField=<label>旋转角度<input type="text" inputMode="numeric" value={numValue('rotation',rotation)} disabled={dimDisabled} onFocus={numFocus('rotation',rotation)} onChange={rotationChange} onBlur={numBlur}/></label>
 const paramsBlock=mode!=='draw'&&!isDxf&&(isPreset||showDimensions)?<div className={'board-shape-fields'+(active?' is-active':'')}>
  <h3>轮廓尺寸 <small>mm</small></h3>
  <div className="board-shape-grid">
   <div className="board-shape-row">
    <label className={equalSides?'board-shape-span':''}>{equalSides?(preset==='circle'?'直径':'边长'):'宽度'}<input type="text" inputMode="numeric" value={numValue('width',width)} disabled={dimDisabled} onFocus={numFocus('width',width)} onChange={unsignedChange('width',n=>{if(n>0)dimension('width',n)})} onBlur={numBlur}/></label>
    {!equalSides&&<label>高度<input type="text" inputMode="numeric" value={numValue('height',height)} disabled={dimDisabled} onFocus={numFocus('height',height)} onChange={unsignedChange('height',n=>{if(n>0)dimension('height',n)})} onBlur={numBlur}/></label>}
   </div>
   <div className="board-shape-row">
    {!equalSides&&<label><input type="checkbox" checked={locked} disabled={dimDisabled} onChange={e=>update({locked:e.target.checked})}/>等比缩放</label>}
    {rotationField}
   </div>
   {isPreset&&(preset==='rounded-rectangle'||!P0.includes(preset))&&<div className="board-shape-row">
    {isPreset&&preset==='rounded-rectangle'&&<label className="board-shape-span">圆角半径<input type="text" inputMode="numeric" value={numValue('radius',Math.min(radius,width/2,height/2))} disabled={!candidatePresented} onFocus={numFocus('radius',Math.min(radius,width/2,height/2))} onChange={unsignedChange('radius',n=>update({radius:n,active:true,applied:false}))} onBlur={numBlur}/></label>}
    {isPreset&&!P0.includes(preset)&&<details className="board-style-fold board-shape-span"><summary>轮廓风格</summary>{getShapePreset(preset).capabilities.smoothing&&<label>圆润程度<input type="range" min="0" max="1" step=".01" value={smoothing} onChange={e=>update({smoothing:+e.target.value,active:true,applied:false})}/></label>}{getShapePreset(preset).capabilities.detail&&<label>轮廓细节<input type="range" min="0" max="1" step=".01" value={detail} onChange={e=>update({detail:+e.target.value,active:true,applied:false})}/></label>}</details>}
   </div>}
   <div className="board-shape-row">
    <div className="board-flips"><button aria-pressed={flipX} disabled={dimDisabled} onClick={()=>update({flipX:!flipX,active:true,applied:false})}>水平翻转</button><button aria-pressed={flipY} disabled={dimDisabled} onClick={()=>update({flipY:!flipY,active:true,applied:false})}>垂直翻转</button></div>
   </div>
  </div>
  {isPreset&&!candidatePresented&&<small>选择板型后可调整尺寸。</small>}
 </div>:null
 return <section className="board-design-panel" aria-label="板型设计">
  <nav className="board-design-tabs" aria-label="板型设计方式">{([['presets','板型库'],['draw','自由绘图'],['import','导入']] as const).map(([id,label])=><button key={id} aria-pressed={mode===id} onClick={()=>{setUI({activeTool:'select'});onModeChange(id)}}>{label}</button>)}</nav>
  <div className="board-source-scroll">
  {isPreset&&<div className="board-preset-fold">
   <button type="button" className={'board-preset-trigger'+(selectedPreset?' has-selection':'')} aria-haspopup="dialog" onClick={e=>openRailPopover(e.currentTarget,foldRef.current)}>{selectedPreset?<><PresetIcon id={selectedPreset.id as ShapePresetId}/><span>{selectedPreset.name}</span></>:<span>选择板型</span>}</button>
   <div ref={foldRef} popover="auto" className="board-option-popover board-preset-popover" role="dialog" aria-label="选择板型">
    <strong>选择板型</strong>
    <div className="board-preset-wheel">
    <small className="board-wheel-caption">普通版型</small>
    <div className="board-preset-grid board-preset-grid-large">{shapeLibraryPresets.map(presetChip)}</div>
    </div>
   </div>
  </div>}
  {isPreset&&recentIds.length>0&&<div className="board-recent-strip">
   <small className="board-recent-caption">最近使用</small>
   <div className="board-recent-chips">{recentIds.map(id=>shapeLibraryPresets.find(p=>p.id===id)).filter(p=>p!==undefined).map(presetChip)}</div>
  </div>}
  {mode==='draw'&&<div className="board-drawing-tools"><h3>绘图工具</h3><div id="board-drawing-tools"/></div>}
  {isPreset&&paramsBlock}
  {mode==='import'&&<div className="board-import-kind"><strong>导入格式</strong><nav className="board-import-tabs" aria-label="轮廓文件类型">{([['svg','SVG'],['dxf','DXF'],['image','图片提取']] as const).map(([id,label])=><button key={id} aria-pressed={kind===id} onClick={()=>setKind(id)}>{label}</button>)}</nav><p className="board-method-note">{kind==='svg'?'SVG 路径解析 · 矢量轮廓':kind==='dxf'?'DXF CAD 几何解析 · 按文件单位': 'PNG/JPG 像素阈值分割 · 位图描边'}</p></div>}
  <div className="board-cad-host" hidden={!isDxf}><CadImportDialog embedded active={isDxf} onPreview={setCadPreview} onClose={()=>{}} onApplied={()=>setCadPreview(null)}/></div>
  {mode==='import'&&!isDxf&&<div className="board-import-fields">
   <div className="board-file-card" {...fileDrop.dropProps}><label><span className="file-drop-prompt"><span className="file-drop-plus" aria-hidden="true">＋</span><span>{file?'更换文件':kind==='svg'?'点击或拖入 SVG':'点击或拖入图片'}</span></span><input key={kind} type="file" disabled={applying} accept={kind==='svg'?'.svg,image/svg+xml':'.png,.jpg,.jpeg,image/png,image/jpeg'} onChange={e=>{chooseFile(e.target.files?.[0]);e.target.value=''}}/></label><small>支持 SVG / PNG / JPG，自动识别格式。</small><small title={file?.name} data-i18n-ignore={!!file}>{file?.name??'最大 20 MB'}</small>{error&&<small className="board-file-error">{error}</small>}</div>
   {kind==='svg'?<p>提取矢量轮廓；下方尺寸为目标毫米尺寸。</p>:<>
    <label>明暗阈值<input type="range" min="0" max="255" value={options.threshold} onChange={e=>update({options:{...options,threshold:+e.target.value},applied:false})}/><output>{options.threshold}</output></label>
    <label><input type="checkbox" checked={options.invert} onChange={e=>update({options:{...options,invert:e.target.checked},applied:false})}/>反相轮廓</label>
    <label>轮廓解释<select value={options.outlineInterpretation} onChange={e=>update({options:{...options,outlineInterpretation:e.target.value as ImportOptions['outlineInterpretation']},applied:false})}><option value="auto">智能</option><option value="silhouette">实心剪影</option><option value="closed-stroke">闭合线稿</option></select></label>
   </>}
   <button type="button" className="board-flyout-trigger" aria-haspopup="dialog" onClick={e=>openRailPopover(e.currentTarget,precisionRef.current)}>轮廓精度 · 展开</button>
   <div ref={precisionRef} popover="auto" className="board-option-popover board-precision-popover" role="dialog" aria-label="轮廓精度"><strong>轮廓精度</strong><label>轮廓简化<input type="range" min="0" max="100" value={options.simplify} onChange={e=>update({options:{...options,simplify:+e.target.value},applied:false})}/><output>{options.simplify}%</output></label>{kind==='image'&&<label>边缘平滑<input type="range" min="0" max="100" value={options.smoothing} onChange={e=>update({options:{...options,smoothing:+e.target.value},applied:false})}/><output>{options.smoothing}%</output></label>}</div>
   <button type="button" onClick={clearCandidate} disabled={!file&&!active&&!error}>清除候选</button>
  </div>}
  {mode==='import'&&!isDxf&&imported&&<small>识别 {imported.contours.length} 个轮廓 · 原始边界 {imported.stats.width.toFixed(1)} × {imported.stats.height.toFixed(1)}</small>}
  {!isPreset&&paramsBlock}
  </div>
  {mode!=='draw'&&!isDxf&&<footer className="board-completion" aria-label="完成轮廓">
   <label>添加方式<select value={application} onChange={e=>update({application:e.target.value as ShapeApplicationMode})}><option value="replace-outer">替换外轮廓</option><option value="insert-inner">作为内孔</option></select></label>
   <p className="board-impact" role={applied?'status':undefined}>{applied?'已添加到当前草图；可在右侧生成板件。':draft?impact:missingCandidate}</p>
   <div className="board-completion-feedback">
    {busy&&<small role="status">正在解析轮廓…</small>}{error&&<small role="alert">{error}</small>}
    {draft?.errors.map((message,index)=><small role="alert" key={index}>{message}</small>)}
    {draft?.warnings.map((message,index)=><small key={index}>{message}</small>)}
    {state.applied&&!applied&&<small role="status">已应用轮廓已撤销；候选保留，可重新应用。</small>}
   </div>
   <div className="board-completion-actions">
    {!applied&&<button className="board-primary-action" disabled={!canApply} onClick={()=>void apply()}>{applying?'正在应用…':'应用到草图'}</button>}
    <button type="button" title="返回绘图会保留候选，不会应用本次修改。" onClick={()=>onModeChange('draw')}>{applied?'继续绘图':'返回绘图'}</button>
    {isPreset&&<button type="button" onClick={clearCandidate} disabled={!active&&!applied}>清除候选</button>}
   </div>
  </footer>}
 </section>
}
