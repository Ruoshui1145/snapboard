import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { prepareSplitGeometry, useAppStore } from '../../store/useAppStore'
import { CompositeCommand } from '../../commands/Command'
import { RemoveContourCommand } from '../../commands/SketchCommands'
import { DEFAULT_FLOWER_SVG, DEFAULT_SVG_LATTICE_OPTIONS, DEFAULT_SVG_LATTICE_PLACEMENT, recognizeSvgLattice, svgLatticeTransform } from '../../utils/svgLattice'
import { prepareTextureSvg } from '../../utils/textureSvg'
import { boardTextureForSide, editableTextureComposition, hasBoardTextureSource } from '../../utils/boardTexture'
import { createDefaultTextureCrop, textureCompositionSignature, type TextureCompositionImageLayer } from '../../utils/textureComposition'
import { decodeWorkshopSvg, sharedSvgStructureOnly, workshopSvgArtwork } from '../../utils/workshopSvgLattice'
import { workspaceSelection } from '../../utils/workbenchNavigation'
import type { BoardTextureConfig, Point2D, SplitConfig, SplitPanel, SplitResultState, SvgLatticeOptions } from '../../types/geometry'
import type { OpenLatticeResult } from '../../utils/openLattice'
import type { OpenLatticeRequest, OpenLatticeResponse } from '../../workers/openLattice.worker'
import './OpenLatticePanel.css'

type Bone = 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs'
type Effect = 'through' | 'whole' | 'local'
type Source = 'none' | 'workshop' | 'legacy' | 'flower'
type Preview = { sections: Array<{ panel: SplitPanel; lattice: OpenLatticeResult }> }
const bones: Array<{ id: Bone; name: string; hint: string }> = [
  { id:'ribs',name:'粗疏筋架 · 首选',hint:'交叉高低筋 · 完整正面承托' },
  { id: 'hex', name: '圆润连筋', hint: '圆弧连接 · 规则重复' },
  { id: 'organic', name: 'Voronoi 连筋', hint: '不规则网状连接' },
  { id: 'diamond', name: '规则斜撑', hint: '连续斜向筋条' },
  { id: 'honeycomb', name: '细分蜂窝', hint: '小六边单元 · 连续细网' },
]
const effects: Array<{ id: Effect; name: string; hint: string }> = [
  { id: 'whole', name: '保留正面＋背筋 · 首选', hint: '完整承托薄层 · 背面减材' },
  { id: 'through', name: '完全镂空', hint: '其他方案 · 前后贯通' },
  { id: 'local', name: '图案区托底', hint: '其他方案 · 随形薄底、外围贯通' },
]
const isBone = (value: unknown): value is Bone => bones.some(bone => bone.id === value)
const path = (points: Point2D[]) => `M${points.map(p => `${p.x},${p.y}`).join('L')}Z`

function navigateChoices(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) return
  event.preventDefault()
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
    Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
  buttons[index].focus({ preventScroll: true })
  buttons[index].scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** New trials prefer the supported front; saved geometry remains an explicit choice. */
export function initialOpenLatticeChoice(result?: SplitResultState | null): { bone: Bone; effect: Effect } {
  const face = result?.panels.find(panel => panel.latticeFace)?.latticeFace
  const saved = result?.openLatticeSvgOptions ?? face?.source?.options
  const existing = Boolean(result?.openLatticeStyle || saved || result?.panels.some(panel => panel.latticeFace || panel.latticeCutouts?.length))
  return {
    bone: isBone(result?.openLatticeStyle) ? result.openLatticeStyle : saved?.baseStyle ??
      (isBone(face?.source?.templateStyle) ? face.source.templateStyle : existing ? 'hex' : 'ribs'),
    effect: result?.openLatticeSurfaceMm ? 'whole' : saved?.mode === 'fidelity' ? saved.coverage === 'whole' ? 'whole' : 'local' : existing ? 'through' : 'whole',
  }
}

export function defaultLatticeSurfaceMm(cfg: SplitConfig, texture: BoardTextureConfig): number {
  const desired = Math.max(1, texture.enabled ? Math.ceil((texture.textureThickness + .42) * 5) / 5 : 1)
  return Math.max(.8, Math.min(2, Math.floor((cfg.thickness - 2) * 5) / 5, desired))
}

export function OpenLatticePanel() {
  const splitResult = useAppStore(s => s.splitResult)
  const cfg = useAppStore(s => s.splitConfig)
  const splitJob = useAppStore(s => s.splitJob)
  const project = useAppStore(s => s.project)
  const texture = useAppStore(s => s.boardTexture)
  const selectedLayerId = useAppStore(s => s.ui.selectedTextureLayerId)
  const displayedTrial = useAppStore(s => s.ui.structurePreviewPanels)
  const spatial = useAppStore(s => s.spatialLayout.enabled)
  const panels = useMemo(() => spatial ? [] : splitResult?.panels ?? [], [spatial, splitResult])
  const composition = useMemo(() => editableTextureComposition(boardTextureForSide(texture, 'front'), panels), [texture, panels])
  const svgLayers = composition.layers.filter((layer): layer is TextureCompositionImageLayer => layer.kind === 'image' && layer.visible && composition.assets.some(a => a.id === layer.assetId && a.mime === 'image/svg+xml'))
  const saved = splitResult?.openLatticeSvgOptions ?? panels.find(panel => panel.latticeFace)?.latticeFace?.source?.options
  const initialChoice = initialOpenLatticeChoice(splitResult)
  const defaultSurfaceMm = defaultLatticeSurfaceMm(cfg, texture)
  const newLattice = !splitResult?.openLatticeStyle && !saved && !panels.some(panel => panel.latticeFace || panel.latticeCutouts?.length)
  const [bone, setBone] = useState<Bone>(initialChoice.bone)
  const [effect, setEffect] = useState<Effect>(initialChoice.effect)
  const [source, setSource] = useState<Source>(splitResult?.openLatticeStyle === 'flower' ? 'flower' : saved?.sourceLayerId || svgLayers.some(l => l.id === selectedLayerId) ? 'workshop' : splitResult?.openLatticeSvg ? 'legacy' : 'none')
  const artSource = effect === 'whole' ? 'none' : source
  const [layerId, setLayerId] = useState(saved?.sourceLayerId ?? selectedLayerId ?? '')
  const [options, setOptions] = useState<SvgLatticeOptions>(saved ?? DEFAULT_SVG_LATTICE_OPTIONS)
  const [surfaceMm, setSurfaceMm] = useState(splitResult?.openLatticeSurfaceMm ?? saved?.backingMm ?? defaultSurfaceMm)
  const [latticeOptions,setLatticeOptions]=useState<NonNullable<SplitPanel['latticeOptions']>>(panels[0]?.latticeOptions??{fillWindows:false,cellPitchMm:16,cellRibMm:1.26,openCoreCaps:newLattice&&initialChoice.bone==='ribs'})
  const [baselineGrams,setBaselineGrams]=useState('')
  const [result, setResult] = useState<Preview | null>(null)
  const [progress, setProgress] = useState<{ phase: string; completed: number; total: number } | null>(null)
  const [message, setMessage] = useState('')
  const [host, setHost] = useState<HTMLElement | null>(null)
  const worker = useRef<Worker | null>(null)
  const requestData = useRef<{ source: string; options: SvgLatticeOptions } | null>(null)
  const layer = svgLayers.find(l => l.id === layerId) ?? svgLayers.find(l => l.id === selectedLayerId) ?? svgLayers.at(-1)
  const asset = composition.assets.find(a => a.id === layer?.assetId)
  const sourceStamp = artSource === 'workshop' ? JSON.stringify([layer, asset?.revision]) : artSource
  const bounds = panels.length ? { minX: Math.min(...panels.map(p => p.x)), minY: Math.min(...panels.map(p => p.y)),
    width: Math.max(...panels.map(p => p.x + p.w)) - Math.min(...panels.map(p => p.x)),
    height: Math.max(...panels.map(p => p.y + p.h)) - Math.min(...panels.map(p => p.y)) } : null
  const oldContours = project.parts.flatMap(p => p.features).flatMap(f => f.type === 'sketch' ? f.contours : []).filter(c => c.source?.id === 'open-lattice-v1')
  const applied = panels.some(p => p.latticeCutouts?.length || p.latticeFace) || oldContours.length > 0
  const stale = Boolean(splitResult && JSON.stringify(splitResult.config) !== JSON.stringify(cfg))
  const chosen = bones.find(b => b.id === bone)!
  const requestedStyle = artSource === 'none' ? bone : artSource === 'flower' ? 'flower' : 'svg'
  const appliedBone = initialChoice.bone
  const appliedEffect = initialChoice.effect
  const dirty = applied && (requestedStyle !== splitResult?.openLatticeStyle || bone !== appliedBone || effect !== appliedEffect ||
    JSON.stringify(latticeOptions)!==JSON.stringify(panels[0]?.latticeOptions??{fillWindows:false,cellPitchMm:16,cellRibMm:1.26,openCoreCaps:false}) ||
    (effect !== 'through' && surfaceMm !== (splitResult?.openLatticeSurfaceMm ?? saved?.backingMm ?? 1)) ||
    (artSource !== 'none' && (options.lineWidthMm !== saved?.lineWidthMm || options.padShape !== saved?.padShape || options.outlineGapMm !== saved?.outlineGapMm || options.contrastColor !== saved?.contrastColor)) ||
    (artSource === 'legacy' && Boolean(saved?.sourceLayerId)) ||
    (artSource === 'workshop' && (layer?.id !== saved?.sourceLayerId || Boolean(saved?.sourceSignature && saved.sourceSignature !== sourceStamp))))
  const status = result ? '试看方案 · 未写入工程' : progress ? '正在生成试看效果' : displayedTrial ? '参数已改 · 画面仍为上次试看' : dirty ? '参数已改 · 请生成试看' : applied ? '工程中已使用' : '尚未生成'
  const thumb = (id: Bone) => `${import.meta.env.BASE_URL}lattice-reference/${id}.svg`
  const releaseWorker = () => {
    const task=worker.current;worker.current=null
    if(task){task.onmessage=null;task.onerror=null;task.onmessageerror=null;task.terminate()}
  }
  const stop = () => { releaseWorker(); setProgress(null) }
  const invalidate = (restore = false) => { stop(); setResult(null); setMessage(''); if (restore) useAppStore.getState().setUI({ structurePreviewPanels: null }) }
  useEffect(() => { setHost(document.getElementById('workbench-structure-inspector')); return () => {
    releaseWorker(); useAppStore.getState().setUI({ structurePreviewPanels: null })
  } }, [])
  useEffect(() => { invalidate(true) }, [splitResult])
  useEffect(() => { invalidate() }, [sourceStamp]) // keep the last trial visible while preparing the next
  useEffect(() => {
    const choice = initialOpenLatticeChoice(splitResult)
    setBone(choice.bone)
    setEffect(choice.effect)
    setOptions(saved ?? DEFAULT_SVG_LATTICE_OPTIONS)
    setSurfaceMm(splitResult?.openLatticeSurfaceMm ?? saved?.backingMm ?? defaultSurfaceMm)
    setSource(splitResult?.openLatticeStyle === 'flower' ? 'flower' : saved?.sourceLayerId || ((!splitResult?.openLatticeStyle || splitResult.openLatticeStyle === 'svg') && svgLayers.some(l => l.id === selectedLayerId)) ? 'workshop' : splitResult?.openLatticeStyle === 'svg' ? 'legacy' : 'none')
    setLayerId(saved?.sourceLayerId ?? selectedLayerId ?? '')
    setLatticeOptions(panels[0]?.latticeOptions??{fillWindows:false,cellPitchMm:16,cellRibMm:1.26,openCoreCaps:newLattice&&choice.bone==='ribs'})
  }, [project, splitResult?.openLatticeStyle, saved, splitResult?.openLatticeSurfaceMm,panels[0]?.latticeOptions, defaultSurfaceMm, newLattice])
  useEffect(() => {
    if (svgLayers.some(l => l.id === selectedLayerId)) setLayerId(selectedLayerId!)
  }, [selectedLayerId])
  const editDiagram = () => useAppStore.getState().setUI({ ...workspaceSelection('appearance'), viewMode: '3d', textureEditSide: 'front', selectedTextureLayerId: layer?.id ?? null })
  const migrateLegacy = () => {
    if (!splitResult?.openLatticeSvg || !bounds) return
    try {
      const prepared = prepareTextureSvg(splitResult.openLatticeSvg)
      const root = new DOMParser().parseFromString(splitResult.openLatticeSvg, 'image/svg+xml').documentElement
      const view = root.getAttribute('viewBox')!.split(/[\s,]+/).map(Number) as [number, number, number, number]
      const placement = splitResult.openLatticePlacement ?? DEFAULT_SVG_LATTICE_PLACEMENT
      const transform = svgLatticeTransform(view, { x: bounds.minX, y: bounds.minY, w: bounds.width, h: bounds.height }, placement)
      const revision = textureCompositionSignature(prepared.dataUrl), id = `lattice-${revision}`
      const assetId = composition.assets.find(a => a.dataUrl === prepared.dataUrl)?.id ?? id
      const next = structuredClone(composition)
      if (!next.assets.some(a => a.id === assetId)) next.assets.push({ id: assetId, name: '旧工程 SVG', mime: 'image/svg+xml', dataUrl: prepared.dataUrl, width: prepared.width, height: prepared.height, aspect: prepared.width / prepared.height, revision })
      const newLayer = `lattice-layer-${Date.now().toString(36)}`
      next.layers.push({ id: newLayer, kind: 'image', name: '旧工程 SVG', assetId, visible: true, locked: false, opacity: 1,
        placement: { mode: 'free', fit: 'stretch', crop: createDefaultTextureCrop(), transform: {
          xMm: bounds.minX + bounds.width / 2 + placement.offsetX, yMm: bounds.minY + bounds.height / 2 + placement.offsetY,
          widthMm: view[2] * transform.scale, heightMm: view[3] * transform.scale,
          rotationDeg: placement.rotationDeg, flipX: placement.flipX, flipY: placement.flipY,
        } } })
      useAppStore.getState().setBoardTexture({ source: 'composition', composition: next })
      setLayerId(newLayer); setSource('workshop')
      useAppStore.getState().setUI({ ...workspaceSelection('appearance'), selectedTextureLayerId: newLayer, textureEditSide: 'front', viewMode: '3d' })
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }
  const canCombine = () => !texture.enabled || !hasBoardTextureSource(texture) ||
    effect === 'whole' ||
    (artSource === 'workshop' && layer && sharedSvgStructureOnly(texture, panels, [layer.id]))
  const calculate = () => {
    if (!splitResult || !bounds || stale || splitJob || progress) return
    invalidate()
    if (effect === 'local' && artSource === 'none') { setMessage('图案区托底需要选择 SVG 图案'); return }
    const request: OpenLatticeRequest = { config: cfg, ribMm: 3.5, style: requestedStyle, holes: [], surfaceMm: artSource === 'none' && effect === 'whole' ? surfaceMm : 0,latticeOptions,
      massProfile:{infillPercent:texture.baseInfillDensity,frontDenseMm:texture.enabled?texture.textureThickness:0,...(Number(baselineGrams)>0?{baselineGrams:Number(baselineGrams)}:{})} }
    let text = ''
    const printOptions: SvgLatticeOptions = { ...options, backingMm: surfaceMm, baseStyle: bone,
      mode: effect === 'through' ? 'cutout' : 'fidelity', coverage: effect === 'whole' ? 'whole' : 'artwork', sourceLayerId: undefined, sourceSignature: undefined }
    try {
      if (artSource === 'workshop') {
        if (!layer || !asset) throw new Error('请先在纹理工作室导入 SVG，并选择一个可见图层')
        text = decodeWorkshopSvg(asset)
        request.artwork = workshopSvgArtwork(asset, layer, bounds, panels)
        printOptions.sourceLayerId = layer.id
        printOptions.sourceSignature = sourceStamp
      } else if (artSource !== 'none') {
        text = artSource === 'flower' ? DEFAULT_FLOWER_SVG : splitResult.openLatticeSvg ?? ''
        if (!text) throw new Error('旧 SVG 不存在，请在纹理工作室导入图案')
        request.artwork = recognizeSvgLattice(text, { x: bounds.minX, y: bounds.minY, w: bounds.width, h: bounds.height }, artSource === 'legacy' ? splitResult.openLatticePlacement : DEFAULT_SVG_LATTICE_PLACEMENT)
      }
      if (artSource !== 'none') request.svgOptions = printOptions
      if (oldContours.length) {
        const ids = new Set(splitResult.sources.flatMap(s => s.sourceIds ?? [s.contourId]))
        const prepared = project.parts.flatMap(p => p.features).filter(f => f.type === 'sketch').filter(s => s.contours.some(c => ids.has(c.id)))
          .map((s, i) => prepareSplitGeometry(s.contours.filter(c => c.source?.id !== 'open-lattice-v1'), project.config.pixelToMM, { idPrefix: `lattice-base-${i}` }))
        request.targets = prepared.flatMap(p => p.targets.filter(t => t.sourceIds.some(id => ids.has(id))))
        request.holes = prepared.flatMap(p => p.holes)
        request.manualHoleStates = panels.flatMap(p => p.edge_holes.filter(h => h.manual).map(h => ({ x: h.x, y: h.y, knocked: !!h.knocked })))
      } else request.panels = panels.map(p => ({ ...p, latticeCutouts: undefined, latticeFace: undefined }))
      requestData.current = { source: text, options: printOptions }
      const task = new Worker(new URL('../../workers/openLattice.worker.ts', import.meta.url), { type: 'module' })
      worker.current = task
      setProgress({ phase: 'generating', completed: 0, total: panels.length })
      task.onmessage = (event: MessageEvent<OpenLatticeResponse>) => {
        if (worker.current !== task) return
        const response = event.data
        if (response.type === 'progress') { setProgress(response); return }
        stop()
        if (response.type === 'error') { setMessage(response.message); return }
        if (useAppStore.getState().project !== project || useAppStore.getState().splitConfig !== cfg ||
          (artSource === 'workshop' && useAppStore.getState().boardTexture !== texture)) { setMessage('工程或图案已修改，请重新生成试看效果'); return }
        setResult({ sections: response.sections })
        useAppStore.getState().setUI({ structurePreviewPanels: response.sections.map(({ panel, lattice }) => ({ ...panel, latticeCutouts: lattice.holes, latticeFace: lattice.face })), viewMode: '3d' })
      }
      task.onerror = event => { if (worker.current === task) { stop(); setMessage(event.message || '生成试看效果失败') } }
      task.onmessageerror = () => { if (worker.current === task) { stop(); setMessage('试看结果无法读取，请重新生成') } }
      task.postMessage(request)
    } catch (e) { stop(); setMessage(e instanceof Error ? e.message : String(e)) }
  }
  const apply = () => {
    if (!result || !requestData.current) return
    if (effect === 'whole' && texture.enabled && surfaceMm + 1e-6 < texture.textureThickness) {
      setMessage(`图案贴面需要 ${texture.textureThickness.toFixed(1)}mm；请将正面保留厚度调至至少此值，再生成试看效果。`); return
    }
    if (effect !== 'through' && !canCombine()) { setMessage('当前薄面模式只能与引用的单个 SVG 线稿组合；其他彩色图层的合并制造尚未开放。请先关闭其他图层或不使用线稿。'); return }
    const kind = result.sections[0].lattice.style
    if (kind === 'tree') return
    useAppStore.getState().setOpenLattice(result.sections.map(({ panel, lattice }) => ({ panel, holes: lattice.holes, face: lattice.face })),
      kind, oldContours.map(c => c.id), kind === 'svg' ? requestData.current.source : undefined,
      artSource === 'legacy' ? splitResult?.openLatticePlacement : undefined, artSource === 'none' ? undefined : requestData.current.options,
      effect === 'whole' ? surfaceMm : 0)
    useAppStore.getState().setUI({ structurePreviewPanels: null, viewMode: '3d' })
    setResult(null); setMessage('已写入当前工程；保存、导出将使用此镂空。可撤销。')
  }
  const remove = () => {
    invalidate(true)
    if (splitResult?.openLatticeStyle) useAppStore.getState().clearOpenLattice()
    else if (oldContours.length) useAppStore.getState().execute(new CompositeCommand('移除旧版镂空', oldContours.map(c => new RemoveContourCommand(c.id))))
  }
  const sourceImage = source === 'workshop' ? asset?.dataUrl : undefined
  const outline = result?.sections.find(s => s.lattice.face?.source?.silhouette)?.lattice.face?.source?.silhouette
  const estimated = result && result.sections.every(s => s.lattice.volumeMm3 !== undefined)
    ? Math.round((1 - result.sections.reduce((n,s) => n+s.lattice.volumeMm3!,0) / result.sections.reduce((n,s) => n+s.lattice.baselineVolumeMm3!,0))*100) : null
  const inspector = <div className="open-lattice-panel lattice-inspector" aria-label="镂空参数与结果" aria-busy={Boolean(progress)}>
    <div className="lattice-inspector-scroll">
    <section className="lattice-card"><header><h3>当前选择</h3><span>{status}</span></header>
      <img className="lattice-reference-large" src={thumb(bone)} alt={`${chosen.name}背面骨架样例`} />
      <small>骨架样例 · {chosen.name} · 实际效果在中间查看</small>
      <div className="lattice-metrics"><span>板件<b>{panels.length} 块</b></span><span>总板厚<b>{cfg.thickness.toFixed(1)}mm</b></span>
        <span>{effect === 'through' ? '穿透深度' : '保留薄面'}<b>{(effect === 'through' ? cfg.thickness : surfaceMm).toFixed(1)}mm</b></span>
        <span>状态<b>{result ? '正在试看' : displayedTrial ? '上次试看' : dirty ? '待试算' : applied ? '已确认使用' : '未生成'}</b></span></div>
    </section>
    <details className="lattice-card"><summary>内部细网与骨架工艺</summary>
      {bone==='ribs'&&<p>纵横网格交替采用高筋（{(cfg.thickness-surfaceMm).toFixed(2)}mm）和矮筋（{Math.min(1.96,cfg.thickness-surfaceMm).toFixed(2)}mm）。中间孔通过完整矮筋连接两侧，取消单侧短高筋。筋根 0.6mm 加强倒角，外露边约 0.28mm 倒角/圆角；承载与时间仍需试打。</p>}
      {bone!=='honeycomb'&&bone!=='ribs'&&<label className="open-lattice-option"><input type="checkbox" checked={latticeOptions.fillWindows} onChange={e=>{invalidate();setLatticeOptions({...latticeOptions,fillWindows:e.target.checked})}}/>在主骨架窗口内增加蜂窝补强</label>}
      {(bone==='honeycomb'||bone!=='ribs'&&latticeOptions.fillWindows)&&<><label>蜂窝孔距 mm<input type="number" min={8} max={32} step={2} value={latticeOptions.cellPitchMm} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber)){invalidate();setLatticeOptions({...latticeOptions,cellPitchMm:Math.max(8,Math.min(32,e.target.valueAsNumber))})}}}/></label>
      <label>蜂窝筋宽 mm<input type="number" min={1.26} max={3} step={.21} value={latticeOptions.cellRibMm} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber)){invalidate();setLatticeOptions({...latticeOptions,cellRibMm:Math.max(1.26,Math.min(3,e.target.valueAsNumber))})}}}/></label></>}
      <label className="open-lattice-option"><input type="checkbox" checked={latticeOptions.openCoreCaps} onChange={e=>{invalidate();setLatticeOptions({...latticeOptions,openCoreCaps:e.target.checked})}}/>取消骨架切片顶底封盖</label>
      <small>只改变骨架切片工艺，正面与承托薄层保持完整。细网补强会增加材料；孔越密，墙线也越多。</small>
      <label>普通板实际切片重量 g（可选）<input type="number" min={1} placeholder="例如 138，用于校准" value={baselineGrams} onChange={e=>{invalidate();setBaselineGrams(e.target.value)}}/></label>
      <small>估算按 PETG 1.27g/cm³、0.42mm 线宽、{bone==='ribs'?'3壁、密实筋条':'2壁、'+texture.baseInfillDensity+'% 填充'}、0.28mm 层高；不含支撑、擦料及裙边。</small>
    </details>
    {effect !== 'through' && <section className="lattice-card"><h3>面层参数</h3><label>{effect === 'whole' ? '正面保留厚度 mm' : '图案托底厚度 mm'}<input type="number" min={0.8} max={2} step={0.2} value={surfaceMm} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) { invalidate(); setSurfaceMm(Math.max(0.8,Math.min(2,e.target.valueAsNumber))) } }} /></label>
      <small>背面挖空约 {(cfg.thickness-surfaceMm).toFixed(1)}mm；功能孔贯通。订单凹刻优先使用背面实体留白，再检查可接近的承托层背面；空间不足会停止制造。</small></section>}
    <section className="lattice-card"><header><h3>图案来源</h3><button type="button" className="lattice-text-button" onClick={editDiagram}>去纹理工作室</button></header>
      {effect === 'whole' ? <p>正面沿用纹理工作室的图片、SVG 和排版；只挖空背面，不把图案改成镂空线稿。</p> : <><select aria-label="镂空图案来源" value={source} onChange={e => { invalidate(); setSource(e.target.value as Source) }}>
        <option value="none">不使用图案</option><option value="workshop">引用纹理工作室 SVG</option>
        {splitResult?.openLatticeSvg && <option value="legacy">旧工程 SVG</option>}<option value="flower">海棠示例</option>
      </select>
      {source === 'workshop' && <>{svgLayers.length ? <label>SVG 图层<select value={layer?.id ?? ''} onChange={e => { invalidate(); setLayerId(e.target.value) }}>{svgLayers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        : <p>尚无可见 SVG 图层，先到纹理工作室拖入图案。</p>}{sourceImage && <div className="lattice-source-preview"><img src={sourceImage} alt="引用的 SVG 图案" /><small>{layer?.name}<br/>位置、大小和镜像沿用前面的排版。</small></div>}</>}
      {source === 'legacy' && <><small>保留旧工程图案；迁移后在纹理工作室统一编辑。</small><button type="button" onClick={migrateLegacy}>迁移旧 SVG 并编辑</button></>}</>}
    </section>
    {artSource !== 'none' && effect !== 'through' && <details className="lattice-card"><summary>线稿制造参数</summary>
      {effect === 'local' && <><label>托底外形<select value={options.padShape ?? 'rectangle'} onChange={e => { invalidate(); setOptions({ ...options, padShape: e.target.value as SvgLatticeOptions['padShape'] }) }}><option value="silhouette">人物外缘包络</option><option value="contour">闭合外轮廓</option><option value="rectangle">矩形托底</option></select></label>
        <label>闭合距离 mm<input type="number" min={0} max={10} step={0.5} value={options.outlineGapMm ?? 2} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) { invalidate(); setOptions({ ...options, outlineGapMm: Math.max(0,Math.min(10,e.target.valueAsNumber)) }) } }} /></label></>}
      <label>线宽 mm<input type="number" min={0.84} max={4} step={0.21} value={options.lineWidthMm} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) { invalidate(); setOptions({ ...options, lineWidthMm: Math.max(0.84,Math.min(4,e.target.valueAsNumber)) }) } }} /></label>
      <label className="open-lattice-option"><input type="checkbox" checked={Boolean(options.contrastColor)} onChange={e => { invalidate(); setOptions({ ...options, contrastColor:e.target.checked ? '#263238' : undefined }) }} />双色线稿</label>
      {options.contrastColor && <label>线稿制造色<input type="color" value={options.contrastColor} onChange={e => { invalidate(); setOptions({ ...options, contrastColor:e.target.value }) }} /></label>}
    </details>}
    {result && bounds && <section className="lattice-card open-lattice-result"><header><h3>本次试看效果</h3><span>未写入工程</span></header>
      {result.sections.every(s=>s.lattice.massEstimate)&&<p>预估本体 <b>{result.sections.reduce((v,s)=>v+s.lattice.massEstimate!.grams,0).toFixed(1)}g</b>；相对普通板用料变化 {((result.sections.reduce((v,s)=>v+s.lattice.massEstimate!.grams,0)/result.sections.reduce((v,s)=>v+s.lattice.massEstimate!.baselineGrams,0)-1)*100).toFixed(1)}%。{Number(baselineGrams)>0?'已校准普通板基准':'未实测校准'}；建议预留约 ±20% 估算误差，以实际切片为准。</p>}
      {estimated !== null && <p>实体几何体积减少约 <b>{estimated}%</b>；耗料以切片为准。</p>}
      <svg viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`} role="img" aria-label="镂空候选平面图"><g transform={`translate(0 ${2*bounds.minY+bounds.height}) scale(1 -1)`}>
        {result.sections.map(({ panel, lattice }) => <g key={panel.id}><path d={path(panel.contour!)} fill="#7cdccd" />{[...(panel.cutouts ?? []),...lattice.holes].map((r,i) => <path key={i} d={path(r)} fill="#0d1420" />)}
          {lattice.face?.layers.filter(l => l.role === 'backing' || l.role === 'detail').flatMap(l => l.polygons.map((p,i) => <path key={`${l.role}-${i}`} d={p.map(path).join(' ')} fillRule="evenodd" fill={l.role === 'detail' ? lattice.face?.contrastColor ?? '#507f78' : '#7cdccd'} />))}
          {panel.slots.map((s,i) => <rect key={`slot-${i}`} x={s.x-cfg.slotWidth/2} y={s.y-cfg.slotLength/2} width={cfg.slotWidth} height={cfg.slotLength} rx={cfg.slotWidth/2} fill="#0d1420" />)}
          {[...panel.round_holes,...panel.edge_holes.filter(h => h.knocked)].map((h,i) => <circle key={`hole-${i}`} cx={h.x} cy={h.y} r={cfg.jointDiameter/2} fill="#0d1420" />)}</g>)}
        {outline?.map((p,i) => <path key={`outline-${i}`} d={p.map(path).join(' ')} fill="none" stroke="#f5b94e" strokeWidth="0.6" strokeDasharray="3 2" />)}</g></svg>
      <small>中间显示本次方案。确认使用后，才替换工程中的镂空并用于保存、导出。</small>
    </section>}
    <details className="lattice-card"><summary>制造说明与检查</summary><small>功能孔按原工程保留，未开圆孔不作为连接点。人物外缘包络会填平手臂、腿间空隙；精确凹边请用闭合轮廓。薄面采用直壁，承重需实测。</small>
      {!!splitResult?.warnings.length && <ul>{splitResult.warnings.map((w,i) => <li key={i}>{w}</li>)}</ul>}</details>
    </div>
    <div className="lattice-actions"><small className="lattice-action-help">① 生成只供试看，不改工程。② 确认使用后，保存、导出才采用新方案。</small>
      {progress && <div className="open-lattice-progress" role="status">正在计算镂空 {progress.completed}/{progress.total}<span className="open-lattice-progress-bar" /></div>}
      <button type="button" className="open-lattice-primary" disabled={!panels.length || stale || Boolean(splitJob) || Boolean(progress) || Boolean(result)} onClick={calculate}>{progress ? '正在生成试看…' : result ? '① 试看效果已生成' : '① 生成试看效果'}</button>
      {result && <button type="button" className="lattice-apply" onClick={apply}>{applied ? '② 确认替换现有镂空' : '② 确认使用此镂空'}</button>}
      {displayedTrial && <button type="button" className="open-lattice-secondary" onClick={() => invalidate(true)}>放弃试看，返回工程效果</button>}
      {applied && !displayedTrial && <button type="button" className="open-lattice-secondary" disabled={Boolean(progress)} onClick={remove}>移除工程中的镂空</button>}
      {message && <p role="status">{message}</p>}
    </div>
  </div>
  return <div className="open-lattice-panel lattice-choices" aria-label="镂空方式与骨架">
    {!panels.length && <p role="status">先在板材设计生成平面板件。</p>}{stale && <p role="status">板件参数已修改，请先更新板件。</p>}
    <section><h3><i>1</i>镂空方式</h3><div className="lattice-effect-list" role="group" aria-label="镂空方式" onKeyDown={navigateChoices}>{effects.map(item => <button type="button" key={item.id} disabled={bone==='ribs'&&item.id!=='whole'} aria-pressed={effect === item.id} onClick={() => { invalidate(); setEffect(item.id) }}><span className="lattice-radio" aria-hidden="true" /><span><strong>{item.name}</strong><small>{item.hint}</small></span></button>)}</div>{bone==='ribs'&&<small>粗疏筋架首版搭配连续正面薄层；其他方式请先选择另一种骨架。</small>}</section>
    <section><h3><i>2</i>骨架样式</h3><div className="lattice-bone-list" role="group" aria-label="骨架样式" aria-describedby="lattice-bone-scroll-help" onKeyDown={navigateChoices}>{bones.map(item => <button type="button" key={item.id} aria-pressed={bone === item.id} onClick={() => { invalidate(); setBone(item.id);if(item.id==='ribs'){setEffect('whole');setLatticeOptions({...latticeOptions,fillWindows:false,openCoreCaps:true})} }}><img src={thumb(item.id)} alt="" /><span><strong>{item.name}</strong><small>{item.hint}</small></span></button>)}</div><small id="lattice-bone-scroll-help">滚轮浏览骨架 · 点击选择<br/>小图为背面示意；方向键浏览，回车选择。</small></section>
    {host ? createPortal(inspector, host) : inspector}
  </div>
}
