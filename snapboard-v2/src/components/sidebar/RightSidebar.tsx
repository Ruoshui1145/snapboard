// ============ 右侧栏: 分割 / 配件 / 纹理单任务工作区 ============
import { lazy,Suspense,useEffect, useMemo, useState } from 'react'
import {createPortal} from 'react-dom'
import { useAppStore } from '../../store/useAppStore'
import { PartLibraryPanel } from './PartLibraryPanel'
import type { PartDefinition } from '../../partLibrary/types'
import { beginPartDrag, endPartDrag } from '../../utils/partDragSession'
import { printableBedDescription, MIN_PRINT_BED_MARGIN_MM } from '../../utils/printBed'
import { BAMBU_PRINTER_PRESETS, splitConfigForPrinter } from '../../utils/bambuPrinterPresets'
import { TextureStudio } from '../texture/TextureStudio'
import { MountScenePanel } from '../partLibrary/MountScenePanel'
import { OcclusionPreviewPanel } from '../occlusion/OcclusionPreviewPanel'
import { LayoutAdvisorPanel, type LayoutAdvisorSuggestion } from '../occlusion/LayoutAdvisorPanel'
import { computeOcclusionReport } from '../../utils/occlusionModel'
import { usePartLibrary } from '../../hooks/usePartLibrary'
import { adviseLayoutTargets } from '../../utils/layoutAdvisor'
import { AssemblyMarkingPanel } from '../assemblyMarking/AssemblyMarkingPanel'
import { SpatialManufacturingPanel } from './SpatialLayoutPanel'
import { OpenLatticePanel } from './OpenLatticePanel'
import { useCommercialLicense } from '../licensing/commercialLicense'
import { OrderEngravingShortcut } from '../manufacturing/OrderEngravingShortcut'
import './sidebar-fields.css'

import type { WorkbenchWorkspace } from '../../utils/workbenchNavigation'
const LayerPreviewPanel=lazy(()=>import('../manufacturing/LayerPreviewPanel').then(m=>({default:m.LayerPreviewPanel})))

export function RightSidebar({workspace,pendingDesign=false}: {workspace: WorkbenchWorkspace;pendingDesign?:boolean}) {
  const license = useCommercialLicense()
  const exportAuthorized = Boolean(license?.commercialAllowed && license.capabilities.includes('commercial.export'))
  const setUI = useAppStore(s => s.setUI)
  const splitResult = useAppStore(s => s.splitResult)
  const spatialLayout = useAppStore(s => s.spatialLayout)
  const hasPanels = Boolean(splitResult?.panels.length) || spatialLayout.enabled
  const splitJob = useAppStore(s => s.splitJob)
  const splitConfig = useAppStore(s => s.splitConfig)
  const splitConfigChanged = !spatialLayout.enabled && hasPanels && JSON.stringify(splitResult?.config) !== JSON.stringify(splitConfig)
  const splitWarnings = splitResult?.warnings ?? []
  const setSplitConfig = useAppStore(s => s.setSplitConfig)
  const runAutoSplit = useAppStore(s => s.runAutoSplit)
  const placedParts = useAppStore(s => s.placedParts)
  const boardTexture = useAppStore(s => s.boardTexture)
  const orderLink = useAppStore(s => s.orderLink)
  const setBoardTexture = useAppStore(s => s.setBoardTexture)
  const occlusionMode = useAppStore(s => s.occlusionMode)
  const occlusionOverlayEnabled = useAppStore(s => s.occlusionOverlayEnabled)
  const setOcclusionMode = useAppStore(s => s.setOcclusionMode)
  const setOcclusionOverlayEnabled = useAppStore(s => s.setOcclusionOverlayEnabled)
  const { index: partLibrary } = usePartLibrary()
  // 结果是日常主视图；高级参数仅在用户明确需要调整时展开。
  const [configOpen, setConfigOpen] = useState(false)
  const [inspectionHost,setInspectionHost] = useState<HTMLElement|null>(null)
  const [inspectionTab,setInspectionTab]=useState<'layers'|'assembly'>('layers')
  useEffect(()=>{setInspectionHost(workspace==='inspect'?document.getElementById('workbench-properties'):null)},[workspace])

  const printerPreset = splitConfig.printerPreset || 'bambu-p1s'

  const applyPrinterPreset = (preset: string) => {
    if (preset === 'custom') setSplitConfig({ printerPreset: 'custom' })
    else if (preset === 'generic-220') setSplitConfig({
      printerPreset: 'generic-220', bedW: 220, bedH: 220,
      bedMarginLeft: MIN_PRINT_BED_MARGIN_MM, bedMarginRight: MIN_PRINT_BED_MARGIN_MM,
      bedMarginBottom: MIN_PRINT_BED_MARGIN_MM, bedMarginTop: MIN_PRINT_BED_MARGIN_MM, bedKeepouts: [],
    })
    else setSplitConfig(splitConfigForPrinter(preset))
  }

  const updateKeepout = (id: string, patch: Partial<(typeof splitConfig.bedKeepouts)[number]>) => {
    setSplitConfig({ bedKeepouts: splitConfig.bedKeepouts.map(zone => zone.id === id ? { ...zone, ...patch } : zone) })
  }

  const occlusionReport = useMemo(() => {
    const panels = splitResult?.panels ?? []
    if (!panels.length) return null
    return computeOcclusionReport(panels, placedParts, partLibrary?.parts ?? [], {
      textureAvoidZones: boardTexture.enabled ? boardTexture.avoidZones : [],
    })
  }, [splitResult, placedParts, partLibrary, boardTexture.enabled, boardTexture.avoidZones])

  const layoutSuggestions = useMemo(() => {
    const panels = splitResult?.panels ?? []
    if (!panels.length) return []
    const occupiedTargetIds = new Set(placedParts.flatMap(part => part.placement?.targetIds ?? []))
    return adviseLayoutTargets(panels, splitConfig, { occupiedTargetIds, mode: occlusionMode })
  }, [splitResult, splitConfig, placedParts, occlusionMode])

  const layoutUiSuggestions = useMemo<LayoutAdvisorSuggestion[]>(() => {
    if (!layoutSuggestions.length) return []
    const scores = layoutSuggestions.map(item => item.score)
    const min = Math.min(...scores)
    const max = Math.max(...scores)
    const span = Math.max(1e-9, max - min)
    return layoutSuggestions.map(item => ({
      id: item.targetId,
      panelId: item.panelId,
      targetId: item.targetId,
      kind: item.kind,
      edgeDistance: item.edgeDistanceMm,
      zoneLabel: item.zoneLabel,
      score: (item.score - min) / span,
      reasons: [item.reason],
      x: item.x,
      y: item.y,
    }))
  }, [layoutSuggestions])

  const activeWorkspace = {board:'split',appearance:'texture',parts:'parts',structure:'structure',inspect:'occlusion'}[workspace]

  const handleDragPart = (def: PartDefinition, e: React.DragEvent) => {
    const payload = {
      defId: def.id,
      params: Object.fromEntries(def.params.map(p => [p.id, p.default])),
    }
    e.dataTransfer.setData('application/snapboard-part', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    // 隐藏浏览器默认的整张文字卡片拖影；3D 视口会显示真实模型预览。
    const transparent = document.createElement('canvas')
    transparent.width = 1
    transparent.height = 1
    // Chromium 要求自定义拖影节点已经参与渲染；脱离 DOM 的 canvas 会偶发退回整张卡片拖影。
    transparent.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1'
    document.body.appendChild(transparent)
    e.dataTransfer.setDragImage(transparent, 0, 0)
    window.setTimeout(() => transparent.remove(), 0)
    beginPartDrag(payload)
    setUI({ viewMode: '3d', activeTool: 'select' })
  }

  const handleDragEnd = () => endPartDrag()

  return (
    <div className={`rsb${spatialLayout.enabled ? ' is-spatial' : ''}`}>
      <div className="workbench-task-header" hidden={workspace==='appearance'||workspace==='board'}><h2>{{board:'板材设计',appearance:'纹理工作室',parts:'配件库',structure:'镂空结构',inspect:spatialLayout.enabled?'制造与导出':'分析与导出'}[workspace]}</h2><p>{{board:'从一个形状开始，按打印机尺寸生成板件。',appearance:'选择外观来源，再调整右侧参数。',parts:'搜索后拖到板上，点击已放置配件调整。',structure:'选择镂空样式并生成预览；已有镂空可直接更新。',inspect:spatialLayout.enabled?'调整立体参数并导出制造文件。':'查看装配建议，制造网格会在导出时检查。'}[workspace]}</p></div>
      {workspace === 'structure' && <OpenLatticePanel />}
      {workspace === 'inspect' && <div className="workbench-export-card">
        <strong>制造导出 · {spatialLayout.enabled ? '立体版面' : `${splitResult?.panels.length ?? 0} 块板件 · ${placedParts.length} 件配件`}</strong>
        <p role="status">{spatialLayout.enabled ? '按所选制造方式生成立体板件；旧平面纹理及已放配件不参与本次导出。' : !hasPanels ? '尚无板件：请先在板材设计中生成板件。' : splitConfigChanged ? '分板参数已改变：当前导出仍使用旧板件，请先更新板件并复查装配。' : splitWarnings.length ? `当前有 ${splitWarnings.length} 条分板提示，请在导出前查看。` : '板件已生成；导出时还会检查制造网格。'}</p>
        {!exportAuthorized && <p role="status">{license?.message || '正在检查商用授权'}。可在顶部“商用授权”中激活或刷新；图纸仍可保存。</p>}
        <OrderEngravingShortcut disabled={!exportAuthorized || !hasPanels || Boolean(splitJob) || splitConfigChanged} />
        <button type="button" className="export-primary-action" disabled={!exportAuthorized || !hasPanels || Boolean(splitJob) || splitConfigChanged} onClick={()=>window.dispatchEvent(new CustomEvent('snapboard:export-manufacturing',{detail:{mode:'original'}}))}>{spatialLayout.enabled ? '导出立体制造文件' : '导出完整模型（板件＋配件）'}</button>
        <button type="button" className="export-secondary-action" disabled={spatialLayout.enabled} onClick={()=>setInspectionTab('layers')}>查看材料层结构 →</button>
        {!spatialLayout.enabled && <><button type="button" className="export-secondary-action" disabled={Boolean(orderLink) || !exportAuthorized || !hasPanels || !boardTexture.enabled || boardTexture.backEnabled || Boolean(splitJob) || splitConfigChanged} onClick={()=>window.dispatchEvent(new CustomEvent('snapboard:export-manufacturing',{detail:{mode:'sample'}}))}>选择颜色试样（与原板同包）</button>
        {hasPanels && !boardTexture.enabled && <small>启用纹理后可选择颜色试样。</small>}
        {boardTexture.backEnabled && <small>双面颜色请先导出小尺寸完整板件试打；局部双面试样尚未校准。</small>}
        <label className="export-sampling-detail">输出方式
          <select value={orderLink ? 'order' : boardTexture.manufacturingOutput ?? 'single'} disabled={Boolean(orderLink) || !hasPanels || Boolean(splitJob) || splitConfigChanged} onChange={event => setBoardTexture({ manufacturingOutput: event.target.value === 'perPanel' ? 'perPanel' : 'single' })}>
            {orderLink && <option value="order">订单制造 ZIP（每块实物独立追溯）</option>}
            <option value="single">单个 3MF（整单排盘）</option>
            <option value="perPanel">每块板一个 3MF（打包 ZIP）</option>
          </select>
        </label>
        {orderLink && <small>订单生产固定导出逐实物制造 ZIP，自动归档到该订单；颜色试样请使用独立试验工程。</small>}
        <label className="export-sampling-detail">制造采样精度
          <select value={String(boardTexture.samplingDetail ?? 1)} disabled={!hasPanels || Boolean(splitJob) || splitConfigChanged || !boardTexture.enabled} onChange={event => setBoardTexture({ samplingDetail: Number(event.target.value) })}>
            <option value="1">自动（方案首轮预算，最快）</option>
            <option value="2">高（格数 ×2）</option>
            <option value="4">极高（格数 ×4）</option>
            <option value="8">极限（格数 ×8）</option>
          </select>
        </label>
        <small>{boardTexture.enabled
          ? '叠色杂色斑来自抗锯齿边缘在粗格点上的量化。精度越高色界越干净，格数、内存与导出耗时同比上升；该选择随工程保存，实际间距写在导出报告里。'
          : '当前未启用叠色纹理，采样精度暂不可调；启用后这里决定色界干净度与导出耗时。'}</small>
        </>}
        {spatialLayout.enabled && <small>板件按当前打印机安全空间检查；外置模式包含装配图，固定孔保持开启时可附临时定角 M3 连接件。请在切片器复核并试装。</small>}
        <small>遮挡与布局建议不等于承载强度验证。</small>
      </div>}

      {activeWorkspace === 'split' && spatialLayout.enabled && <SpatialManufacturingPanel />}
      {/* ============ 分割引擎 ============ */}
      {activeWorkspace === 'split' && !spatialLayout.enabled && <section className="acc expanded right-workspace-content">
        <div className="acc-head" title="分割引擎参数与结果">
          <span style={{ fontSize: 15 }}>🔪</span>
          <span style={{ fontWeight: 600 }}>板件生成</span>
          <div className="split-head-actions">
            <button type="button" disabled={Boolean(splitJob)||pendingDesign} className="split-primary-action"
              onClick={() => { if (hasPanels && !splitConfigChanged) { setUI({viewMode:'3d'}); return } void runAutoSplit({ regenerate: hasPanels }); setUI({ splitOptionsOpen: true, partsOpen: false, textureStudioOpen: false, occlusionAnalysisOpen: false }) }}>
              {splitJob?'正在生成…':hasPanels?splitConfigChanged?'更新板件':'查看板件（3D）':'生成板件'}
            </button>
            {splitJob&&<button type="button" className="split-stop-action" onClick={()=>void runAutoSplit()}>停止</button>}
            {hasPanels&&!splitJob&&!splitConfigChanged&&<button type="button" className="split-view-action" disabled={pendingDesign} onClick={()=>void runAutoSplit({regenerate:true})}>重新生成</button>}
          </div>
        </div>
        {pendingDesign&&workspace==='board'&&<p className="board-pending-note">候选轮廓尚未应用；请先在左侧完成应用，再生成板件。</p>}
        {splitConfigChanged&&!pendingDesign&&<p className="board-pending-note" role="status">分板参数已改变。旧结果保留，点击“更新板件”后替换；请复查配件与纹理位置。</p>}
        {!hasPanels&&!splitJob&&splitWarnings.length>0&&<p className="board-pending-note" role="alert">{splitWarnings[0]}</p>}
        {hasPanels&&!splitJob&&!splitConfigChanged&&<p className="board-pending-note" role="status">板件已生成。可继续布置配件、设计镂空结构，再到“分析与导出”检查并导出。</p>}
        <div className="acc-body">
          <div className="acc-body-inner split-engine-body">
            {/* ---- 参数配置 (默认 = 宜家洞洞板标准) ----
                 刻意放在吸顶层之外：参数展开后高度可达数百像素，若留在 sticky 容器内，
                 吸顶层会铺满整个滚动视口，其下方的板件列表将永远滚不到可见区域。 */}
            <div className="workbench-common-fields"><label>打印机<select value={printerPreset} onChange={e=>applyPrinterPreset(e.target.value)}><option value="custom">自定义</option><option value="generic-220">通用 220×220</option>{BAMBU_PRINTER_PRESETS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label><label>板厚（mm）<input type="number" min="0.5" step="0.5" value={splitConfig.thickness} onChange={e=>setSplitConfig({thickness:Math.max(.5,+e.target.value||.5)})}/></label></div>
            <section className={'split-config-section' + (configOpen ? ' open' : '')}>
              <button
                className="split-section-toggle"
                type="button"
                aria-expanded={configOpen}
                onClick={() => setConfigOpen(v => !v)}
                title={configOpen ? '收起高级分割参数' : '展开高级分割参数'}
              >
                <span className="split-section-icon">⚙</span>
                <span className="split-section-label">
                  <strong>高级分板与孔位设置</strong>
                  <small>有效打印区、孔位、圆角/倒角与板厚</small>
                </span>
                <span className="split-section-chevron">⌄</span>
              </button>
              {configOpen && (
              <div className="split-config-content">{hasPanels && <button type="button" onClick={()=>void runAutoSplit()} title="只清除当前分板结果；保留草图和分板参数，重新生成后才会得到新板件">清除当前板件结果</button>}
                <div className="split-config-grid">
              <div className="prop-item" title="打印机物理热床 X 尺寸；真正排盘边界还会扣除安全边距与禁放区">
                <span className="plabel">物理床宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={20} value={splitConfig.bedW}
                  onChange={e => setSplitConfig({ printerPreset: 'custom', bedW: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="打印机物理热床 Y 尺寸；真正排盘边界还会扣除安全边距与禁放区">
                <span className="plabel">物理床深</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={20} value={splitConfig.bedH}
                  onChange={e => setSplitConfig({ printerPreset: 'custom', bedH: Math.max(1, +e.target.value || 1) })} />
              </div>
              {([
                ['左安全边', 'bedMarginLeft'], ['右安全边', 'bedMarginRight'],
                ['下安全边', 'bedMarginBottom'], ['上安全边', 'bedMarginTop'],
              ] as const).map(([label, key]) => (
                <div className="prop-item" key={key} title={`${label}会从物理热床边界向内扣除，至少保留 ${MIN_PRINT_BED_MARGIN_MM} mm`}>
                  <span className="plabel">{label}</span>
                  <input key={`${key}-${splitConfig[key]}`} className="prop-num" style={{ width: 54 }} type="number" min={MIN_PRINT_BED_MARGIN_MM} step={0.5}
                    defaultValue={Math.max(MIN_PRINT_BED_MARGIN_MM, splitConfig[key])}
                    onBlur={e => {
                      const previous = Math.max(MIN_PRINT_BED_MARGIN_MM, splitConfig[key]), text = e.currentTarget.value.trim(), n = Number(text)
                      const next = text && Number.isFinite(n) && n >= MIN_PRINT_BED_MARGIN_MM ? n : previous
                      e.currentTarget.value = String(next)
                      if (next !== splitConfig[key]) setSplitConfig({ [key]: next })
                    }} onKeyDown={e => {
                      if (e.key === 'Escape') { e.currentTarget.value = String(Math.max(MIN_PRINT_BED_MARGIN_MM, splitConfig[key])); e.currentTarget.blur() }
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }} />
                </div>
              ))}
              <div className="prop-item" style={{ gridColumn: '1 / -1', alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
                <div className="split-printable-summary">
                  <span className="plabel" title="擦嘴、切刀、换料结构等不可打印区域">有效打印区</span>
                  <strong style={{ fontSize: 11, color: '#63dfce' }}>{printableBedDescription(splitConfig)}</strong>
                </div>
                {splitConfig.bedKeepouts.map(zone => (
                  <div key={zone.id} className="split-keepout-card">
                    <div className="split-keepout-heading">
                      <input type="checkbox" aria-label={`启用禁放区 ${zone.name}`} checked={zone.enabled} onChange={e => updateKeepout(zone.id, { enabled: e.target.checked })} />
                      <input className="prop-num" aria-label="禁放区名称" title="禁放区名称" value={zone.name} onChange={e => updateKeepout(zone.id, { name: e.target.value })} />
                      <button type="button" aria-label={`删除禁放区 ${zone.name}`} title="删除禁放区" onClick={() => setSplitConfig({ bedKeepouts: splitConfig.bedKeepouts.filter(item => item.id !== zone.id) })}>×</button>
                    </div>
                    <div className="split-keepout-fields">{([
                      ['x', 'X 位置'], ['y', 'Y 位置'], ['w', '宽度'], ['h', '高度'],
                    ] as const).map(([key, label]) => (
                      <label key={key}>{label} mm<input className="prop-num" aria-label={`禁放区 ${label} mm`}
                        type="number" step={1} min={key === 'w' || key === 'h' ? 0 : undefined} value={zone[key]}
                        onChange={e => updateKeepout(zone.id, { [key]: Math.max(0, +e.target.value || 0) })} /></label>
                    ))}</div>
                  </div>
                ))}
                <button type="button" onClick={() => setSplitConfig({
                  bedKeepouts: [...splitConfig.bedKeepouts, {
                    id: `keepout-${Date.now()}`, name: '自定义禁放区', x: 0, y: 0, w: 20, h: 20, enabled: true,
                  }],
                })}>＋ 添加禁放区</button>
              </div>
              <div className="prop-item" title="X 模数: 板宽必须是其整数倍">
                <span className="plabel">模数 X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.mx}
                  onChange={e => setSplitConfig({ mx: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="Y 模数: 板高必须是其整数倍">
                <span className="plabel">模数 Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.my}
                  onChange={e => setSplitConfig({ my: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="长圆孔阵列离板边的最小距离">
                <span className="plabel">边缘预留</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.edgeMargin}
                  onChange={e => setSplitConfig({ edgeMargin: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="防碎边: 小于此宽度的板放弃切割并合并">
                <span className="plabel">最小板宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.minW}
                  onChange={e => setSplitConfig({ minW: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="防碎边: 小于此高度的板放弃切割并合并">
                <span className="plabel">最小板高</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.minH}
                  onChange={e => setSplitConfig({ minH: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="规则分区优先避免出现小于该宽度的细长条、细颈和难固定板件">
                <span className="plabel">最小结构宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={5} value={splitConfig.minFeatureWidth}
                  onChange={e => setSplitConfig({ minFeatureWidth: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="内孔优先完整归属单板时，与分板接缝保留的安全距离；确实放不下会自动跨板">
                <span className="plabel">孔缝安全距</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={1} value={splitConfig.holeSeamClearance}
                  onChange={e => setSplitConfig({ holeSeamClearance: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="长圆孔和固定圆孔与外边、缺口、内孔之间至少保留的实体材料宽度；冲突孔会自动删除留白">
                <span className="plabel">孔边留白</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.holeBoundaryClearance}
                  onChange={e => setSplitConfig({ holeBoundaryClearance: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="内部垂直接缝圆孔线的默认内缩；非模数外周会对齐最近长孔列">
                <span className="plabel">固定孔偏移X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.jointOffsetX}
                  onChange={e => setSplitConfig({ jointOffsetX: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="内部水平接缝圆孔线的默认内缩；非模数外周会对齐最近长孔行">
                <span className="plabel">固定孔偏移Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.jointOffsetY}
                  onChange={e => setSplitConfig({ jointOffsetY: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="板件整体外轮廓凸角的平面圆角半径；拼接内角保持直角">
                <span className="plabel">轮廓圆角 R</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.cornerRadius}
                  onChange={e => setSplitConfig({ cornerRadius: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="3MF 制造模型上、下表面边缘的微倒角尺寸">
                <span className="plabel">制造倒角</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.05} value={splitConfig.manufacturingChamfer}
                  onChange={e => setSplitConfig({ manufacturingChamfer: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="竖向长圆孔总长 (长轴, 工程图 15.0)">
                <span className="plabel">槽长</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotLength}
                  onChange={e => setSplitConfig({ slotLength: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="竖向长圆孔宽度 (短轴 = 2×端部半径, 工程图 5.0)">
                <span className="plabel">槽宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotWidth}
                  onChange={e => setSplitConfig({ slotWidth: Math.max(0.5, +e.target.value || 0.5) })} />
              </div>
              <div className="prop-item" title="长圆孔两端圆弧半径，由槽宽自动计算">
                <span className="plabel">槽端半径</span>
                <span style={{ fontSize: 11, color: '#aab6c6' }}>R {(splitConfig.slotWidth / 2).toFixed(2)} mm</span>
              </div>
              <div className="prop-item" title="A 列胶囊中心 X 零位 (相对整板左下角, 工程图 10)">
                <span className="plabel">槽列起点X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotGridX0}
                  onChange={e => setSplitConfig({ slotGridX0: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="A 列胶囊中心 Y 零位 (工程图 30)">
                <span className="plabel">槽列起点Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotGridY0}
                  onChange={e => setSplitConfig({ slotGridY0: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="B 列相对 A 列 X 错位 (工程图 20)">
                <span className="plabel">槽列错位X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotStaggerX}
                  onChange={e => setSplitConfig({ slotStaggerX: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="B 列相对 A 列 Y 错位 (工程图 20)">
                <span className="plabel">槽列错位Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotStaggerY}
                  onChange={e => setSplitConfig({ slotStaggerY: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="边缘敲落圆孔直径（用户确认制造规格 φ5）">
                <span className="plabel">敲落孔直径</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.jointDiameter}
                  onChange={e => setSplitConfig({ jointDiameter: Math.max(1, +e.target.value || 1) })} />
              </div>

              <div className="prop-item" title="自动把推荐固定孔设为贯通孔；其余候选位置仅显示虚线，可在2D或3D中点击切换">
                <span className="plabel">推荐打孔</span>
                <input type="checkbox" checked={splitConfig.recommendKnockouts}
                  onChange={e => setSplitConfig({ recommendKnockouts: e.target.checked })} />
              </div>
              <div className="prop-item" title="拼装间隙 (公差预留)">
                <span className="plabel">拼装间隙</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.05} value={splitConfig.gapTolerance}
                  onChange={e => setSplitConfig({ gapTolerance: Math.max(0, +e.target.value || 0) })} />
              </div>
                </div>
                <div className="split-config-help">
              孔型 = 200×200 工程图 (SKÅDIS 20cm 板, 200.200边缘带孔.DXF): 竖向长圆孔 5.0×15.0、
              晶体错列阵列 (A/B 列族 40×40 周期, B 列错位 20/20, 锚定整板左下角);
              <strong>边缘 = 候选圆孔 φ5 一排</strong>（内部接缝默认内缩 10mm；外周对齐最近长孔行/列；沿边间距 40mm；
              未启用时只显示虚线位置提示，启用后直接贯穿整块板)。
              板宽=模数X整数倍, 板高=模数Y整数倍; 小于最小板宽/高的切割自动放弃并合并 (防碎边)。
              初始铺板完成后会自动执行<strong>边缘融合</strong>：相邻板的合并包围盒能放进热床时，
              可生成 L 型、阶梯型等正交异形板，优先减少板块、内部接缝和固定件占用。
              细长板会在<strong>扣除安全边距后的有效打印区</strong>内计算旋转投影，且真实轮廓不得进入擦嘴/机构禁放区；满足时允许对角排版并输出建议角度。
              内孔优先以“孔缝安全距”完整归属一块板；超过热床或无法避缝时自动跨板并逐板精确扣孔。
                </div>
              </div>
              )}
            </section>

            <AssemblyMarkingPanel />

            {/* 结果摘要与参数一起滚动，展开警告时不再被固定高度裁掉。 */}
            <div className="split-sticky-head">
              <div className="split-result-sticky">
                <div className="split-result-head">
                  <span className="split-result-title">▦ 分割结果</span>
                  <span className={'split-result-status' + (splitJob ? ' busy' : hasPanels ? ' ready' : '')}>
                    {splitJob ? '正在计算' : splitConfigChanged ? '参数待更新' : hasPanels ? `${splitResult!.panels.length} 块板` : splitWarnings.length ? '未生成' : '等待生成'}
                  </span>
                </div>
                {splitJob ? (
                  <div className="split-empty-result is-busy" aria-live="polite">
                    <span className="split-busy-spinner" aria-hidden="true" />
                    <strong>{splitJob.phase === 'committing' ? '正在载入板件' : '正在后台分割'}</strong>
                    <span>已处理 {splitJob.completed} / {splitJob.total} 个外轮廓{hasPanels ? ' · 原结果暂时保留' : ''}</span>
                  </div>
                ) : (!splitResult || !hasPanels) ? (
                  <div className="split-empty-result">
                    <span className="split-empty-icon">▦</span>
                    <strong>还没有分割结果</strong>
                    <span>选择一个板型，或绘制闭合外轮廓，再点击“生成板件”。</span>

                  </div>
                ) : (
                  <>
                    <div className="split-result-summary">
                      <span className="split-result-summary-text">
                        共 {splitResult.panels.length} 块板
                        {splitResult.panels.some(p => (p.contour?.length ?? 0) > 4)
                          ? ` · ${splitResult.panels.filter(p => (p.contour?.length ?? 0) > 4).length} 块已边缘融合`
                          : ''}
                        {' · '}支持方孔/圆孔/跨板孔
                      </span>
                      <span className="split-export-location" title="在“检查与导出”中输出模型">
                        在“检查与导出”中输出模型
                      </span>
                    </div>
                    {(() => {
                      // 首屏只显示 3 条，其余可用鼠标或键盘展开。
                      const shown = splitResult.warnings.slice(0, 3)
                      const rest = splitResult.warnings.length - shown.length
                      return (
                        <>
                          {shown.map((w, i) => (
                            <div key={i} style={{ fontSize: 11, color: '#e8b84b', margin: '2px 0' }}>⚠ {w}</div>
                          ))}
                          {rest > 0 && (
                            <details className="split-more-warnings"><summary>⚠ 还有 {rest} 条提示</summary>
                              {splitResult.warnings.slice(3).map((warning, i) => <p key={i}>{warning}</p>)}
                            </details>
                          )}
                        </>
                      )
                    })()}
                    <div className="split-source-overview" aria-label="轮廓分割摘要">
                      {splitResult.sources.map(src => (
                        <div key={src.contourId} className="split-source-overview-row">
                          <span>📐 {src.name}</span>
                          <span>{src.panels.length} 块 · 覆盖率 {(src.coverageRatio * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ---- 只有板件明细参与滚动 ---- */}
            {hasPanels && <section className="split-result-section">
              {splitResult && (
                <div className="split-board-list">
                  {(() => {
                    const PALETTE = ['#3ec6b0', '#ffd166', '#b39ddb', '#5ea4ff']
                    let globalIdx = 0
                    return splitResult.sources.map(src => {
                      const base = globalIdx
                      globalIdx += src.panels.length
                      return (
                        <div key={src.contourId} style={{ marginTop: 6 }}>
                          {src.panels.map((p, i) => {
                            const dot = PALETTE[(base + i) % PALETTE.length]
                            return (
                              <div key={p.id} className="split-panel-row split-panel-row-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                                <span className="split-panel-identity">
                                  <strong className="split-panel-badge" style={{ background: dot }}>{p.id.toUpperCase()}</strong>
                                  <span className="split-panel-size">{Number(p.w.toFixed(2))} × {Number(p.h.toFixed(2))} mm</span>
                                  {(p.contour?.length ?? 0) > 4 && <span className="split-panel-fused">融合</span>}
                                  {(p.printRotation ?? 0) > 0 && <span className="split-panel-fused">排版 {p.printRotation}°</span>}
                                </span>
                                <span className="split-panel-coords">@ ({p.x}, {p.y})</span>
                                <span className="split-panel-meta">长孔 {p.slots.length}{p.round_holes.length > 0 && <> · 圆孔 {p.round_holes.length}</>}{(p.closed_holes?.length ?? 0) > 0 && <> · 已关闭 {p.closed_holes!.length}</>} · 内孔 {p.cutouts?.length ?? 0} · 拼接孔 {p.edge_holes.length}</span>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })
                  })()}
                </div>
              )}
            </section>}
          </div>
        </div>
      </section>}

      {/* ============ 配件库 ============ */}
      {activeWorkspace === 'parts' && <section className="acc expanded right-workspace-content">
        <div className="acc-body">
          <div className="acc-body-inner">
            <MountScenePanel />
            <PartLibraryPanel onDragPart={handleDragPart} onDragEnd={handleDragEnd} headerless splitLayout />
          </div>
        </div>
      </section>}
      {activeWorkspace === 'texture' && <TextureStudio docked />}
      {activeWorkspace === 'occlusion' && (inspectionHost ? createPortal(spatialLayout.enabled ? <SpatialManufacturingPanel/> : <section className="acc expanded right-workspace-content occlusion-workspace">
        <div className="acc-body">
          <div className="acc-body-inner occlusion-workspace-scroll">
            <div className="manufacturing-inspection-tabs" role="tablist" aria-label="制造检查方式"><button type="button" role="tab" aria-selected={inspectionTab==='layers'} onClick={()=>setInspectionTab('layers')}>材料结构</button><button type="button" role="tab" aria-selected={inspectionTab==='assembly'} onClick={()=>setInspectionTab('assembly')}>装配检查</button></div>
            <div hidden={inspectionTab!=='layers'}><Suspense fallback={<p role="status">正在载入材料结构…</p>}><LayerPreviewPanel/></Suspense></div>
            <div hidden={inspectionTab!=='assembly'}>
            <OcclusionPreviewPanel
              report={occlusionReport}
              mode={occlusionMode}
              onModeChange={setOcclusionMode}
              overlayEnabled={occlusionOverlayEnabled}
              onOverlayEnabledChange={setOcclusionOverlayEnabled}
              textureVisibilityRatio={occlusionReport?.textureVisibleRatio ?? null}
            />
            <LayoutAdvisorPanel
              suggestions={layoutUiSuggestions}
              candidateTotal={layoutSuggestions.length}
              hasSplitResult={Boolean(splitResult?.panels.length)}
              onFocusSuggestion={suggestion => window.dispatchEvent(new CustomEvent('snapboard:focus-layout-suggestion', {
                detail: { x: suggestion.x, y: suggestion.y, id: suggestion.id },
              }))}
            />
            </div>
          </div>
        </div>
      </section>,inspectionHost) : null)}
    </div>
  )
}
