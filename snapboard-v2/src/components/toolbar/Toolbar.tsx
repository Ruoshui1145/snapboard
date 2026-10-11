// ============ 顶部工具栏 v7 (统一紧凑卡片 + 整卡点击 + 分割预览开关) ============
import { beginManufacturingAuthorization, completeManufacturingAuthorization, cancelManufacturingAuthorization } from '../licensing/commercialLicense'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { textPrompt } from '../../utils/textPrompt'
import { useAppStore } from '../../store/useAppStore'
import { HoleEditor } from '../viewport/HoleEditor'
import { useFileDrop } from '../../hooks/useFileDrop'
import { ClearSketchContoursCommand } from '../../commands/SketchCommands'
import { copySketchToClipboard, pasteSketchFromClipboard, duplicateSketchSelection } from '../../commands/SketchClipboard'
import type { SplitPanel, ToolId } from '../../types/geometry'
import { TextureSamplingDialog } from '../texture/TextureSamplingDialog'
import { CadImportDialog } from '../cad/CadImportDialog'
import { samplingPanelKey, type LastTextureSampling, type TextureSamplingOptions } from '../../utils/textureSampling'
import { createSamplingCheckSheet } from '../../utils/samplingCheckSheet'
import { createBoardTextureCanvas, getSplitPanelTextureBounds, editableTextureComposition } from '../../utils/boardTexture'
import { createManufacturing3MF, manufacturing3MFFileName } from '../../utils/export3mf'
import { createManufacturing3MFNative, nativeManufactureAvailable, type NativeManufactureResult } from '../../utils/nativeManufacture'
import {
  chooseLocalWorkspace,
  chooseProjectFile,
  downloadBlob,
  downloadProjectFile,
  ensureLocalWorkspacePermission,
  forgetLocalWorkspace,
  listLocalWorkspaceProjects,
  listProjectLibrary,
  parseProjectFile,
  projectWorkspaceFromState,
  PROJECT_STORAGE_API_BASE,
  readProjectFromLibrary,
  revealProjectLibrary,
  restoreLocalWorkspace,
  safeFileName,
  saveManufacturingFileAs,
  saveManufacturingToLibrary,
  saveProjectFileAs,
  saveProjectToLibrary,
  writeBinaryToLocalWorkspace,
  writeProjectFile,
  writeProjectToLocalWorkspace,
  type LocalWorkspaceProject,
  type ProjectDirectoryHandle,
  type ProjectFileHandle,
  type ProjectLibraryEntry,
} from '../../utils/projectFile'
import { publishProjectStorageStatus } from '../../utils/projectStorageStatus'
import { SNAPBOARD_PUBLICATION_NOTICE } from '../../utils/snapboardAttribution'
import { summarizeCurrentDesign } from '../../utils/farmOrder'
import { deliverOrderProject, uploadOrderFile } from '../../utils/orderDelivery'
import type { OrderEngravingPlan } from '../../utils/orderEngraving'
import { publishManufacturingFeedback, manufacturingFailureMessage, type ManufacturingFeedback, type OrderExportRequest } from '../../utils/manufacturingFeedback'

interface ToolDef {
  id: ToolId
  icon: string
  label: string
  key: string
  help: string
  sub?: 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'eraser'
}

interface ListedProject extends ProjectLibraryEntry {
  source: 'local-folder' | 'project-library'
  handle?: ProjectFileHandle
}

const TOOLS: ToolDef[] = [
  { id: 'select', icon: '🖱', label: '选择', key: 'V', help: '点击轮廓、边或尺寸进行选择；拖动控制点可直接调整形状。' },
  { id: 'line', icon: '✏️', label: '直线', key: 'P', help: '依次点击放置线段端点；靠近起点可闭合，双击结束连续绘制。', sub: 'line' },
  { id: 'rect', icon: '▭', label: '矩形', key: 'R', help: '选择两点、中心或三点模式，再在画布中依次点击确定矩形。', sub: 'rect' },
  { id: 'circle', icon: '◯', label: '圆', key: 'C', help: '圆心圆先定圆心再定半径；圆周圆通过三个圆周点创建。', sub: 'circle' },
  { id: 'arc', icon: '◠', label: '弧', key: 'A', help: '三点弧依次指定起点、终点和弧高；圆心弧先指定圆心。', sub: 'arc' },
  { id: 'polygon', icon: '⬡', label: '多边形', key: 'G', help: '先设置边数和内切/外切模式，再点击中心并拖动确定大小与角度。', sub: 'polygon' },
  { id: 'slot', icon: '💊', label: '槽口', key: 'S', help: '先画槽口中心线，再移动鼠标并点击确定槽宽。' },
  { id: 'offset', icon: '⇉', label: '等距实体', key: 'O', help: '点击已有轮廓，向内或向外移动鼠标，点击生成等距轮廓。' },
]

/** 编辑工具族: 选择 / 擦除 / 智能尺寸；“重画”是中间插入的事务按钮，不切换工具。 */
const SELECT_FAMILY: ToolDef[] = [
  { id: 'select', icon: '🖱', label: '选择', key: 'V', help: '点击选择轮廓、边或尺寸；拖动控制点可调整几何形状。' },
  { id: 'eraser', icon: '✂', label: '擦除', key: 'E', help: '点击边进行智能修剪；点右侧箭头可切换点擦除或快速擦除。' },
  { id: 'smartdim', icon: '↔', label: '智能尺寸', key: 'D', help: '点击边、点或圆添加尺寸，再移动鼠标确定标注位置和数值。' },
]

function ToolTip({ title, children }: { title: string; children: string }) {
  return (
    <div className="tb-tooltip" role="tooltip">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  )
}

import { workspaceSelection } from '../../utils/workbenchNavigation'

interface ToolbarProps {
  onEditHoles?(): void
  drawingOpen?: boolean
  onToggleDrawing?(): void
  collapsed?: boolean
  onToggleCollapsed?(): void
  onOpenShapeLibrary?(): void
}

const ERASER_FLYOUT_WIDTH = 260
const ERASER_FLYOUT_HEIGHT = 158
const ERASER_FLYOUT_GAP = 8
const ERASER_FLYOUT_MARGIN = 10

/** 把擦除菜单放到触发按钮右侧；空间不足时翻到左侧，并始终留在视口内。 */
export function eraserFlyoutPosition(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top'>,
  viewport: { width: number; height: number },
) {
  let left = anchor.right + ERASER_FLYOUT_GAP
  if (left + ERASER_FLYOUT_WIDTH > viewport.width - ERASER_FLYOUT_MARGIN) {
    left = anchor.left - ERASER_FLYOUT_WIDTH - ERASER_FLYOUT_GAP
  }
  return {
    left: Math.max(ERASER_FLYOUT_MARGIN, Math.min(left, viewport.width - ERASER_FLYOUT_WIDTH - ERASER_FLYOUT_MARGIN)),
    top: Math.max(ERASER_FLYOUT_MARGIN, Math.min(anchor.top, viewport.height - ERASER_FLYOUT_HEIGHT - ERASER_FLYOUT_MARGIN)),
  }
}

export function Toolbar({ drawingOpen = false, onEditHoles }: ToolbarProps) {
  const [drawingHost, setDrawingHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setDrawingHost(drawingOpen ? document.getElementById('board-drawing-tools') : null)
  }, [drawingOpen])
  const [cadOpen, setCadOpen] = useState(false)
  const setUI = useAppStore(s => s.setUI)
  const undo = useAppStore(s => s.undo)
  const redo = useAppStore(s => s.redo)
  const activeTool = useAppStore(s => s.ui.activeTool)
  const viewMode = useAppStore(s => s.ui.viewMode)
  const spatialEnabled = useAppStore(s => s.spatialLayout.enabled)
  const newContourType = useAppStore(s => s.ui.newContourType)
  const lineSubMode = useAppStore(s => s.ui.lineSubMode)
  const rectSubMode = useAppStore(s => s.ui.rectSubMode)
  const circleSubMode = useAppStore(s => s.ui.circleSubMode)
  const arcSubMode = useAppStore(s => s.ui.arcSubMode)
  const eraserMode = useAppStore(s => s.ui.eraserMode)
  const polygonSides = useAppStore(s => s.ui.polygonSides)
  const polygonCircumscribed = useAppStore(s => s.ui.polygonCircumscribed)
  const canUndo = useAppStore(s => s.undoStack.length > 0)
  const canRedo = useAppStore(s => s.redoStack.length > 0)
  const activeSketchContourCount = useAppStore(s => {
    const sketchId = s.ui.activeSketchId
    const sketches = s.project.parts.flatMap(part => part.features).filter(feature => feature.type === 'sketch')
    const target = sketches.find(feature => feature.id === sketchId) ?? sketches[0]
    return target?.contours.length ?? 0
  })
  const redrawDependencyCount = useAppStore(s =>
    s.boards.length
    + s.placedParts.length
    + s.assemblyScene.placements.length
    + s.assemblyScene.hostInstances.length
    + (s.splitResult ? 1 : 0)
    + (s.boardTexture.enabled || s.boardTexture.imageDataUrl || s.boardTexture.avoidZones.length ? 1 : 0)
    + (s.occlusionOverlayEnabled || s.ui.occlusionAnalysisOpen ? 1 : 0),
  )
  const canClearDesign = activeSketchContourCount > 0 || redrawDependencyCount > 0
  const [fileStatus, setFileStatus] = useState('保存工程或导出制造文件')
  const [exportReport, setExportReport] = useState<{ summary:string; messages:string[] } | null>(null)

  /** 网页端“退出系统”：调用开发中间件停止 dev server (重启后加载最新 vite 配置) */
  const shutdownDevServer = async () => {
    if (!window.confirm('确定退出 SnapBoard 吗？请先保存当前设计。')) return
    try {
      const response = await fetch('/api/system/shutdown', { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      window.alert(result.message || '后端已退出，请重新启动')
    } catch (cause) {
      window.alert(`退出请求失败：${cause instanceof Error ? cause.message : String(cause)}\n（如果不是通过开发服务器访问，请直接关闭后端进程）`)
    }
  }
  const [exporting3MF, setExporting3MF] = useState(false)
  const [samplingDialog, setSamplingDialog] = useState<{panels: SplitPanel[]; previewImage?: string} | null>(null)
  const samplingPreviewRevision = useRef(0)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [exportElapsed, setExportElapsed] = useState(0)
  const [exportStage, setExportStage] = useState('')
  const exportAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!exporting3MF) return
    const started = Date.now()
    const timer = window.setInterval(() => setExportElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [exporting3MF])
  const [projectLibraryOpen, setProjectLibraryOpen] = useState(false)
  const [projectLibraryFiles, setProjectLibraryFiles] = useState<ListedProject[]>([])
  const [projectLibraryLoading, setProjectLibraryLoading] = useState(false)
  const [projectLibraryQuery, setProjectLibraryQuery] = useState('')
  const projectLibraryListRef = useRef<HTMLDivElement | null>(null)
  const [workspaceDirectory, setWorkspaceDirectory] = useState<ProjectDirectoryHandle | null>(null)
  const [workspaceNeedsPermission, setWorkspaceNeedsPermission] = useState(false)
  const workspaceDirectoryRef = useRef<ProjectDirectoryHandle | null>(null)
  const currentProjectHandle = useRef<ProjectFileHandle | null>(null)
  const currentProjectHandleOrigin = useRef<'local-folder' | 'external-file' | null>(null)
  useEffect(() => {
    const openedFromOrder = () => {
      currentProjectHandle.current = null
      currentProjectHandleOrigin.current = null
      setExportReport(null)
      setFileStatus('已打开订单档案图纸；保存会另存副本，不会写回之前打开的文件。可通过订单交付保存当前版本。')
    }
    window.addEventListener('snapboard-order-project-opened', openedFromOrder)
    if (sessionStorage.getItem('snapboard-order-archive-open')) openedFromOrder()
    return () => window.removeEventListener('snapboard-order-project-opened', openedFromOrder)
  }, [])
  // 擦除二级菜单: 显式点击展开 (不自动弹出遮挡画布); 切离擦除工具时自动收起
  const [eraserFlyout, setEraserFlyout] = useState(false)
  const eraserArrowRef = useRef<HTMLButtonElement | null>(null)
  const [eraserFlyoutPos, setEraserFlyoutPos] = useState({ left: ERASER_FLYOUT_MARGIN, top: ERASER_FLYOUT_MARGIN })
  useEffect(() => {
    if (activeTool !== 'eraser') setEraserFlyout(false)
  }, [activeTool])
  useEffect(() => {
    if (!eraserFlyout || activeTool !== 'eraser') return
    const updatePosition = () => {
      const anchor = eraserArrowRef.current?.getBoundingClientRect()
      if (!anchor) return
      setEraserFlyoutPos(eraserFlyoutPosition(anchor, { width: window.innerWidth, height: window.innerHeight }))
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [activeTool, eraserFlyout])
  const pick = (t: ToolId) => setUI({ activeTool: t })
  const clearActiveSketch = () => {
    const state = useAppStore.getState()
    const sketches = state.project.parts.flatMap(part => part.features).filter(feature => feature.type === 'sketch')
    const sketch = sketches.find(feature => feature.id === state.ui.activeSketchId) ?? sketches[0]
    if ((!sketch || sketch.type !== 'sketch' || sketch.contours.length === 0) && redrawDependencyCount === 0) return
    const contourCount = sketch?.type === 'sketch' ? sketch.contours.length : 0
    const details = [
      contourCount ? `${contourCount} 个轮廓及尺寸` : '',
      state.splitResult ? `${state.splitResult.panels.length} 块分割板` : '',
      state.boards.length ? `${state.boards.length} 块旧版装配板` : '',
      state.placedParts.length ? `${state.placedParts.length} 个已放置配件` : '',
      state.assemblyScene.placements.length ? `${state.assemblyScene.placements.length} 个装配关系` : '',
      state.boardTexture.enabled || state.boardTexture.imageDataUrl || state.boardTexture.avoidZones.length ? '板面纹理/图片' : '',
      state.occlusionOverlayEnabled || state.ui.occlusionAnalysisOpen ? '遮挡分析派生状态' : '',
    ].filter(Boolean)
    if (!window.confirm(
      `确定清空当前设计并重新绘制吗？\n将同步清理：${details.join('、') || '依附旧板的设计状态'}。\n\n打印/分割参数、资源库和宿主类型配置会保留；可使用“撤销”或 Ctrl+Z 一次完整恢复。`,
    )) return
    state.execute(new ClearSketchContoursCommand(sketch?.id ?? null))
    setFileStatus(`已清空当前设计${contourCount ? `的 ${contourCount} 个轮廓` : ''}及旧板派生状态 · 可一次撤销恢复`)
  }
  const setContourType = (t: 'outer' | 'inner') => {
    // 顶部开关只决定【接下来新建】的轮廓类型。修改已有轮廓请使用左侧属性面板。
    // 旧行为会在外轮廓仍被选中时把它一起改成内孔，随后自动分割便找不到外轮廓。
    setUI({ newContourType: t })
  }

  const toggleViewMode = () => setUI({ viewMode: viewMode === '2d' ? '3d' : '2d' })

  const currentWorkspace = useCallback(() => projectWorkspaceFromState(useAppStore.getState()), [])

  const publishStorageSummary = useCallback((
    mode: 'project-library' | 'local-folder' | 'browser-download' | 'cloud',
    label: string,
    files: Array<Pick<ProjectLibraryEntry, 'name'>>,
    needsPermission = false,
  ) => {
    const externalName = currentProjectHandleOrigin.current === 'external-file' ? currentProjectHandle.current?.name : null
    publishProjectStorageStatus({
      mode,
      label: externalName ? `当前工程：${externalName} · 3MF：${label}` : label,
      projectCount: files.length,
      recentProjects: files.slice(0, 3).map(file => file.name.replace(/\.snapboard$/i, '')),
      needsPermission,
    })
  }, [])

  const refreshStorageSummary = useCallback(async (
    directory: ProjectDirectoryHandle | null,
    requestPermission = false,
  ) => {
    if (directory) {
      const granted = await ensureLocalWorkspacePermission(directory, requestPermission)
      setWorkspaceNeedsPermission(!granted)
      if (granted) {
        const files = await listLocalWorkspaceProjects(directory)
        publishStorageSummary('local-folder', `本地文件夹：${directory.name}`, files)
        return files
      }
      publishStorageSummary('local-folder', `本地文件夹：${directory.name}`, [], true)
      return []
    }
    const files = await listProjectLibrary()
    setWorkspaceNeedsPermission(false)
    if (files !== null) {
      const cloud = PROJECT_STORAGE_API_BASE !== '/api/project-library'
      publishStorageSummary(cloud ? 'cloud' : 'project-library', cloud ? '云端项目库' : '默认项目库“已保存项目”', files)
      return files
    }
    publishStorageSummary('browser-download', '浏览器文件保存', [])
    return []
  }, [publishStorageSummary])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const restored = await restoreLocalWorkspace()
      if (cancelled) return
      // 用户可能在 IndexedDB 恢复完成前已经手动选好了目录，不能让较慢的恢复结果覆盖它。
      const active = workspaceDirectoryRef.current ?? restored
      workspaceDirectoryRef.current = active
      setWorkspaceDirectory(active)
      await refreshStorageSummary(active)
    })().catch(error => {
      if (!cancelled) setFileStatus(`保存位置读取失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { cancelled = true }
  }, [refreshStorageSummary])

  const ensureNamedProject = useCallback(async () => {
    let state = useAppStore.getState()
    if (state.project.metadata.name.trim() && state.project.metadata.name !== '未命名项目') return true
    const name = (await textPrompt('保存前请给项目命名', state.project.metadata.name || '未命名项目'))?.trim()
    if (!name) {
      setFileStatus('保存已取消：需要先确认项目名称')
      return false
    }
    useAppStore.setState({
      project: { ...state.project, metadata: { ...state.project.metadata, name } },
    })
    state = useAppStore.getState()
    return Boolean(state.project.metadata.name)
  }, [])

  const selectSaveLocation = useCallback(async () => {
    try {
      const directory = await chooseLocalWorkspace()
      if (directory === undefined) {
        window.alert('当前浏览器不支持文件夹授权。仍可使用“另存为”逐个选择文件位置。建议在最新版 Edge 或 Chrome 中使用。')
        return
      }
      if (!directory) return
      workspaceDirectoryRef.current = directory
      setWorkspaceDirectory(directory)
      currentProjectHandle.current = null
      currentProjectHandleOrigin.current = null
      setWorkspaceNeedsPermission(false)
      const files = await refreshStorageSummary(directory, true)
      setFileStatus(`后续项目和 3MF 保存到 ${directory.name} · ${files.length} 个项目`)
    } catch (error) {
      window.alert(`保存位置设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [refreshStorageSummary])

  const resetSaveLocation = useCallback(async () => {
    try {
      await forgetLocalWorkspace()
      workspaceDirectoryRef.current = null
      setWorkspaceDirectory(null)
      currentProjectHandle.current = null
      currentProjectHandleOrigin.current = null
      setWorkspaceNeedsPermission(false)
      await refreshStorageSummary(null)
      setFileStatus('后续项目和 3MF 保存到默认项目库“已保存项目”')
    } catch (error) {
      window.alert(`恢复默认保存位置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [refreshStorageSummary])

  const saveProjectAs = useCallback(async () => {
    if (!await ensureNamedProject()) return
    try {
      const workspace = currentWorkspace()
      const handle = await saveProjectFileAs(workspace)
      if (handle) {
        currentProjectHandle.current = handle
        currentProjectHandleOrigin.current = 'external-file'
        sessionStorage.removeItem('snapboard-order-archive-open')
        await refreshStorageSummary(workspaceDirectoryRef.current)
        setFileStatus(`项目已另存为：系统选定位置/${handle.name}`)
      } else if (!('showSaveFilePicker' in window)) {
        downloadProjectFile(workspace)
        setFileStatus(`浏览器下载：${workspace.project.metadata.name}.snapboard`)
      } else {
        setFileStatus('另存为已取消，没有写入文件')
      }
    } catch (error) {
      window.alert(`项目另存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentWorkspace, ensureNamedProject, refreshStorageSummary])

  const saveProject = useCallback(async () => {
    if (sessionStorage.getItem('snapboard-order-archive-open')) {
      currentProjectHandle.current = null
      currentProjectHandleOrigin.current = null
      await saveProjectAs()
      return
    }
    if (!await ensureNamedProject()) return
    try {
      const workspace = currentWorkspace()
      const activeDirectory = workspaceDirectoryRef.current
      if (currentProjectHandle.current) {
        await writeProjectFile(workspace, currentProjectHandle.current)
        setFileStatus(`已保存到原文件：${currentProjectHandle.current.name}`)
        await refreshStorageSummary(activeDirectory)
        return
      }
      if (activeDirectory) {
        const granted = await ensureLocalWorkspacePermission(activeDirectory, true)
        if (!granted) {
          setWorkspaceNeedsPermission(true)
          throw new Error(`没有“${activeDirectory.name}”的写入权限，请重新点击“保存位置”授权`)
        }
        const handle = await writeProjectToLocalWorkspace(workspace, activeDirectory)
        currentProjectHandle.current = handle
        currentProjectHandleOrigin.current = 'local-folder'
        setWorkspaceNeedsPermission(false)
        setFileStatus(`项目已保存：${activeDirectory.name}/${handle.name}`)
        await refreshStorageSummary(activeDirectory)
        return
      }
      if (await saveProjectToLibrary(workspace)) {
        setFileStatus(`已保存到默认项目库“已保存项目”：${workspace.project.metadata.name}.snapboard`)
        await refreshStorageSummary(null)
        return
      }
      const handle = await saveProjectFileAs(workspace)
      if (handle) {
        currentProjectHandle.current = handle
        currentProjectHandleOrigin.current = 'external-file'
        await refreshStorageSummary(activeDirectory)
        setFileStatus(`项目已保存：系统选定位置/${handle.name}`)
      } else if (!('showSaveFilePicker' in window)) {
        downloadProjectFile(workspace)
        setFileStatus(`浏览器下载：${workspace.project.metadata.name}.snapboard`)
      }
    } catch (error) {
      window.alert(`项目保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentWorkspace, ensureNamedProject, refreshStorageSummary, saveProjectAs])

  const applyOpenedProject = useCallback((parsed: ReturnType<typeof parseProjectFile>, handle: ProjectFileHandle | null,
    origin: 'local-folder' | 'external-file' | null = null) => {
    useAppStore.getState().loadProjectWorkspace(parsed.workspace)
    sessionStorage.removeItem('snapboard-order-archive-open')
    currentProjectHandle.current = handle
    currentProjectHandleOrigin.current = origin
    setProjectLibraryOpen(false)
    setExportReport(null)
    setFileStatus(`已打开 ${parsed.workspace.project.metadata.name}`)
    void refreshStorageSummary(workspaceDirectoryRef.current)
  }, [refreshStorageSummary])

  const projectDrop = useFileDrop(async files => {
    if (files.length !== 1 || !files[0].name.toLowerCase().endsWith('.snapboard')) { setFileStatus('请拖入一个 .snapboard 工程文件'); return }
    try { applyOpenedProject(parseProjectFile(await files[0].text()), null) }
    catch (error) { setFileStatus(`项目打开失败：${error instanceof Error ? error.message : String(error)}`) }
  }, projectLibraryLoading, { accept: '.snapboard', onError: setFileStatus })

  const openProjectFromComputer = useCallback(async () => {
    const source = await chooseProjectFile()
    if (!source) return
    try {
      const parsed = parseProjectFile(await source.file.text())
      applyOpenedProject(parsed, source.handle, source.handle ? 'external-file' : null)
    } catch (error) {
      window.alert(`项目打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [applyOpenedProject])

  const collectProjectLibraryFiles = useCallback(async (): Promise<ListedProject[] | null> => {
    const activeDirectory = workspaceDirectoryRef.current
    let localFiles: LocalWorkspaceProject[] = []
    if (activeDirectory) {
      const granted = await ensureLocalWorkspacePermission(activeDirectory, true)
      setWorkspaceNeedsPermission(!granted)
      if (granted) localFiles = await listLocalWorkspaceProjects(activeDirectory)
    }
    const libraryFiles = await listProjectLibrary()
    if (libraryFiles === null && !activeDirectory) return null
    const files: ListedProject[] = [
      ...localFiles.map(file => ({ ...file, source: 'local-folder' as const })),
      ...(libraryFiles ?? []).map(file => ({ ...file, source: 'project-library' as const })),
    ]
    files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.name.localeCompare(b.name, 'zh-CN'))
    return files
  }, [])

  const showProjectLibrary = useCallback(async () => {
    setProjectLibraryLoading(true)
    try {
      const files = await collectProjectLibraryFiles()
      if (files === null) {
        await openProjectFromComputer()
        return
      }
      setProjectLibraryFiles(files)
      setProjectLibraryQuery('')
      setProjectLibraryOpen(true)
    } catch (error) {
      window.alert(`项目库读取失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setProjectLibraryLoading(false)
    }
  }, [collectProjectLibraryFiles, openProjectFromComputer])

  const openSaveLocation = useCallback(async () => {
    try {
      if (workspaceDirectoryRef.current) {
        await showProjectLibrary()
        setFileStatus(`已显示“${workspaceDirectoryRef.current.name}”和默认项目库中的工程`)
      } else if (PROJECT_STORAGE_API_BASE === '/api/project-library' && await revealProjectLibrary()) {
        setFileStatus('已在文件管理器中打开默认项目库；3MF 位于其中的“制造导出”目录')
      } else {
        await showProjectLibrary()
        setFileStatus('已打开当前项目库')
      }
    } catch (error) {
      try {
        await showProjectLibrary()
        setFileStatus(`系统文件管理器未打开，已显示项目列表：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        window.alert(`保存位置打开失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, [showProjectLibrary])

  const refreshProjectLibrary = useCallback(async () => {
    setProjectLibraryLoading(true)
    try {
      const files = await collectProjectLibraryFiles()
      if (files !== null) {
        setProjectLibraryFiles(files)
        requestAnimationFrame(() => { if (projectLibraryListRef.current) projectLibraryListRef.current.scrollTop = 0 })
      }
    } catch (error) {
      window.alert(`项目库刷新失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setProjectLibraryLoading(false)
    }
  }, [collectProjectLibraryFiles])

  const filteredProjectLibraryFiles = useMemo(() => {
    const query = projectLibraryQuery.trim().toLocaleLowerCase('zh-CN')
    return query
      ? projectLibraryFiles.filter(file => file.name.toLocaleLowerCase('zh-CN').includes(query))
      : projectLibraryFiles
  }, [projectLibraryFiles, projectLibraryQuery])

  useEffect(() => {
    if (!projectLibraryOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectLibraryOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    requestAnimationFrame(() => { if (projectLibraryListRef.current) projectLibraryListRef.current.scrollTop = 0 })
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [projectLibraryOpen])

  const openLibraryProject = useCallback(async (item: ListedProject) => {
    try {
      if (item.source === 'local-folder' && item.handle) {
        const parsed = parseProjectFile(await (await item.handle.getFile()).text())
        applyOpenedProject(parsed, item.handle, 'local-folder')
      } else {
        const parsed = await readProjectFromLibrary(item.name)
        applyOpenedProject(parsed, null)
      }
    } catch (error) {
      window.alert(`项目打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [applyOpenedProject])

  const openProject = useCallback(async () => {
    try {
      await showProjectLibrary()
    } catch (error) {
      window.alert(`项目打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [showProjectLibrary])

  const createProject = useCallback(async () => {
    const state = useAppStore.getState()
    const hasContent = state.project.parts.some(part => part.features.length > 0) || state.placedParts.length > 0 || state.spatialLayout.enabled
    if (hasContent && !window.confirm('新建项目会清空当前未保存的设计，是否继续？')) return
    const name = (await textPrompt('新项目名称', '未命名项目'))?.trim()
    if (!name) return
    state.newProject(name)
    sessionStorage.removeItem('snapboard-order-archive-open')
    currentProjectHandle.current = null
    currentProjectHandleOrigin.current = null
    setProjectLibraryOpen(false)
    void refreshStorageSummary(workspaceDirectoryRef.current)
    setFileStatus(`已新建 ${name}；保存时默认进入“已保存项目”`)
  }, [refreshStorageSummary])

  const ensureSplitPanels = useCallback(async () => {
    let state = useAppStore.getState()
    if (state.splitJob) throw new Error('板件正在重新生成，请完成后再导出')
    if (state.splitResult?.panels.length && JSON.stringify(state.splitResult.config) !== JSON.stringify(state.splitConfig)) {
      throw new Error('分板参数已改变，请先在板材设计中更新板件并复查装配，再导出')
    }
    if (state.splitResult && state.splitResult.panels.length === 0) {
      await state.runAutoSplit() // 清除此前空结果，再按当前草图重试
      state = useAppStore.getState()
    }
    if (!state.splitResult) {
      await state.runAutoSplit()
      state = useAppStore.getState()
    }
    const panels = state.splitResult?.panels ?? []
    if (!panels.length) {
      const detail = state.splitResult?.warnings[0]
      throw new Error(detail || '请先绘制闭合外轮廓，再执行自动分割')
    }
    return { state, panels }
  }, [])

  const export3MF = useCallback(async (textureSampling?: TextureSamplingOptions, orderRequest?: OrderExportRequest) => {
    const feedback = (phase: ManufacturingFeedback['phase'], message: string, fields: Partial<ManufacturingFeedback> = {}) => {
      if (orderRequest) publishManufacturingFeedback({ ...fields, requestId: orderRequest.requestId, orderId: orderRequest.orderId, orderNumber: orderRequest.orderNumber, phase, message })
    }
    if (exportAbortRef.current) { feedback('error', '已有制造任务正在进行，请完成或取消后重试'); return }
    const controller = new AbortController()
    exportAbortRef.current = controller
    let outcomeSent = false
    feedback('running', '正在检查授权和所选订单…', { progress: 0 })
    let cleanupExportFile: (() => Promise<void>) | undefined
    let quotaTicket: string | undefined
    let quotaDelivered = false
    try {
      quotaTicket = await beginManufacturingAuthorization()
      const initial = useAppStore.getState()
      if (orderRequest && (initial.orderLink?.id !== orderRequest.orderId || initial.orderLink.number !== orderRequest.orderNumber))
        throw new Error('所选订单关联未生效或已改变，未生成本次侧刻文件，请重新选择订单')
      const spatialMode = initial.spatialLayout.enabled
      if (spatialMode && textureSampling) throw new Error('立体版面当前不支持纹理抽样')
      const { state, panels } = spatialMode ? { state: initial, panels: [] } : await ensureSplitPanels()
      if (orderRequest && (state.orderLink?.id !== orderRequest.orderId || state.orderLink.number !== orderRequest.orderNumber))
        throw new Error('所选订单关联在生成板件期间改变，未生成本次侧刻文件，请重新选择订单')
      const activeDirectory = workspaceDirectoryRef.current
      if (activeDirectory) {
        const granted = await ensureLocalWorkspacePermission(activeDirectory, true)
        if (!granted) {
          setWorkspaceNeedsPermission(true)
          throw new Error(`没有“${activeDirectory.name}”的写入权限，请重新点击“保存位置”授权`)
        }
      }
      controller.signal.throwIfAborted()
      setExporting3MF(true)
      setExportReport(null)
      setExportProgress(0.01)
      setExportElapsed(0)
      setExportStage(spatialMode ? '正在准备立体板件…' : '正在准备纹理与板件…')
      setFileStatus(spatialMode ? '正在计算立体版面与制造方式…' : '正在准备 SnapColor 纹理与板件掩膜…')
      let orderEngraving: OrderEngravingPlan | undefined
      let orderManufacturingRequest: Record<string, unknown> | undefined
      if (state.orderLink) {
        if (textureSampling) throw new Error('关联订单的凹刻用于完整制造板件，请选择“完整原板导出”；颜色试样不属于编号成品')
        setExportStage('正在核验已确认订单与当前设计…')
        feedback('running', '正在核验所选订单与当前图纸…', { progress: .02 })
        const summary = await summarizeCurrentDesign(projectWorkspaceFromState(state))
        orderManufacturingRequest = { designFingerprint: summary.designFingerprint,
          panels: summary.panels.map(panel => ({ sourcePanelId: panel.sourcePanelId, widthMm: panel.widthMm,
            heightMm: panel.heightMm, depthMm: panel.depthMm })), product: {
            widthMm: summary.product.widthMm, heightMm: summary.product.heightMm, thicknessMm: summary.product.thicknessMm,
            layoutCode: summary.product.layoutCode, mappingCode: summary.product.mappingCode, colourCode: summary.product.colourCode,
            profile: summary.product.profile } }
        const response = await fetch(`/api/farm-orders/orders/${encodeURIComponent(state.orderLink.id)}/manufacturing-plan`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify(orderManufacturingRequest),
        })
        const result = await response.json() as OrderEngravingPlan & { error?: string }
        if (!response.ok) throw new Error(result.error ?? '订单制造追溯核验失败，请保存当前设计并确认订单')
        if (result.orderNumber !== state.orderLink.number) throw new Error('关联订单号与本机订单库不一致，请重新关联订单')
        orderEngraving = result
      }
      if (orderRequest && !orderEngraving) throw new Error('订单核验没有返回有效刻字清单，本次停止，不生成普通无侧刻文件')
      const input = {
        exportQuotaTicket: quotaTicket,
        panels: structuredClone(panels),
        cfg: structuredClone(state.splitConfig),
        placedParts: structuredClone(state.placedParts),
        // Store updates replace boardTexture; keeping this immutable snapshot avoids
        // cloning tens of MB of embedded SVG data during a large export.
        boardTexture: state.boardTexture,
        assemblyMarking: structuredClone(state.assemblyMarking),
        orderEngraving,
        textureSampling: textureSampling ? structuredClone(textureSampling) : undefined,
        projectName: state.project.metadata.name,
        projectVersion: state.project.metadata.version,
        signal: controller.signal,
        onProgress: (message: string, progress?: number) => {
          setFileStatus(message)
          setExportStage(message)
          feedback('running', message, { progress })
          if (progress !== undefined) setExportProgress(Math.max(0, Math.min(1, progress)))
  },
      }
      // 方案 §4/§5.D：优先交给本地制造进程（渲染、布尔与共享边界都不在浏览器主线程）。
      // 该进程只在本地 dev server 上存在；没有或失败时按原路在浏览器里导出，不让用户无路可走。
      let result: Awaited<ReturnType<typeof createManufacturing3MF>> | NativeManufactureResult
      const browserExport = () => createManufacturing3MF(input)
      if (spatialMode) {
        const { createSpatialManufacturing3MF } = await import('../../utils/spatialManufacturing')
        result = await createSpatialManufacturing3MF({
          layout: structuredClone(state.spatialLayout), cfg: input.cfg,
          projectName: input.projectName, projectVersion: input.projectVersion,
          assemblyMarking: input.assemblyMarking, signal: controller.signal,
          orderEngraving,
          onProgress: input.onProgress,
        })
        if (state.placedParts.length) result.warnings.push(`${state.placedParts.length} 件旧平面配件未映射到立体面，本次未导出；它们仍保存在工程中。`)
        if (state.boardTexture.enabled) result.warnings.push('旧平面图片/纹理尚未映射到立体各面，本次只导出结构板与连接件；原纹理仍保存在工程中。')
      } else if (input.boardTexture.enabled && input.boardTexture.surfaceMode === 'snapcolor' && !input.boardTexture.backEnabled && input.boardTexture.source === 'composition' && input.boardTexture.composition.layers.length > 0 && !input.assemblyMarking?.sideLogoEnabled && input.assemblyMarking?.backEngravingEnabled !== false
        && input.boardTexture.composition.layers.every(layer => layer.kind === 'panel-sequence' || layer.kind === 'image' &&
          !(layer.placement.mode === 'repeat' && layer.placement.gridRotationDeg)) && await nativeManufactureAvailable()) {
        try {
          result = await createManufacturing3MFNative({ ...input, boardTexture: { ...input.boardTexture, opacity: 1, composition: editableTextureComposition(input.boardTexture, input.panels) } }, input.onProgress)
        } catch (error) {
          if (controller.signal.aborted) throw error
          const reason = error instanceof Error ? error.message : String(error)
          // 方案 §5.D：不静默回退到旧路线。回退等于把整单在浏览器里重算一次（分钟级），
          // 必须让用户先看到失败原因并自己决定，否则就是白等一场还降低几何精度。
          console.error('[制造] 本地制造进程失败：', error)
          const fallback = window.confirm(
            `本地制造进程失败：\n${reason}\n\n`
            + '回退到浏览器内导出会把整单重新算一遍，通常要几分钟，且几何精度更低。\n\n'
            + '点“确定”回退并重新导出；点“取消”中止本次导出。')
          if (!fallback) {
            feedback('cancelled', '已取消本次导出，未保存侧刻文件'); outcomeSent = true
            setFileStatus(`已中止导出：本地制造进程失败（${reason}）`)
            return
          }
          setFileStatus(`本地制造进程失败，按你的选择回退到浏览器内导出：${reason}`)
          result = await browserExport()
        }
      } else {
        result = await browserExport()
      }
      const expectedParts = input.placedParts.length * (orderEngraving?.kitQuantity ?? 1)
      if (!spatialMode && 'partCount' in result && result.partCount !== expectedParts) {
        throw new Error(`配件仅生成 ${result.partCount}/${expectedParts} 件，已停止完整导出`)
      }
      cleanupExportFile = result.cleanup
      const binary = result.streamedFile ?? result.data
      const latestState = useAppStore.getState()
      const exportChanged = latestState.project !== state.project || latestState.splitResult !== state.splitResult
        || latestState.splitConfig !== state.splitConfig || latestState.boardTexture !== state.boardTexture
        || latestState.assemblyMarking !== state.assemblyMarking || latestState.placedParts !== state.placedParts
        || latestState.spatialLayout !== state.spatialLayout
        || latestState.orderLink !== state.orderLink
      if (orderEngraving && exportChanged) throw new Error('订单制造期间工程或关联订单已改变，本次文件未保存；请保存当前设计并重新确认订单后导出')
      if (orderEngraving && state.orderLink) {
        const response = await fetch(`/api/farm-orders/orders/${encodeURIComponent(state.orderLink.id)}/manufacturing-plan`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ ...orderManufacturingRequest, revision: orderEngraving.revision }),
        })
        if (!response.ok) {
          const failure = await response.json() as { error?: string }
          throw new Error(failure.error ?? '订单制造修订在导出期间已改变，文件未保存')
        }
      }
      // 逐板导出时文件名（分板压缩包）由制造进程给定，其余情况沿用原命名规则。
      const fileName = 'fileName' in result && result.fileName
        ? result.fileName
        : manufacturing3MFFileName(input, result.plateCount)
      setExportProgress(0.97)
      setExportStage('正在把完整 3MF 写入工程文件夹…')
      let savedLocation = ''
      let manufacturingDownloadUrl: string | undefined
      let savedManufacturingName = fileName
      let projectSnapshot = ''
      const workspace = currentWorkspace()
      if (orderEngraving && workspace.orderLink) {
        setExportStage('正在归档订单图纸与制造文件…')
        const projectArtifact = await deliverOrderProject(workspace, orderEngraving.revision, controller.signal)
        const orderPrefix = `${orderEngraving.orderNumber}-R${String(orderEngraving.revision).padStart(2, '0')}-`
        const artifactFilename = fileName.startsWith(orderPrefix) ? fileName : orderPrefix + fileName
        const manufacturingArtifact = await uploadOrderFile(workspace.orderLink, orderEngraving.revision,
          'manufacturing', artifactFilename, binary, controller.signal)
        savedLocation = `订单档案/${orderEngraving.orderNumber}/R${orderEngraving.revision}/${manufacturingArtifact.filename}`
        manufacturingDownloadUrl = manufacturingArtifact.downloadUrl
        savedManufacturingName = manufacturingArtifact.filename
        projectSnapshot = `订单工程/${projectArtifact.filename}`
      } else {
        if (!textureSampling) {
          if (currentProjectHandle.current) {
            await writeProjectFile(workspace, currentProjectHandle.current)
            projectSnapshot = currentProjectHandleOrigin.current === 'external-file'
              ? `系统选定文件/${currentProjectHandle.current.name}`
              : `${activeDirectory?.name ?? '已保存项目'}/${currentProjectHandle.current.name}`
          } else if (activeDirectory) {
            const projectHandle = await writeProjectToLocalWorkspace(workspace, activeDirectory)
            currentProjectHandle.current = projectHandle
            currentProjectHandleOrigin.current = 'local-folder'
            projectSnapshot = `${activeDirectory.name}/${projectHandle.name}`
          } else if (await saveProjectToLibrary(workspace)) {
            projectSnapshot = `已保存项目/${workspace.project.metadata.name}.snapboard`
          }
        }
        if (activeDirectory) {
          savedLocation = await writeBinaryToLocalWorkspace(activeDirectory, fileName, binary, '制造导出')
        } else {
          savedLocation = await saveManufacturingToLibrary(fileName, binary, { exportTicket: quotaTicket, signal: controller.signal }) ?? ''
          if (!savedLocation) {
            const handle = await saveManufacturingFileAs(binary, fileName)
            if (handle === null) {
              setFileStatus('已取消 3MF 保存')
              return
            }
            if (handle) savedLocation = handle.name
            else {
              if (quotaTicket) throw new Error('本机制造文件库不可用，且当前环境无法确认文件保存。请重试保存或联系支持；本次导出尚未确认完成。')
              downloadBlob(new Blob([binary as BlobPart], { type: fileName.toLowerCase().endsWith('.zip') ? 'application/zip' : 'model/3mf' }), safeFileName(fileName))
              savedLocation = `浏览器下载/${fileName}`
            }
          }
        }
      }
      quotaDelivered = true
      const checkWarnings: string[] = []
      await completeManufacturingAuthorization(quotaTicket).catch(() => {
        checkWarnings.push('制造文件已保存，导出凭据状态暂未刷新；请在“DIY 导出”中刷新凭据，不需要重新生成文件。旧计次策略下，次数以刷新后的结果为准。')
      })
      if (exportChanged) checkWarnings.push('3MF 使用开始导出时的设计快照；期间工程又有修改，请确认当前工程与本文件的版本差异')
      if (textureSampling) {
        const savedFileName = savedLocation.split(/[\\/]/).pop() || fileName
        const record: LastTextureSampling = {
          exportedAt: new Date().toISOString(), manufacturingFile: savedFileName,
          sizeMm: textureSampling.sizeMm,
          locations: textureSampling.locations.map(location => ({
            sampleId: `S${String(location.panelIndex + 1).padStart(2, '0')}`,
            panelId: input.panels[location.panelIndex].id,
            geometryKey: samplingPanelKey(input.panels[location.panelIndex]),
            x: location.x, y: location.y,
          })),
        }
        const imageName = savedFileName.replace(/\.3mf$/i, '-抽样安装核对.png')
        let imageBlob: Blob | null = null
        try {
          const blob = await createSamplingCheckSheet(input.panels, input.boardTexture, input.cfg,
            input.assemblyMarking, input.placedParts, input.projectName, record)
          imageBlob = blob
          const png = new Uint8Array(await blob.arrayBuffer())
          const imageLocation = activeDirectory
            ? await writeBinaryToLocalWorkspace(activeDirectory, imageName, png, '制造导出')
            : await saveManufacturingToLibrary(imageName, png)
          if (!imageLocation) {
            downloadBlob(blob, imageName)
            checkWarnings.push('默认项目库不可用，核对图已下载到浏览器下载目录')
          }
          record.checkImageFile = imageLocation?.split(/[\\/]/).pop() || imageName
        } catch (error) {
          if (imageBlob && !activeDirectory) {
            downloadBlob(imageBlob, imageName)
            record.checkImageFile = imageName
            checkWarnings.push(`无法写入项目库，核对图已下载：${error instanceof Error ? error.message : String(error)}`)
          } else checkWarnings.push(`核对图保存失败：${error instanceof Error ? error.message : String(error)}`)
        }
        useAppStore.getState().setLastTextureSampling(record)
        try {
          if (currentProjectHandle.current) {
            await writeProjectFile(currentWorkspace(), currentProjectHandle.current)
            projectSnapshot = currentProjectHandleOrigin.current === 'external-file'
              ? `系统选定文件/${currentProjectHandle.current.name}`
              : `${activeDirectory?.name ?? '已保存项目'}/${currentProjectHandle.current.name}`
          } else if (activeDirectory) {
            const handle = await writeProjectToLocalWorkspace(currentWorkspace(), activeDirectory)
            currentProjectHandle.current = handle
            currentProjectHandleOrigin.current = 'local-folder'
            projectSnapshot = `${activeDirectory.name}/${handle.name}`
          } else if (await saveProjectToLibrary(currentWorkspace())) {
            projectSnapshot = `已保存项目/${workspace.project.metadata.name}.snapboard`
          } else checkWarnings.push('项目库不可用：本次抽样记录仅保存在当前会话，请手动保存项目')
        } catch (error) {
          checkWarnings.push(`抽样位置未能写入项目文件：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await refreshStorageSummary(activeDirectory)
      setExportProgress(1)
      const markingStatus = result.numbering?.requested
        ? ` · 装配背刻：${result.numbering.applied}/${result.numbering.requested} 块已写入（背面 ${result.numbering.back}、承托层 ${result.numbering.pocket}）`
        : result.markingRequestedCount
        ? ` · 背面标识：${result.markingAppliedCount}/${result.markingRequestedCount} 块${result.markingAppliedCount === result.markingRequestedCount ? '已写入' : '成功'}`
        : ''
      setFileStatus(`3MF：${savedLocation}${orderEngraving ? ` · 订单 ${orderEngraving.orderNumber} R${orderEngraving.revision}：${orderEngraving.totalPanelCount} 块板已侧刻完整订单号` : ''}${result.sampleCount ? ` · ${result.sampleCount} 个试样，先打印前 ${result.samplePlateCount} 盘；后续为原板` : ''}${projectSnapshot ? ` · 项目：${projectSnapshot}` : ''}${markingStatus}${checkWarnings.length ? ` · ${checkWarnings.join('；')}` : ''} · 发布署名：${SNAPBOARD_PUBLICATION_NOTICE}`)
      feedback('success', '侧刻完成：每块板均已刻入完整订单号。', {
        progress: 1, orderNumber: orderEngraving?.orderNumber, panelCount: orderEngraving?.totalPanelCount,
        fileName: savedManufacturingName, savedLocation, downloadUrl: manufacturingDownloadUrl,
      }); outcomeSent = true
      window.dispatchEvent(new Event('snapboard:export-complete'))
      if (textureSampling) setSamplingDialog(null)
      setExportReport({summary:`3MF 已生成${markingStatus}`,messages:[
        ...(result.numbering?.missing.length?[`未背刻装配板号：${result.numbering.missing.join('、')}`]:[]),
        ...result.warnings,...checkWarnings]})
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setFileStatus('已取消 3MF 生成')
        feedback('cancelled', '已取消本次导出，未保存侧刻文件'); outcomeSent = true
        setExportProgress(null)
      }
      else {
        const message=error instanceof Error ? error.message : String(error)
        feedback('error', `侧刻失败：${manufacturingFailureMessage(message)}`); outcomeSent = true
        setExportReport({summary:'本次侧刻未完成',messages:[message]})
        setFileStatus(`3MF 导出失败：${message}`)
        setExportStage('导出失败')
        const failedSample=/\bS(\d+)\b/.exec(message)
        const point=textureSampling && failedSample
          ? textureSampling.locations.find(p=>p.panelIndex===Number(failedSample[1])-1) : undefined
        const detail=point ? `\n试样 S${failedSample![1]}：中心 X=${point.x}、Y=${point.y} mm，边长 ${textureSampling!.sizeMm} mm。` : ''
        if (!orderRequest && !(error instanceof Error && 'code' in error && String(error.code).startsWith('DIY_QUOTA'))) window.alert(`3MF 导出失败：${message}${detail}`)
      }
    } finally {
      if (!quotaDelivered) await cancelManufacturingAuthorization(quotaTicket).catch(() => undefined)
      if (!outcomeSent) feedback('cancelled', '本次导出未保存侧刻文件，请查看导出检查');
      window.dispatchEvent(new Event('snapboard:manufacturing-finished'))
      if (cleanupExportFile) await cleanupExportFile().catch(error => console.warn('清理导出临时文件失败', error))
      exportAbortRef.current = null
      setExporting3MF(false)
      window.setTimeout(() => setExportProgress(null), 1800)
    }
  }, [currentWorkspace, ensureSplitPanels, refreshStorageSummary])

  const openTextureSampling = useCallback(async () => {
    if (exportAbortRef.current) return
    try {
      const { state, panels } = await ensureSplitPanels()
      if (!state.boardTexture.enabled) throw new Error('请先启用叠色或纹理层')
      const revision=++samplingPreviewRevision.current
      setSamplingDialog({panels})
      const bounds=getSplitPanelTextureBounds(panels)
      const canvas=await createBoardTextureCanvas(state.boardTexture,bounds.width/bounds.height,panels)
      if(revision===samplingPreviewRevision.current) setSamplingDialog(previous=>previous ? {...previous,previewImage:canvas?.toDataURL('image/png')} : null)
    } catch(error) { window.alert(`抽样准备失败：${error instanceof Error ? error.message : String(error)}`) }
  }, [ensureSplitPanels])

  // All ordinary export entry points share this decision, including desktop/menu events.
  const request3MFExport = useCallback(() => {
    if (exportAbortRef.current) return
    if (useAppStore.getState().spatialLayout.enabled) void export3MF()
    else if (useAppStore.getState().boardTexture.enabled && useAppStore.getState().boardTexture.surfaceMode === 'snapcolor') void openTextureSampling()
    else void export3MF()
  }, [export3MF, openTextureSampling])

  const cancel3MFExport = useCallback(() => {
    if (!exportAbortRef.current) return
    setFileStatus('正在取消 3MF 生成…')
    exportAbortRef.current.abort()
  }, [])

  useEffect(() => {
    const onFileShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveProject()
      } else if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openProject()
      }
    }
    window.addEventListener('keydown', onFileShortcut)
    return () => window.removeEventListener('keydown', onFileShortcut)
  }, [openProject, saveProject])

  useEffect(() => {
    const onExportRequest = (event: Event) => {
      const detail=(event as CustomEvent<{mode?:string;orderRequest?:OrderExportRequest}>).detail
      const request=detail?.orderRequest
      if (request) request.accepted = true
      if (exportAbortRef.current) {
        if (request) publishManufacturingFeedback({requestId:request.requestId,phase:'error',message:'已有制造任务正在进行，请完成或取消后重试'})
        return
      }
      setUI(workspaceSelection('inspect'))
      const mode=detail?.mode
      if(mode==='original')void export3MF(undefined,request)
      else if(mode==='sample' && useAppStore.getState().spatialLayout.enabled)window.alert('立体版面当前不支持平面纹理抽样')
      else if(mode==='sample')void openTextureSampling()
      else request3MFExport()
    }
    window.addEventListener('snapboard:export-manufacturing', onExportRequest)
    return () => window.removeEventListener('snapboard:export-manufacturing', onExportRequest)
  }, [request3MFExport, export3MF, openTextureSampling, setUI])

  useEffect(()=>{const open=()=>setCadOpen(true);window.addEventListener('snapboard:import-cad',open);return()=>window.removeEventListener('snapboard:import-cad',open)},[])

  /** 工具小框内的子选项 (直接贴在按钮下方) */
  const renderSub = (t: ToolDef) => {
    if (t.sub === 'line') {
      return (
        <div className="tb-sub">
          <div className="tb-seg" title="直线模式">
            <button className={lineSubMode === 'line' ? 'on' : ''} onClick={() => setUI({ lineSubMode: 'line', activeTool: 'line' })}>直线</button>
            <button className={lineSubMode === 'centerline' ? 'on' : ''} onClick={() => setUI({ lineSubMode: 'centerline', activeTool: 'line' })}>辅助线</button>
          </div>
        </div>
      )
    }
    if (t.sub === 'rect') {
      return (
        <div className="tb-sub">
          <div className="tb-seg" title="矩形模式">
            <button className={rectSubMode === 'corner' ? 'on' : ''} onClick={() => setUI({ rectSubMode: 'corner', activeTool: 'rect' })}>两点</button>
            <button className={rectSubMode === 'center' ? 'on' : ''} onClick={() => setUI({ rectSubMode: 'center', activeTool: 'rect' })}>中心</button>
            <button className={rectSubMode === '3point' ? 'on' : ''} onClick={() => setUI({ rectSubMode: '3point', activeTool: 'rect' })}>三点</button>
          </div>
        </div>
      )
    }
    if (t.sub === 'circle') {
      return (
        <div className="tb-sub">
          <div className="tb-seg" title="圆模式">
            <button className={circleSubMode === 'center' ? 'on' : ''} onClick={() => setUI({ circleSubMode: 'center', activeTool: 'circle' })}>圆心圆</button>
            <button className={circleSubMode === '3point' ? 'on' : ''} onClick={() => setUI({ circleSubMode: '3point', activeTool: 'circle' })}>圆周圆</button>
          </div>
        </div>
      )
    }
    if (t.sub === 'arc') {
      return (
        <div className="tb-sub">
          <div className="tb-seg" title="弧绘制方式">
            <button className={arcSubMode === 'arc3pt' ? 'on' : ''} onClick={() => setUI({ arcSubMode: 'arc3pt', activeTool: 'arc' })}>三点弧</button>
            <button className={arcSubMode === 'arcCenter' ? 'on' : ''} onClick={() => setUI({ arcSubMode: 'arcCenter', activeTool: 'arc' })}>圆心弧</button>
          </div>
        </div>
      )
    }
    if (t.sub === 'polygon') {
      return (
        <div className="tb-sub">
          <div className="tb-stepper" title="多边形边数 (3-12)">
            <button onClick={() => setUI({ polygonSides: Math.max(3, polygonSides - 1), activeTool: 'polygon' })}>−</button>
            <span className="val">{polygonSides}边</span>
            <button onClick={() => setUI({ polygonSides: Math.min(12, polygonSides + 1), activeTool: 'polygon' })}>+</button>
          </div>
          <div className="tb-seg" title="多边形绘制模式 (内切圆/外切圆)">
            <button className={!polygonCircumscribed ? 'on' : ''} onClick={() => setUI({ polygonCircumscribed: false, activeTool: 'polygon' })}>内切</button>
            <button className={polygonCircumscribed ? 'on' : ''} onClick={() => setUI({ polygonCircumscribed: true, activeTool: 'polygon' })}>外切</button>
          </div>
        </div>
      )
    }
    return null
  }

  const renderFamilyTool = (f: ToolDef) => (
    <div key={f.id} className="fam-row">
      <button
        className={'fam-btn' + (activeTool === f.id ? ' on' : '')}
        title={`${f.label} (${f.key})`}
        onClick={() => pick(f.id)}
      >
        <span className="fam-ic">{f.icon}</span>
        <span className="fam-lb">{f.label}</span>
        <span className="tb-key">{f.key}</span>
      </button>
      {f.id === 'eraser' && (
        <button
          ref={eraserArrowRef}
          className={'fam-arrow-btn' + (eraserFlyout && activeTool === 'eraser' ? ' open' : '')}
          title="点开擦除模式 (点擦除 / 快速擦除)"
          aria-haspopup="menu"
          aria-expanded={eraserFlyout && activeTool === 'eraser'}
          onClick={() => {
            if (activeTool !== 'eraser') pick('eraser')
            setEraserFlyout(value => !value)
          }}
        >
          <span className="fam-arrow">▸</span>
        </button>
      )}
      <ToolTip title={`${f.icon} ${f.label} · ${f.key}`}>{f.help}</ToolTip>
    </div>
  )

  return (
    <div className="tb workbench-toolbar">
      <div className="workbench-commandbar">
        <button type="button" onClick={()=>void openProject()} disabled={projectLibraryLoading}>打开</button>
        <button type="button" onClick={()=>void saveProject()} title="Ctrl+S">保存</button>
        <details className="workbench-file-menu"><summary>文件 ▾</summary><div>
          <button onClick={createProject}>新建项目</button><button onClick={()=>void saveProjectAs()}>另存为…</button>
          <button onClick={()=>void openSaveLocation()} title={workspaceDirectory ? '查看已授权文件夹和默认库中的工程' : '在文件管理器中打开默认项目库；3MF 在“制造导出”子目录'}>{workspaceDirectory ? '查看已保存工程' : currentProjectHandleOrigin.current === 'external-file' ? '打开默认项目库（3MF）' : '打开保存位置'}</button>
          <button onClick={()=>void selectSaveLocation()}>{workspaceNeedsPermission ? '更改保存文件夹（需授权）…' : '更改保存文件夹…'}</button>
          {workspaceDirectory && <button onClick={()=>void resetSaveLocation()}>恢复默认保存位置</button>}
          <button onClick={()=>void shutdownDevServer()}>退出系统</button>
        </div></details>
        <span className="workbench-command-divider"/>
        <button onClick={undo} disabled={!canUndo} title="Ctrl+Z">撤销</button><button onClick={redo} disabled={!canRedo} title="Ctrl+Y">重做</button>
        <span className="workbench-file-state" title={fileStatus} role="status">{fileStatus || '先创建板材，或打开已有工程'}</span>
        {exportReport && <details className="workbench-file-menu workbench-export-report"><summary>导出检查{exportReport.messages.length?` · ${exportReport.messages.length}`:''}</summary><div>
          <p>{exportReport.summary}</p>{exportReport.messages.map((message,index)=><p key={index}>{message}</p>)}
        </div></details>}
        <HoleEditor toolbar onOpen={onEditHoles} />
        <button type="button" disabled={spatialEnabled} onClick={toggleViewMode} aria-label={spatialEnabled?'立体版面使用 3D 预览':'切换2D与3D视图'}>{spatialEnabled?'3D 立体预览':viewMode==='2d'?'2D · 切换3D':'3D · 切换2D'}</button>
      </div>
      {drawingOpen && drawingHost && createPortal(<div className="workbench-drawing">
      <div className="tb-groups">
        {/* ---- 编辑工具族: 选择 / 擦除 / 重画 / 智能尺寸；重画是可撤销事务 ---- */}
        <div className="fam-group">
          <div className={'tb-group fam' + (SELECT_FAMILY.some(f => f.id === activeTool) ? ' active' : '')}>
            {SELECT_FAMILY.slice(0, 2).map(renderFamilyTool)}
            <div className="fam-row fam-clear-row">
              <button
                type="button"
                className="fam-btn fam-clear-btn"
                disabled={!canClearDesign}
                onClick={clearActiveSketch}
                title={canClearDesign ? '清空当前设计及旧板派生状态（可撤销）' : '当前设计为空'}
                aria-label="清空当前设计并重新绘制"
              >
                <span className="fam-ic">⌫</span>
                <span className="fam-lb">重画</span>
                <span className="tb-key">ALL</span>
              </button>
              <ToolTip title="⌫ 清空设计并重画">一次清除轮廓、旧分割板、已放置配件、纹理和分析派生状态；保留参数与资源库，并可用撤销完整恢复。</ToolTip>
            </div>
            {SELECT_FAMILY.slice(2).map(renderFamilyTool)}
            <div className="fam-row"><button type="button" className="fam-btn" title="Ctrl+C" onClick={()=>void copySketchToClipboard().then(count=>setFileStatus(count?`已复制 ${count} 个轮廓`:'请先选择要复制的轮廓'))}>复制</button></div>
            <div className="fam-row"><button type="button" className="fam-btn" title="Ctrl+V" onClick={()=>void pasteSketchFromClipboard().then(count=>setFileStatus(count?`已粘贴 ${count} 个轮廓`:'剪贴板中没有草图轮廓')).catch(error=>setFileStatus(error.message))}>粘贴</button></div>
            <div className="fam-row"><button type="button" className="fam-btn" title="Ctrl+D" onClick={()=>setFileStatus(duplicateSketchSelection()?'已创建轮廓副本':'请先选择要复制的轮廓')}>复制一份</button></div>
          </div>

        </div>

        {TOOLS.slice(1).map(t => (
          <div
            key={t.id}
            className={`tb-group tb-tool-${t.id}${activeTool === t.id ? ' active' : ''}`}
          >
            <button
              className={'tb-gbtn' + (activeTool === t.id ? ' active' : '')}
              title={`${t.label} (${t.key})：${t.help}`}
              aria-label={`切换到${t.label}工具 (${t.key})`}
              onClick={() => pick(t.id)}
            >
              {t.icon} {t.label}<span className="tb-key">{t.key}</span>
            </button>
            {renderSub(t)}
          </div>
        ))}
      </div>
        <div className="tb-seg workbench-contour-role"><button className={newContourType==='outer'?'on':''} onClick={()=>setContourType('outer')}>绘制外轮廓</button><button className={newContourType==='inner'?'on':''} onClick={()=>setContourType('inner')}>绘制内孔</button></div>
      </div>, drawingHost)}
      {exportProgress !== null && <div className="workbench-export-progress" role="status"><progress aria-label="3MF 导出进度" max={1} value={exportProgress}/><span>{Math.round(exportProgress*100)}% · 已运行 {Math.floor(exportElapsed / 60)}:{String(exportElapsed % 60).padStart(2, '0')}</span><span className="workbench-export-stage" title={exportStage}>{exportStage}</span><button onClick={cancel3MFExport}>取消导出</button></div>}
      {cadOpen && <CadImportDialog onClose={()=>setCadOpen(false)}/>}
      {samplingDialog && <TextureSamplingDialog panels={samplingDialog.panels} lastSampling={useAppStore.getState().lastTextureSampling} previewImage={samplingDialog.previewImage} busy={exporting3MF} onCancelExport={cancel3MFExport} onExportOriginal={()=>{samplingPreviewRevision.current++;setSamplingDialog(null);void export3MF()}} onClose={()=>{samplingPreviewRevision.current++;setSamplingDialog(null)}} onExport={options=>{void export3MF(options)}}/>}
      {eraserFlyout && activeTool === 'eraser' && createPortal(
        <div
          className="fam-flyout"
          role="menu"
          aria-label="擦除模式"
          style={{ left: eraserFlyoutPos.left, top: eraserFlyoutPos.top }}
          onWheel={event => event.stopPropagation()}
        >
          <div className="fam-flyout-title">擦除模式 (点 ▸ 切换)</div>
          <button
            role="menuitemradio"
            aria-checked={eraserMode === 'point'}
            className={'fam-opt' + (eraserMode === 'point' ? ' on' : '')}
            onClick={() => setUI({ eraserMode: 'point', activeTool: 'eraser' })}
          >
            <span className="fam-opt-ic">📍</span>
            <span><b>点擦除</b><small>点击边 → 智能修剪 (交点截断 / 整边删除)</small></span>
          </button>
          <button
            role="menuitemradio"
            aria-checked={eraserMode === 'sweep'}
            className={'fam-opt' + (eraserMode === 'sweep' ? ' on' : '')}
            onClick={() => setUI({ eraserMode: 'sweep', activeTool: 'eraser' })}
          >
            <span className="fam-opt-ic">🧹</span>
            <span><b>快速擦除</b><small>按住拖动扫过 → 批量删除边</small></span>
          </button>
        </div>
      , document.body)}

      {projectLibraryOpen && createPortal(
        <div className="project-library-backdrop" role="presentation" onMouseDown={() => setProjectLibraryOpen(false)}>
          <section className="project-library-dialog" role="dialog" aria-modal="true" aria-label="打开 SnapBoard 项目" onMouseDown={event => event.stopPropagation()} {...projectDrop.dropProps}>
            <header>
              <div>
                <strong>打开项目</strong>
                <span>{workspaceDirectory
                  ? `工作区：${workspaceDirectory.name} · 同时显示${PROJECT_STORAGE_API_BASE === '/api/project-library' ? '默认项目库' : '云端项目库'}`
                  : PROJECT_STORAGE_API_BASE === '/api/project-library' ? '默认项目库：已保存项目 · 制造文件在“制造导出”' : '当前来源：云端项目库'}</span>
              </div>
              <div className="project-library-controls">
                <label><span>搜索项目</span><input value={projectLibraryQuery} onChange={event => setProjectLibraryQuery(event.target.value)} placeholder="输入项目名称" autoFocus /></label>
                <button type="button" onClick={() => void refreshProjectLibrary()} disabled={projectLibraryLoading}>{projectLibraryLoading ? '读取中' : '刷新'}</button>
                <button type="button" className="project-library-close" onClick={() => setProjectLibraryOpen(false)} aria-label="关闭">×</button>
              </div>
            </header>
            <div className="project-library-list" ref={projectLibraryListRef} aria-live="polite">
              {projectLibraryLoading && !projectLibraryFiles.length ? <div className="project-library-empty">正在读取项目库…</div> : filteredProjectLibraryFiles.length ? filteredProjectLibraryFiles.map(file => (
                <button type="button" key={`${file.source}:${file.name}`} title={`打开 ${file.name}`} onClick={() => void openLibraryProject(file)}>
                  <span>{file.name} <em>{file.source === 'local-folder' ? workspaceDirectory?.name : PROJECT_STORAGE_API_BASE === '/api/project-library' ? '默认项目库' : '云端项目库'}</em></span>
                  <small>{new Date(file.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间） · {Math.max(1, Math.round(file.size / 1024))} KB</small>
                </button>
              )) : <div className="project-library-empty">
                {projectLibraryQuery.trim() ? `没有名称包含“${projectLibraryQuery.trim()}”的项目。` : workspaceDirectory
                  ? `“${workspaceDirectory.name}”和默认项目库中都没有 .snapboard 工程。请点击“保存”，或重新导出一次 3MF（会同步保存项目快照）。`
                  : '默认项目库还没有 .snapboard 工程。点击“保存”后会显示在这里；单独的 3MF 不是可继续编辑的项目。'}
              </div>}
            </div>
            <footer>
              <span>共 {projectLibraryFiles.length} 个项目{projectLibraryQuery.trim() ? ` · 当前显示 ${filteredProjectLibraryFiles.length} 个` : ''}</span>
              <button type="button" className="file-drop-prompt" {...projectDrop.dropProps} onClick={() => void openProjectFromComputer()}><span className="file-drop-plus" aria-hidden="true">＋</span>点击或拖入工程…</button>
              <button type="button" className="secondary" onClick={() => setProjectLibraryOpen(false)}>取消</button>
            </footer>
          </section>
        </div>
      , document.body)}
    </div>
  )
}
