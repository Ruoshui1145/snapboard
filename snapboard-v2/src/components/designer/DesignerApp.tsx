import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { MerchantLicenseStatus } from '../licensing/MerchantLicenseStatus'
import { Toolbar } from '../toolbar/Toolbar'
import { FarmOrders } from '../farm/FarmOrders'
import { Sidebar } from '../sidebar/Sidebar'
import { RightSidebar } from '../sidebar/RightSidebar'
import { SketchViewport2D } from '../viewport/SketchViewport2D'
import { HoleEditor } from '../viewport/HoleEditor'
import { Viewport3D } from '../viewport/Viewport3D'
import { RadialWheel, useRadialWheel } from '../viewport/RadialWheel'
import { useSketchTool } from '../../hooks/useSketchTool'
import { RemoveContourCommand } from '../../commands/SketchCommands'
import { CompositeCommand } from '../../commands/Command'
import { bindSketchClipboard, duplicateSketchSelection } from '../../commands/SketchClipboard'
import { RemovePartCommand } from '../../commands/BoardCommands'
import { getProjectStorageStatus, subscribeProjectStorageStatus } from '../../utils/projectStorageStatus'
import { ContextualTip } from './ContextualTip'
import { BrandWatermark } from './BrandWatermark'
import { currentWorkspace, isWorkspaceAvailable, workspaceSelection, type WorkbenchWorkspace } from '../../utils/workbenchNavigation'
import { SettingsDialog, type SettingsTab } from '../settings/SettingsDialog'
import {BoardDesignPanel,type BoardDesignMode} from '../shapeLibrary/BoardDesignPanel'
import { SpatialFaceOverview } from '../sidebar/SpatialFaceOverview'
import { SpatialLayoutDesignPanel } from '../sidebar/SpatialLayoutPanel'
import { applyShapeDraft } from '../../features/shapeLibrary/applyShape'
import type {ShapeDraft,ShapeApplicationMode} from '../../features/shapeLibrary/model'
import '../../App.css'
import '../../workbench.css'

interface DesignerAppProps {
  websiteUrl: string
}

interface WorkbenchLayout {
  leftCollapsed: boolean
  rightCollapsed: boolean
  toolbarCollapsed: boolean
  leftWidth: number
  rightWidth: number
}

const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = {
  leftCollapsed: false,
  rightCollapsed: false,
  toolbarCollapsed: false,
  leftWidth: 278,
  rightWidth: 296,
}

/** 单侧栏最多可占用的视口宽度比例；两栏合计不超过 56%，保证中央画布始终可用。 */
const SIDEBAR_VIEWPORT_RATIO = 0.28
/** 低于该视口宽度时自动收起左栏：优先保住画布区域。 */
const AUTO_COLLAPSE_LEFT_BELOW = 1024

const responsiveSidebarDefaults = (viewportWidth: number) => {
  if (viewportWidth >= 1600) return { left: 300, right: 320 }
  if (viewportWidth >= 1400) return { left: 278, right: 300 }
  if (viewportWidth >= 1200) return { left: 260, right: 320 }
  if (viewportWidth >= 1024) return { left: 232, right: 340 }
  return { left: 220, right: 340 }
}

/**
 * 把侧栏宽度约束在「绝对上下限」与「视口比例上限」的交集内。
 * 原先只做固定区间钳制，用户在宽屏上把侧栏拖到 420px 后，换到 1280px
 * 笔记本打开时两栏会吃掉 880px，画布仅剩约 376px，出现显示不全。
 */
const resolveSidebarWidth = (
  saved: number,
  fallback: number,
  min: number,
  max: number,
  viewportWidth: number,
  ratio = SIDEBAR_VIEWPORT_RATIO,
) => {
  const base = Number(saved) || fallback
  const viewportMax = Math.max(min, Math.round(viewportWidth * ratio))
  return Math.round(Math.max(min, Math.min(base, max, viewportMax)))
}

const readViewportWidth = () =>
  typeof window === 'undefined' ? 1440 : window.innerWidth

const readRecentShapePresets = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem('snapboard-recent-shape-presets') ?? '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

const loadWorkbenchLayout = (): WorkbenchLayout => {
  const viewportWidth = readViewportWidth()
  const defaults = responsiveSidebarDefaults(viewportWidth)
  const rightMin = viewportWidth >= 1200 ? 320 : 250
  try {
    const saved = JSON.parse(localStorage.getItem('snapboard-workbench-layout-board-v1') ?? '{}') as Partial<WorkbenchLayout>
    const leftCollapsed = saved.leftCollapsed === true
    return {
      // 窄屏首次进入时强制收起左栏，避免默认布局直接挤爆画布。
      leftCollapsed: viewportWidth < AUTO_COLLAPSE_LEFT_BELOW ? true : leftCollapsed,
      rightCollapsed: viewportWidth < AUTO_COLLAPSE_LEFT_BELOW ? true : saved.rightCollapsed === true,
      toolbarCollapsed: saved.toolbarCollapsed === true,
      leftWidth: resolveSidebarWidth(Number(saved.leftWidth), defaults.left, 220, 420, viewportWidth),
      rightWidth: resolveSidebarWidth(Math.max(Number(saved.rightWidth) || 0, rightMin), defaults.right, rightMin, 460, viewportWidth, .34),
    }
  } catch {
    return {
      ...DEFAULT_WORKBENCH_LAYOUT,
      leftCollapsed: viewportWidth < AUTO_COLLAPSE_LEFT_BELOW,
      rightCollapsed: viewportWidth < AUTO_COLLAPSE_LEFT_BELOW,
      leftWidth: defaults.left,
      rightWidth: defaults.right,
    }
  }
}

export default function DesignerApp({ websiteUrl }: DesignerAppProps) {
  useEffect(bindSketchClipboard, [])
  const viewMode = useAppStore(s => s.ui.viewMode)
  const workspace = useAppStore(s => currentWorkspace(s.ui, s.spatialLayout.enabled))
  const structureCandidate = useAppStore(s => Boolean(s.ui.structurePreviewPanels?.length))
  const setUI = useAppStore(s => s.setUI)
  const projectName = useAppStore(s => s.project.metadata.name)
  const spatialEnabled = useAppStore(s => s.spatialLayout.enabled)
  const holeEditMode = useAppStore(s => s.holeEditMode)
  const [drawingOpen, setDrawingOpen] = useState(false)
  const [reduceTransparency, setReduceTransparency] = useState(()=>localStorage.getItem('snapboard-reduce-transparency')==='true')
  const [boardMode,setBoardMode]=useState<BoardDesignMode>('presets')
  const [boardPreview,setBoardPreview]=useState<ReactNode>(null)
  const [mounted3D, setMounted3D] = useState(false)
  const [show3DTransition, setShow3DTransition] = useState(true)
  useEffect(() => { if (viewMode === '2d') setShow3DTransition(true) }, [viewMode])
  // Keep the initialized WebGL scene across view switches; the first mount is
  // deferred for two frames so the loading state paints before mesh creation.
  useEffect(() => {
    if (viewMode !== '3d' || mounted3D) return
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setMounted3D(true)) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [viewMode, mounted3D])
  const selectWorkspace = (next: WorkbenchWorkspace) => {
    if (!isWorkspaceAvailable(next, useAppStore.getState().spatialLayout.enabled)) return
    setUI({...workspaceSelection(next), viewMode: next === 'board' && !useAppStore.getState().spatialLayout.enabled ? '2d' : '3d'})
    setLayout(current=>({...current,leftCollapsed:false,rightCollapsed:readViewportWidth()<AUTO_COLLAPSE_LEFT_BELOW}))
  }

  const [layout, setLayout] = useState(loadWorkbenchLayout)
  useEffect(() => {
    if (holeEditMode) setLayout(current => current.rightCollapsed ? { ...current, rightCollapsed: false } : current)
  }, [holeEditMode])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance')
  const [projectPanelOpen, setProjectPanelOpen] = useState(false)
  const [recentShapePresetIds, setRecentShapePresetIds] = useState(readRecentShapePresets)
  /** 上一次观测到的窄屏状态，用于只在「由宽变窄」的瞬间自动收起左栏。 */
  const wasNarrowRef = useRef(readViewportWidth() < AUTO_COLLAPSE_LEFT_BELOW)
  const { handleClick, handleMove, handleDown, handleUp, handleDoubleClick, handleKeyDown, preview, hint, hoverConstraint } = useSketchTool()
  const wheel = useRadialWheel()


  const applyShapeFromLibrary = useCallback(async (
    draft: ShapeDraft,
    mode: ShapeApplicationMode,
  ) => {
    const state = useAppStore.getState()
    if (mode === 'replace-outer') {
      const contourCount = state.project.parts.flatMap(part => part.features)
        .filter(feature => feature.type === 'sketch')
        .reduce((sum, feature) => sum + (feature.type === 'sketch' ? feature.contours.length : 0), 0)
      const derivedCount = state.boards.length
        + state.placedParts.length
        + state.assemblyScene.placements.length
        + (state.splitResult ? 1 : 0)
        + (state.boardTexture.enabled || state.boardTexture.imageDataUrl ? 1 : 0)
      if ((contourCount > 0 || derivedCount > 0) && !window.confirm(
        `应用新板型会替换当前 ${contourCount} 个草图轮廓，并清理依附旧板的分割、配件和纹理状态。\n可使用一次撤销完整恢复，是否继续？`,
      )) throw new Error('已取消替换，当前设计没有变化')
    }

    applyShapeDraft(draft, mode)
    if (draft.source.kind === 'preset' && draft.source.id) {
      const presetId = draft.source.id
      setRecentShapePresetIds(current => {
        const next = [presetId, ...current.filter(id => id !== presetId)].slice(0, 8)
        try { localStorage.setItem('snapboard-recent-shape-presets', JSON.stringify(next)) } catch { /* ignore */ }
        return next
      })
    }
    setBoardPreview(null)
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('snapboard:fit-active-sketch')))
  }, [])

  useEffect(() => {
    localStorage.setItem('snapboard-workbench-layout-board-v1', JSON.stringify(layout))
  }, [layout])

  // 视口尺寸变化时重新约束侧栏宽度：在宽屏上拖宽过的侧栏，缩窗后必须让位给画布。
  // 只在「由宽变窄」的一刻收起两栏；之后保留用户手动展开的选择。
  useEffect(() => {
    let frame = 0
    const applyViewportConstraint = () => {
      const viewportWidth = readViewportWidth()
      const isNarrow = viewportWidth < AUTO_COLLAPSE_LEFT_BELOW
      const crossedToNarrow = isNarrow && !wasNarrowRef.current
      wasNarrowRef.current = isNarrow

      setLayout(current => {
        const defaults = responsiveSidebarDefaults(viewportWidth)
        const rightMin = viewportWidth >= 1200 ? 320 : 250
        const leftWidth = resolveSidebarWidth(current.leftWidth, defaults.left, 220, 420, viewportWidth)
        const rightWidth = resolveSidebarWidth(Math.max(current.rightWidth, rightMin), defaults.right, rightMin, 460, viewportWidth, .34)
        const leftCollapsed = crossedToNarrow ? true : current.leftCollapsed
        const rightCollapsed = crossedToNarrow ? true : current.rightCollapsed
        if (
          leftWidth === current.leftWidth
          && rightWidth === current.rightWidth
          && leftCollapsed === current.leftCollapsed
          && rightCollapsed === current.rightCollapsed
        ) return current
        return { ...current, leftWidth, rightWidth, leftCollapsed, rightCollapsed }
      })
    }
    const onResize = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(applyViewportConstraint)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    const expandRight = () => setLayout(current => ({
      ...current,
      leftCollapsed: readViewportWidth() < AUTO_COLLAPSE_LEFT_BELOW ? true : current.leftCollapsed,
      rightCollapsed: false,
    }))
    window.addEventListener('snapboard:expand-right-panel', expandRight)
    return () => window.removeEventListener('snapboard:expand-right-panel', expandRight)
  }, [])

  useEffect(() => {
    const openSettings = (event: Event) => {
      setSettingsTab((event as CustomEvent<{tab?:SettingsTab}>).detail?.tab ?? 'parts')
      setSettingsOpen(true)
    }
    window.addEventListener('snapboard:open-settings', openSettings)
    return () => window.removeEventListener('snapboard:open-settings', openSettings)
  }, [])

  const beginSidebarResize = (side: 'left' | 'right', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'left' ? layout.leftWidth : layout.rightWidth
    const rightMin = readViewportWidth() >= 1200 ? 320 : 250
    document.body.classList.add('is-resizing-workbench')
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      const width = side === 'left' ? startWidth + delta : startWidth - delta
      const collapseAt = side === 'left' ? 118 : 138
      setLayout(current => ({
        ...current,
        [side === 'left' ? 'leftCollapsed' : 'rightCollapsed']: width < collapseAt,
        [side === 'left' ? 'leftWidth' : 'rightWidth']: width < collapseAt
          ? current[side === 'left' ? 'leftWidth' : 'rightWidth']
          : Math.max(side === 'left' ? 220 : rightMin, Math.min(side === 'left' ? 420 : 460, width)),
      }))
    }
    const onUp = () => {
      document.body.classList.remove('is-resizing-workbench')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  const workspaceStyle = {
    '--left-sidebar-width': workspace==='parts'?'220px':`${layout.leftWidth}px`,
    '--right-sidebar-width': workspace==='parts'?'360px':`${layout.rightWidth}px`,
  } as CSSProperties

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      const s = useAppStore.getState()
      const ctrl = e.ctrlKey || e.metaKey
      const el = document.activeElement as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return

      if (e.key === 'Escape' && s.ui.viewMode === '3d') {
        s.setUI({ selectedPartId: null })
        return
      }
      if (handleKeyDown(e)) return

      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); if(e.shiftKey)s.redo();else s.undo(); return }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return }
      if (ctrl && e.key.toLowerCase() === 'd' && currentWorkspace(s.ui) === 'board' && s.ui.viewMode === '2d') { e.preventDefault(); duplicateSketchSelection(); return }
      if (ctrl && e.key.toLowerCase() === 'a' && currentWorkspace(s.ui) === 'board' && s.ui.viewMode === '2d' && !s.holeEditMode) {
        e.preventDefault()
        window.getSelection()?.removeAllRanges()
        const sketches = s.project.parts.flatMap(part=>part.features).filter(feature=>feature.type==='sketch')
        const sketch = sketches.find(feature=>feature.id===s.ui.activeSketchId) ?? sketches[0]
        const ids = sketch?.contours.map(contour=>contour.id) ?? []
        s.setUI({activeTool:'select',selectedContourIds:ids,selectedContourId:ids[0]??null,selectedConstraintId:null})
        return
      }
      if (ctrl) return

      const toolMap: Record<string, string> = {
        v: 'select', p: 'line', r: 'rect', c: 'circle', a: 'arc',
        g: 'polygon', s: 'slot', o: 'offset', e: 'eraser', d: 'smartdim',
      }
      const tool = toolMap[e.key.toLowerCase()]
      if (tool) s.setUI({ activeTool: tool as never })
      if (e.key === 'Escape') {
        s.setUI({ selectedContourId: null, selectedFeatureId: null, selectedPartId: null })
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.ui.viewMode === '3d' && s.ui.selectedPartId) {
        e.preventDefault()
        s.execute(new RemovePartCommand(s.ui.selectedPartId))
        s.setUI({ selectedPartId: null })
        return
      }
      const selectedContourIds = s.ui.selectedContourIds.length > 0
        ? s.ui.selectedContourIds
        : s.ui.selectedContourId ? [s.ui.selectedContourId] : []
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedContourIds.length > 0) {
        e.preventDefault()
        const commands = selectedContourIds.map(id => new RemoveContourCommand(id))
        s.execute(commands.length === 1 ? commands[0] : new CompositeCommand('删除选择组', commands))
        s.setUI({ selectedContourIds: [], selectedConstraintId: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleKeyDown])

  return (
    <div className={`designer-shell workbench-v1 mode-${viewMode} workspace-${workspace}${reduceTransparency ? ' reduce-transparency' : ''}`}>
      <div className="designer-aurora" aria-hidden="true">
        <span className="designer-aurora-orb orb-primary" />
        <span className="designer-aurora-orb orb-secondary" />
      </div>
          <header className="designer-brandbar">
        <div className="designer-brand-lockup">
          <span className="designer-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="designer-brand-copy">
            <b>SnapBoard</b>
            <small>轻量设计台</small>
          </span>
        </div>
        <nav className="workbench-nav" aria-label="设计工作区">{([
          ['board','板材设计','01'],['appearance','纹理工作室','02'],['parts','配件库','03'],['structure','镂空结构','04'],['inspect','分析与导出','05'],
        ] as const).map(([id,label,n])=><button key={id} type="button" disabled={!isWorkspaceAvailable(id,spatialEnabled)} title={!isWorkspaceAvailable(id,spatialEnabled)?'立体版面暂不支持此流程':undefined} aria-current={workspace===id?'page':undefined} className={workspace===id?'active':''} onClick={()=>selectWorkspace(id)}><span>{n}</span>{id==='inspect'&&spatialEnabled?'制造与导出':label}</button>)}</nav>
        <div className="designer-head-actions">
          <MerchantLicenseStatus />
          <details className="workbench-project-menu" onToggle={event => setProjectPanelOpen(event.currentTarget.open)}>
            <summary aria-label="工程内容与属性"><span>工程</span><b data-i18n-ignore="true">{projectName || '未命名项目'}</b><i aria-hidden="true">▾</i></summary>
            <div className="workbench-project-popover">{projectPanelOpen && <Sidebar />}</div>
          </details>
          <a className="designer-site-back" href={websiteUrl} target="_blank" rel="noopener noreferrer" aria-label="打开 SnapBoard 官网" title="在浏览器打开官网">
            <span aria-hidden="true">S</span>
            <span>官网</span>
          </a>
          <button className="workbench-settings-button" type="button" onClick={()=>{setSettingsTab('appearance');setSettingsOpen(true)}} aria-label="打开设置" title="设置">⚙</button>
        </div>
      </header>
      <div className="designer-app-frame" style={workspaceStyle}>
        <div className="designer-main-column">
        {import.meta.env.VITE_SNAPBOARD_EDITION !== 'diy' && <FarmOrders />}

        <div className="designer-workspace">
        <div className={`workspace-panel workspace-panel-left workbench-library${layout.leftCollapsed ? ' is-collapsed' : ''}`}>
          {layout.leftCollapsed ? (
            <button type="button" className="workspace-rail" onClick={() => setLayout(current => ({ ...current, leftCollapsed: false, rightCollapsed: readViewportWidth()<AUTO_COLLAPSE_LEFT_BELOW?true:current.rightCollapsed }))} aria-label="展开设计与内容侧栏" aria-expanded={false}>
              <span>◧</span><b>工具</b><small>展开</small>
            </button>
          ) : <>
            <div className="workbench-task-header"><h2>{workspace==='board'?'版面设计':workspace==='appearance'?'纹理来源':workspace==='parts'?'配件分类':workspace==='structure'?'镂空方式与骨架':spatialEnabled?'制造导出':'分析导航'}</h2><button type="button" className="workspace-collapse-button" onClick={()=>setLayout(current=>({...current,leftCollapsed:true}))} aria-label="收起设计与内容侧栏" aria-expanded={true}>‹ 收起</button></div>
            {workspace!=='board'&&workspace!=='structure'&&<RightSidebar workspace={workspace}/>}
          </>}
          {workspace==='structure'&&<div className="structure-panel-host" hidden={layout.leftCollapsed}><RightSidebar workspace="structure"/></div>}
          {workspace==='board'&&<div className="board-panel-host" hidden={layout.leftCollapsed}>
            <label className="board-space-select"><span>版面类型</span>
              <select aria-label="版面类型" value={spatialEnabled?'spatial':'planar'} onChange={event=>{
                  const enabled=event.target.value==='spatial'
                  if(enabled!==spatialEnabled)useAppStore.getState().setSpatialLayout({enabled})
                  setUI({viewMode:enabled?'3d':'2d',activeTool:'select'})
                }}><option value="planar">平面版面</option><option value="spatial">立体版面</option></select>
            </label>
            {spatialEnabled&&<p className="spatial-workflow-note" role="status">立体版面：调整参数、查看模型并导出制造文件。</p>}
            {spatialEnabled
              ? <div className="spatial-design-scroll"><SpatialLayoutDesignPanel/><SpatialFaceOverview/></div>
              : <BoardDesignPanel mode={boardMode} onModeChange={next=>{setBoardMode(next);setDrawingOpen(next==='draw');if(next==='draw')setUI({viewMode:'2d'})}} onPreview={setBoardPreview} onApply={applyShapeFromLibrary} recentIds={recentShapePresetIds}/>}
          </div>}
        </div>
        {!layout.leftCollapsed && <div className="workspace-resizer left" role="separator" aria-label="调整左栏宽度" onPointerDown={event => beginSidebarResize('left', event)} />}
        <main className="designer-viewport-frame">
          <Toolbar
            onEditHoles={() => { setUI(workspaceSelection('board')); setLayout(current => ({ ...current, rightCollapsed: false })); setDrawingOpen(false) }}
            drawingOpen={workspace === 'board' && viewMode === '2d' && drawingOpen}
            onToggleDrawing={()=>{if(spatialEnabled)useAppStore.getState().setSpatialLayout({enabled:false});selectWorkspace('board');setBoardMode('draw');setDrawingOpen(v=>!v)}}
            collapsed={layout.toolbarCollapsed}
            onToggleCollapsed={() => setLayout(current => ({ ...current, toolbarCollapsed: !current.toolbarCollapsed }))}
          />
          <div className="designer-viewport-label" aria-hidden="true">
            <span>{viewMode === '2d' ? 'PRECISION CANVAS' : 'SPATIAL PREVIEW'}</span>
            <i />
            <small>{viewMode === '2d' ? '毫米级参数化工作区' : '实时装配与结构检查'}</small>
          </div>
          <div className={workspace==='board'?'board-canvas-content':'workbench-canvas-content'}>
          <BrandWatermark />
          {workspace==='structure'&&structureCandidate&&<div className="lattice-candidate-banner" role="status">当前为试看方案 · 尚未写入工程，保存、导出仍使用工程中的原方案</div>}
          <ContextualTip />
          <div className={`designer-2d-layer${viewMode === '2d' ? '' : ' is-hidden'}`}>
            <SketchViewport2D
              active={viewMode === '2d'}
              onCanvasClick={handleClick}
              onCanvasMove={handleMove}
              onCanvasMouseDown={handleDown}
              onCanvasMouseUp={handleUp}
              onCanvasDoubleClick={handleDoubleClick}
              preview={preview}
              hint={hint}
              hoverConstraintId={hoverConstraint?.constraintId ?? null}
            />
          </div>
          {mounted3D && <div className={`designer-3d-layer${viewMode === '3d' ? '' : ' is-hidden'}`}>
            <Viewport3D active={viewMode === '3d'} onReady={() => setShow3DTransition(false)} onFrame={() => setShow3DTransition(false)} />
          </div>}
          {viewMode === '3d' && show3DTransition && <div className="designer-3d-loading" role="status" aria-live="polite">
            <strong>正在准备 3D 视图…</strong><span>正在载入板件与装配场景</span><div className="designer-3d-loading-bar" aria-hidden="true"><i /></div>
          </div>}
          {boardPreview && workspace==='board' && !spatialEnabled && <aside className="board-main-preview" aria-label="候选轮廓预览"><span>候选轮廓 · 尚未应用</span>{boardPreview}</aside>}
          </div>
        </main>
        {!layout.rightCollapsed && <div className="workspace-resizer right" role="separator" aria-label="调整右栏宽度" onPointerDown={event => beginSidebarResize('right', event)} />}
        </div>
      </div>
      <div className={`designer-right-column workbench-inspector${layout.rightCollapsed ? ' is-collapsed' : ''}`}>
        {layout.rightCollapsed ? (
          <button type="button" className="workspace-rail" onClick={() => setLayout(current => ({ ...current, rightCollapsed: false, leftCollapsed: readViewportWidth()<AUTO_COLLAPSE_LEFT_BELOW?true:current.leftCollapsed }))} aria-label="展开板件结果侧栏" aria-expanded={false}>
            <span>◨</span><b>属性</b><small>展开</small>
          </button>
        ) : <><div className="workbench-task-header"><h2>{workspace === 'board' ? spatialEnabled ? '立体制造与结果' : '板件生成与结果' : workspace === 'appearance' ? '外观参数' : workspace === 'parts' ? '配件预览与选择' : workspace === 'structure' ? '镂空参数与结果' : spatialEnabled ? '制造参数' : '项目检查'}</h2><button type="button" className="workspace-collapse-button" onClick={() => setLayout(current => ({ ...current, rightCollapsed: true }))} aria-label="收起板件结果侧栏" aria-expanded={true}>收起 ›</button></div>{workspace === 'board' && <><HoleEditor /><RightSidebar workspace="board" pendingDesign={!!boardPreview}/></>}</>}
        {workspace !== 'board' && <div id={workspace==='structure'?'workbench-structure-inspector':workspace==='parts'?'workbench-part-grid':'workbench-properties'} hidden={layout.rightCollapsed}>{workspace!=='structure'&&<p className="workbench-property-hint">{workspace === 'parts' ? '' : workspace === 'appearance' ? '选择左侧外观来源，在这里调整效果。' : spatialEnabled ? '查看制造参数和安全空间。' : '左侧可查看分析建议并导出。'}</p>}</div>}
      </div>
    </div>
    <RadialWheel state={wheel} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} reduceTransparency={reduceTransparency}
        onTransparencyChange={next=>{setReduceTransparency(next);localStorage.setItem('snapboard-reduce-transparency',String(next))}}
        onResetLayout={()=>{const defaults=responsiveSidebarDefaults(readViewportWidth());setLayout({...DEFAULT_WORKBENCH_LAYOUT,leftWidth:defaults.left,rightWidth:defaults.right})}} />
      <StatusBar />
    </div>
  )
}

function StatusBar() {
  const project = useAppStore(s => s.project)
  const ui = useAppStore(s => s.ui)
  const storage = useSyncExternalStore(
    subscribeProjectStorageStatus,
    getProjectStorageStatus,
    getProjectStorageStatus,
  )
  const toolNames: Record<string, string> = {
    select: '选择', line: '直线', rect: '矩形', circle: '圆', arc: '弧',
    polygon: '多边形', slot: '槽口', offset: '等距实体', eraser: '擦除', smartdim: '智能尺寸',
  }
  const contourCount = project.parts.flatMap(p => p.features)
    .filter(f => f.type === 'sketch')
    .reduce((n, f) => n + (f.type === 'sketch' ? f.contours.length : 0), 0)

  return (
    <div className="stbar">
      <span>工具: <span className="accent">{toolNames[ui.activeTool]}</span>
        {ui.activeTool === 'line' && (ui.lineSubMode === 'centerline' ? ' · 辅助线' : ' · 直线')}
        {ui.activeTool === 'rect' && (ui.rectSubMode === 'center' ? ' · 中心矩形' : ui.rectSubMode === '3point' ? ' · 三点矩形' : ' · 两点矩形')}
        {ui.activeTool === 'circle' && (ui.circleSubMode === '3point' ? ' · 三点圆' : ' · 圆心圆')}
        {ui.activeTool === 'arc' && (ui.arcSubMode === 'arcCenter' ? ' · 圆心弧' : ' · 三点弧')}
        {ui.activeTool === 'eraser' && (ui.eraserMode === 'sweep' ? ' · 快速擦除' : ' · 点擦除')}
        {ui.activeTool === 'polygon' && ` · ${ui.polygonSides}边 · ${ui.polygonCircumscribed ? '外切' : '内切'}`}
      </span>
      <span>轮廓: {contourCount}</span>
      <span>新建: {ui.newContourType === 'inner' ? '内轮廓(开孔)' : '外轮廓'}</span>
      <span>模式: {ui.viewMode === '2d' ? '2D 草图' : '3D'}</span>
      <span className="stbar-projects" title={storage.recentProjects.length ? storage.recentProjects.join('、') : '当前项目库暂无已保存工程'}>
        项目: <span className="accent" data-i18n-ignore="true">{project.metadata.name}</span>
        {' · '}保存位置: {storage.label}
        {' · '}{storage.needsPermission ? '待授权' : `已保存 ${storage.projectCount} 个`}
        {storage.recentProjects.length > 0 && ` · 最近：${storage.recentProjects.join('、')}`}
      </span>
      <span style={{ marginLeft: 'auto' }}>
        V选择 P直线 R矩形 C圆 A弧 G多边形 S槽口 O等距 E擦除 D尺寸 | 原点/端点吸附 · 水平/竖直对齐参考线 | 悬停标注点数字改值
      </span>
    </div>
  )
}
