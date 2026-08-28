import { useEffect, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { Toolbar } from '../toolbar/Toolbar'
import { Sidebar } from '../sidebar/Sidebar'
import { RightSidebar } from '../sidebar/RightSidebar'
import { SketchViewport2D } from '../viewport/SketchViewport2D'
import { Viewport3D } from '../viewport/Viewport3D'
import { RadialWheel, useRadialWheel } from '../viewport/RadialWheel'
import { useSketchTool } from '../../hooks/useSketchTool'
import { RemoveContourCommand } from '../../commands/SketchCommands'
import { RemovePartCommand } from '../../commands/BoardCommands'
import { getProjectStorageStatus, subscribeProjectStorageStatus } from '../../utils/projectStorageStatus'
import '../../App.css'

interface DesignerAppProps {
  onBackHome: () => void
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

const loadWorkbenchLayout = (): WorkbenchLayout => {
  try {
    const saved = JSON.parse(localStorage.getItem('snapboard-workbench-layout') ?? '{}') as Partial<WorkbenchLayout>
    return {
      leftCollapsed: saved.leftCollapsed === true,
      rightCollapsed: saved.rightCollapsed === true,
      toolbarCollapsed: saved.toolbarCollapsed === true,
      leftWidth: Math.max(220, Math.min(420, Number(saved.leftWidth) || DEFAULT_WORKBENCH_LAYOUT.leftWidth)),
      rightWidth: Math.max(250, Math.min(460, Number(saved.rightWidth) || DEFAULT_WORKBENCH_LAYOUT.rightWidth)),
    }
  } catch {
    return DEFAULT_WORKBENCH_LAYOUT
  }
}

export default function DesignerApp({ onBackHome }: DesignerAppProps) {
  const viewMode = useAppStore(s => s.ui.viewMode)
  const [layout, setLayout] = useState(loadWorkbenchLayout)
  const { handleClick, handleMove, handleDown, handleUp, handleDoubleClick, handleKeyDown, preview, hint, hoverConstraint } = useSketchTool()
  const wheel = useRadialWheel()

  useEffect(() => {
    localStorage.setItem('snapboard-workbench-layout', JSON.stringify(layout))
  }, [layout])

  useEffect(() => {
    const expandRight = () => setLayout(current => ({
      ...current,
      leftCollapsed: true,
      rightCollapsed: false,
    }))
    window.addEventListener('snapboard:expand-right-panel', expandRight)
    return () => window.removeEventListener('snapboard:expand-right-panel', expandRight)
  }, [])

  const beginSidebarResize = (side: 'left' | 'right', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'left' ? layout.leftWidth : layout.rightWidth
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
          : Math.max(side === 'left' ? 220 : 250, Math.min(side === 'left' ? 420 : 460, width)),
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
    '--left-sidebar-width': `${layout.leftWidth}px`,
    '--right-sidebar-width': `${layout.rightWidth}px`,
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

      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); s.undo(); return }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return }

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
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.ui.selectedContourId) {
        e.preventDefault()
        s.execute(new RemoveContourCommand(s.ui.selectedContourId))
        s.setUI({ selectedContourId: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleKeyDown])

  return (
    <div className={`designer-shell mode-${viewMode}`}>
      <div className="designer-aurora" aria-hidden="true">
        <span className="designer-aurora-orb orb-primary" />
        <span className="designer-aurora-orb orb-secondary" />
      </div>
      <div className="designer-app-frame" style={workspaceStyle}>
        <div className="designer-main-column">
          <header className="designer-brandbar">
        <div className="designer-brand-lockup">
          <span className="designer-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="designer-brand-copy">
            <b>SnapBoard</b>
            <small>轻量设计台</small>
          </span>
        </div>
        <div className="designer-head-actions">
          <div className="designer-mode-context">
            <span className="designer-mode-live" aria-hidden="true" />
            <span>
              <b>{viewMode === '2d' ? '2D 草图工作台' : '3D 装配工作台'}</b>
              <small>{viewMode === '2d' ? '轮廓 · 分割 · 参数约束' : '板件 · 配件 · 空间校验'}</small>
            </span>
            <em>{viewMode === '2d' ? 'DRAW' : 'ASSEMBLE'}</em>
          </div>
          <button className="designer-layout-reset" type="button" onClick={() => setLayout(DEFAULT_WORKBENCH_LAYOUT)} title="恢复默认栏宽与展开状态">
            <span>↺</span> 重置布局
          </button>
          <button className="designer-site-back" type="button" onClick={onBackHome} aria-label="返回 SnapBoard 首页">
            <span aria-hidden="true">S</span>
            <span>首页</span>
          </button>
        </div>
      </header>
        <Toolbar collapsed={layout.toolbarCollapsed} onToggleCollapsed={() => setLayout(current => ({ ...current, toolbarCollapsed: !current.toolbarCollapsed }))} />
        <div className="designer-workspace">
        <div className={`workspace-panel workspace-panel-left${layout.leftCollapsed ? ' is-collapsed' : ''}`}>
          {layout.leftCollapsed ? (
            <button className="workspace-rail" onClick={() => setLayout(current => ({ ...current, leftCollapsed: false }))} title="展开属性与约束">
              <span>◧</span><b>属性</b><small>展开</small>
            </button>
          ) : <><Sidebar /><button className="workspace-collapse-button left" onClick={() => setLayout(current => ({ ...current, leftCollapsed: true }))} title="收起左侧属性栏">‹ 收起</button></>}
        </div>
        {!layout.leftCollapsed && <div className="workspace-resizer left" role="separator" aria-label="调整左栏宽度" onPointerDown={event => beginSidebarResize('left', event)} />}
        <main className="designer-viewport-frame">
          <div className="designer-viewport-label" aria-hidden="true">
            <span>{viewMode === '2d' ? 'PRECISION CANVAS' : 'SPATIAL PREVIEW'}</span>
            <i />
            <small>{viewMode === '2d' ? '毫米级参数化工作区' : '实时装配与结构检查'}</small>
          </div>
          {viewMode === '2d' ? (
            <SketchViewport2D
              onCanvasClick={handleClick}
              onCanvasMove={handleMove}
              onCanvasMouseDown={handleDown}
              onCanvasMouseUp={handleUp}
              onCanvasDoubleClick={handleDoubleClick}
              preview={preview}
              hint={hint}
              hoverConstraintId={hoverConstraint?.constraintId ?? null}
            />
          ) : (
            <Viewport3D />
          )}
        </main>
        {!layout.rightCollapsed && <div className="workspace-resizer right" role="separator" aria-label="调整右栏宽度" onPointerDown={event => beginSidebarResize('right', event)} />}
        </div>
      </div>
      <div className={`designer-right-column${layout.rightCollapsed ? ' is-collapsed' : ''}`}>
        {layout.rightCollapsed ? (
          <button className="workspace-rail" onClick={() => setLayout(current => ({ ...current, rightCollapsed: false }))} title="展开分割与配件">
            <span>◨</span><b>功能</b><small>展开</small>
          </button>
        ) : <><RightSidebar /><button className="workspace-collapse-button right" onClick={() => setLayout(current => ({ ...current, rightCollapsed: true }))} title="收起右侧功能栏">收起 ›</button></>}
      </div>
    </div>
    <RadialWheel state={wheel} />
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
        项目: <span className="accent">{project.metadata.name}</span>
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
