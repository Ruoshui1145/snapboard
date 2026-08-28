// ============ 顶部工具栏 v7 (统一紧凑卡片 + 整卡点击 + 分割预览开关) ============
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { ToolId } from '../../types/geometry'
import { createManufacturing3MF, manufacturing3MFFileName } from '../../utils/export3mf'
import {
  chooseLocalWorkspace,
  chooseProjectFile,
  downloadBlob,
  downloadProjectFile,
  ensureLocalWorkspacePermission,
  listLocalWorkspaceProjects,
  listProjectLibrary,
  parseProjectFile,
  PROJECT_STORAGE_API_BASE,
  readProjectFromLibrary,
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

/** 编辑工具族: 选择 / 擦除 / 智能尺寸 (统一在第一个"选择"大组, 中键轮盘同款三选一) */
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

interface ToolbarProps {
  collapsed?: boolean
  onToggleCollapsed?(): void
}

export function Toolbar({ collapsed = false, onToggleCollapsed }: ToolbarProps) {
  const setUI = useAppStore(s => s.setUI)
  const undo = useAppStore(s => s.undo)
  const redo = useAppStore(s => s.redo)
  const activeTool = useAppStore(s => s.ui.activeTool)
  const viewMode = useAppStore(s => s.ui.viewMode)
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
  const runAutoSplit = useAppStore(s => s.runAutoSplit)
  const splitResultCount = useAppStore(s => s.splitResult?.panels.length ?? 0)
  const splitActive = useAppStore(s => s.splitResult !== null)
  const splitBusy = useAppStore(s => s.splitJob !== null)
  const [fileStatus, setFileStatus] = useState('保存工程或导出制造文件')

  /** 网页端“退出系统”：调用开发中间件停止 dev server (重启后加载最新 vite 配置) */
  const shutdownDevServer = async () => {
    if (!window.confirm('确定退出 SnapBoard 后端 (dev server) 吗？\n退出后可重新双击“一键启动 SnapBoard.bat”启动。')) return
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
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const [projectLibraryOpen, setProjectLibraryOpen] = useState(false)
  const [projectLibraryFiles, setProjectLibraryFiles] = useState<ListedProject[]>([])
  const [projectLibraryLoading, setProjectLibraryLoading] = useState(false)
  const [workspaceDirectory, setWorkspaceDirectory] = useState<ProjectDirectoryHandle | null>(null)
  const [workspaceNeedsPermission, setWorkspaceNeedsPermission] = useState(false)
  const workspaceDirectoryRef = useRef<ProjectDirectoryHandle | null>(null)
  const currentProjectHandle = useRef<ProjectFileHandle | null>(null)
  // 擦除二级菜单: 显式点击展开 (不自动弹出遮挡画布); 切离擦除工具时自动收起
  const [eraserFlyout, setEraserFlyout] = useState(false)
  useEffect(() => {
    if (activeTool !== 'eraser') setEraserFlyout(false)
  }, [activeTool])
  const pick = (t: ToolId) => setUI({ activeTool: t })
  const cardKeys = (action: () => void) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    action()
  }

  const setContourType = (t: 'outer' | 'inner') => {
    // 顶部开关只决定【接下来新建】的轮廓类型。修改已有轮廓请使用左侧属性面板。
    // 旧行为会在外轮廓仍被选中时把它一起改成内孔，随后自动分割便找不到外轮廓。
    setUI({ newContourType: t })
  }

  const toggleViewMode = () => setUI({ viewMode: viewMode === '2d' ? '3d' : '2d' })

  const currentWorkspace = useCallback(() => {
    const state = useAppStore.getState()
    return {
      project: state.project,
      boards: state.boards,
      placedParts: state.placedParts,
      boardTexture: state.boardTexture,
      splitConfig: state.splitConfig,
      splitResult: state.splitResult,
    }
  }, [])

  const publishStorageSummary = useCallback((
    mode: 'project-library' | 'local-folder' | 'browser-download' | 'cloud',
    label: string,
    files: Array<Pick<ProjectLibraryEntry, 'name'>>,
    needsPermission = false,
  ) => {
    publishProjectStorageStatus({
      mode,
      label,
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
      publishStorageSummary(cloud ? 'cloud' : 'project-library', cloud ? '云端项目库' : '项目内“已保存项目”', files)
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

  const ensureNamedProject = useCallback(() => {
    let state = useAppStore.getState()
    if (state.project.metadata.name.trim() && state.project.metadata.name !== '未命名项目') return true
    const name = window.prompt('保存前请给项目命名', state.project.metadata.name || '未命名项目')?.trim()
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
      setWorkspaceNeedsPermission(false)
      const files = await refreshStorageSummary(directory, true)
      setFileStatus(`保存位置已设为 ${directory.name} · ${files.length} 个项目`)
    } catch (error) {
      window.alert(`保存位置设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [refreshStorageSummary])

  const saveProjectAs = useCallback(async () => {
    if (!ensureNamedProject()) return
    try {
      const workspace = currentWorkspace()
      const handle = await saveProjectFileAs(workspace)
      if (handle) {
        currentProjectHandle.current = handle
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
  }, [currentWorkspace, ensureNamedProject])

  const saveProject = useCallback(async () => {
    if (!ensureNamedProject()) return
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
        setWorkspaceNeedsPermission(false)
        setFileStatus(`项目已保存：${activeDirectory.name}/${handle.name}`)
        await refreshStorageSummary(activeDirectory)
        return
      }
      if (await saveProjectToLibrary(workspace)) {
        setFileStatus(`已保存到“已保存项目”：${workspace.project.metadata.name}.snapboard`)
        await refreshStorageSummary(null)
        return
      }
      const handle = await saveProjectFileAs(workspace)
      if (handle) {
        currentProjectHandle.current = handle
        setFileStatus(`项目已保存：系统选定位置/${handle.name}`)
      } else if (!('showSaveFilePicker' in window)) {
        downloadProjectFile(workspace)
        setFileStatus(`浏览器下载：${workspace.project.metadata.name}.snapboard`)
      }
    } catch (error) {
      window.alert(`项目保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentWorkspace, ensureNamedProject, refreshStorageSummary])

  const applyOpenedProject = useCallback((parsed: ReturnType<typeof parseProjectFile>, handle: ProjectFileHandle | null) => {
    useAppStore.getState().loadProjectWorkspace(parsed.workspace)
    currentProjectHandle.current = handle
    setProjectLibraryOpen(false)
    setFileStatus(`已打开 ${parsed.workspace.project.metadata.name}`)
  }, [])

  const openProjectFromComputer = useCallback(async () => {
    const source = await chooseProjectFile()
    if (!source) return
    try {
      const parsed = parseProjectFile(await source.file.text())
      applyOpenedProject(parsed, source.handle)
    } catch (error) {
      window.alert(`项目打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [applyOpenedProject])

  const showProjectLibrary = useCallback(async () => {
    setProjectLibraryLoading(true)
    try {
      const activeDirectory = workspaceDirectoryRef.current
      let localFiles: LocalWorkspaceProject[] = []
      if (activeDirectory) {
        const granted = await ensureLocalWorkspacePermission(activeDirectory, true)
        setWorkspaceNeedsPermission(!granted)
        if (granted) localFiles = await listLocalWorkspaceProjects(activeDirectory)
      }
      const libraryFiles = await listProjectLibrary()
      if (libraryFiles === null && !activeDirectory) {
        await openProjectFromComputer()
        return
      }
      const files: ListedProject[] = [
        ...localFiles.map(file => ({ ...file, source: 'local-folder' as const })),
        ...(libraryFiles ?? []).map(file => ({ ...file, source: 'project-library' as const })),
      ]
      files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      setProjectLibraryFiles(files)
      setProjectLibraryOpen(true)
    } catch (error) {
      window.alert(`项目库读取失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setProjectLibraryLoading(false)
    }
  }, [openProjectFromComputer])

  const openLibraryProject = useCallback(async (item: ListedProject) => {
    try {
      if (item.source === 'local-folder' && item.handle) {
        const parsed = parseProjectFile(await (await item.handle.getFile()).text())
        applyOpenedProject(parsed, item.handle)
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

  const createProject = useCallback(() => {
    const state = useAppStore.getState()
    const hasContent = state.project.parts.some(part => part.features.length > 0) || state.placedParts.length > 0
    if (hasContent && !window.confirm('新建项目会清空当前未保存的设计，是否继续？')) return
    const name = window.prompt('新项目名称', '未命名项目')?.trim()
    if (!name) return
    state.newProject(name)
    currentProjectHandle.current = null
    setProjectLibraryOpen(false)
    setFileStatus(`已新建 ${name}；保存时默认进入“已保存项目”`)
  }, [])

  const ensureSplitPanels = useCallback(() => {
    let state = useAppStore.getState()
    if (state.splitResult && state.splitResult.panels.length === 0) {
      state.runAutoSplit() // 清除此前“没有可分割轮廓”等空结果，再按当前草图重试
      state = useAppStore.getState()
    }
    if (!state.splitResult) {
      state.runAutoSplit()
      state = useAppStore.getState()
    }
    const panels = state.splitResult?.panels ?? []
    if (!panels.length) {
      const detail = state.splitResult?.warnings[0]
      throw new Error(detail || '请先绘制闭合外轮廓，再执行自动分割')
    }
    return { state, panels }
  }, [])

  const export3MF = useCallback(async () => {
    if (exportAbortRef.current) return
    try {
      const { state, panels } = ensureSplitPanels()
      const activeDirectory = workspaceDirectoryRef.current
      if (activeDirectory) {
        const granted = await ensureLocalWorkspacePermission(activeDirectory, true)
        if (!granted) {
          setWorkspaceNeedsPermission(true)
          throw new Error(`没有“${activeDirectory.name}”的写入权限，请重新点击“保存位置”授权`)
        }
      }
      const controller = new AbortController()
      exportAbortRef.current = controller
      setExporting3MF(true)
      setExportProgress(0.01)
      setFileStatus('正在准备 Lumina 纹理与板件掩膜…')
      const input = {
        panels,
        cfg: state.splitConfig,
        placedParts: state.placedParts,
        boardTexture: state.boardTexture,
        projectName: state.project.metadata.name,
        signal: controller.signal,
        onProgress: (message: string, progress?: number) => {
          setFileStatus(message)
          if (progress !== undefined) setExportProgress(Math.max(0, Math.min(1, progress)))
        },
      }
      const result = await createManufacturing3MF(input)
      const fileName = manufacturing3MFFileName(input, result.plateCount)
      setExportProgress(0.97)
      let savedLocation = ''
      let projectSnapshot = ''
      const workspace = currentWorkspace()
      if (activeDirectory) {
        const projectHandle = await writeProjectToLocalWorkspace(workspace, activeDirectory)
        currentProjectHandle.current = projectHandle
        projectSnapshot = `${activeDirectory.name}/${projectHandle.name}`
        savedLocation = await writeBinaryToLocalWorkspace(activeDirectory, fileName, result.data, '制造导出')
      } else {
        if (await saveProjectToLibrary(workspace)) {
          projectSnapshot = `已保存项目/${workspace.project.metadata.name}.snapboard`
        }
        savedLocation = await saveManufacturingToLibrary(fileName, result.data) ?? ''
        if (!savedLocation) {
          const handle = await saveManufacturingFileAs(result.data, fileName)
          if (handle === null) {
            setFileStatus('已取消 3MF 保存')
            return
          }
          if (handle) savedLocation = handle.name
          else {
            downloadBlob(new Blob([result.data as BlobPart], { type: 'model/3mf' }), safeFileName(fileName))
            savedLocation = `浏览器下载/${fileName}`
          }
        }
      }
      await refreshStorageSummary(activeDirectory)
      setExportProgress(1)
      setFileStatus(`3MF：${savedLocation}${projectSnapshot ? ` · 项目：${projectSnapshot}` : ''}`)
      if (result.warnings.length) window.alert(`3MF 已生成，但有 ${result.warnings.length} 条提示：\n${result.warnings.join('\n')}`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setFileStatus('已取消 3MF 生成')
        setExportProgress(null)
      }
      else window.alert(`3MF 导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      exportAbortRef.current = null
      setExporting3MF(false)
      window.setTimeout(() => setExportProgress(null), 1800)
    }
  }, [currentWorkspace, ensureSplitPanels, refreshStorageSummary])

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
    const onExportRequest = () => { void export3MF() }
    window.addEventListener('snapboard:export-manufacturing', onExportRequest)
    return () => window.removeEventListener('snapboard:export-manufacturing', onExportRequest)
  }, [export3MF])

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

  return (
    <div
      className={`tb${collapsed ? ' is-collapsed' : ''}`}
      role={collapsed ? 'button' : undefined}
      tabIndex={collapsed ? 0 : undefined}
      aria-expanded={collapsed ? false : undefined}
      onClick={collapsed ? onToggleCollapsed : undefined}
      onKeyDown={collapsed ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggleCollapsed?.()
        }
      } : undefined}
    >
      <div className="tb-compact-strip">
        <button type="button" onClick={event => { event.stopPropagation(); onToggleCollapsed?.() }}>⌄ 展开工具</button>
        <span>当前：{viewMode === '3d' ? '3D 装配' : '2D 草图'} · {splitActive ? `${splitResultCount} 块板件` : '尚未分割'}</span>
        <div>
          <button type="button" onClick={event => { event.stopPropagation(); void saveProject() }}>保存</button>
          <button type="button" className="manufacturing" onClick={event => { event.stopPropagation(); void export3MF() }}>3MF</button>
        </div>
      </div>
      <div className="tb-groups">
        {/* ---- 编辑工具族: 选择/擦除/智能尺寸 竖向排列; 擦除子模式右侧弹出 (Fusion 风格 flyout) ---- */}
        <div className="fam-group">
          <div className={'tb-group fam' + (SELECT_FAMILY.some(f => f.id === activeTool) ? ' active' : '')}>
            {SELECT_FAMILY.map(f => (
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
                    className={'fam-arrow-btn' + (eraserFlyout && activeTool === 'eraser' ? ' open' : '')}
                    title="点开擦除模式 (点擦除 / 快速擦除)"
                    onClick={() => setEraserFlyout(v => !v)}
                  >
                    <span className="fam-arrow">▸</span>
                  </button>
                )}
                <ToolTip title={`${f.icon} ${f.label} · ${f.key}`}>{f.help}</ToolTip>
              </div>
            ))}
          </div>

          {/* 擦除子模式: 显式点击 ▸ 弹出的二级菜单 (不再自动弹出; 高亮边框更明显) */}
          {eraserFlyout && activeTool === 'eraser' && (
            <div className="fam-flyout">
              <div className="fam-flyout-title">擦除模式 (点 ▸ 切换)</div>
              <button
                className={'fam-opt' + (eraserMode === 'point' ? ' on' : '')}
                onClick={() => setUI({ eraserMode: 'point', activeTool: 'eraser' })}
              >
                <span className="fam-opt-ic">📍</span>
                <span>
                  <b>点擦除</b>
                  <small>点击边 → 智能修剪 (交点截断 / 整边删除)</small>
                </span>
              </button>
              <button
                className={'fam-opt' + (eraserMode === 'sweep' ? ' on' : '')}
                onClick={() => setUI({ eraserMode: 'sweep', activeTool: 'eraser' })}
              >
                <span className="fam-opt-ic">🧹</span>
                <span>
                  <b>快速擦除</b>
                  <small>按住拖动扫过 → 批量删除边</small>
                </span>
              </button>
            </div>
          )}
        </div>

        {TOOLS.slice(1).map(t => (
          <div
            key={t.id}
            className={`tb-group tb-clickable tb-tool-${t.id}${activeTool === t.id ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`切换到${t.label}工具 (${t.key})`}
            onClick={() => pick(t.id)}
            onKeyDown={cardKeys(() => pick(t.id))}
          >
            <button
              className={'tb-gbtn' + (activeTool === t.id ? ' active' : '')}
              title={t.label + (t.key ? ` (${t.key})` : '')}
              onClick={() => pick(t.id)}
            >
              {t.icon} {t.label}<span className="tb-key">{t.key}</span>
            </button>
            {renderSub(t) ?? <div className="tb-card-note">快捷键 {t.key}</div>}
            <ToolTip title={`${t.icon} ${t.label} · ${t.key}`}>{t.help}</ToolTip>
          </div>
        ))}
      </div>

      <div className="tb-utility-row" aria-label="轮廓、历史、视图与生产操作">
        <div className="tb-group tb-action-group tb-file-group">
          <div className="tb-card-title">📁 文件</div>
          <div className="tb-file-actions" aria-label="项目文件与制造导出">
            <button type="button" onClick={createProject} title="新建空项目">新建</button>
            <button type="button" onClick={() => void openProject()} disabled={projectLibraryLoading} title="从默认项目库或其他位置打开 (Ctrl+O)">{projectLibraryLoading ? '读取中' : '打开'}</button>
            <button type="button" onClick={() => void saveProject()} title="保存到原文件；新项目默认写入“已保存项目” (Ctrl+S)">保存</button>
            <button type="button" onClick={() => void saveProjectAs()} title="自选文件名与保存位置">另存</button>
            <button
              type="button"
              className={workspaceDirectory ? 'storage-location active' : 'storage-location'}
              onClick={() => void selectSaveLocation()}
              title={workspaceDirectory
                ? `当前工作区：${workspaceDirectory.name}${workspaceNeedsPermission ? '（需要重新授权）' : ''}`
                : '选择一个本地文件夹作为项目和 3MF 的默认保存位置'}
            >{workspaceDirectory ? (workspaceNeedsPermission ? '授权' : `📂 ${workspaceDirectory.name}`) : '位置'}</button>
            <span className="tb-file-divider" aria-hidden="true" />
            <button type="button" className={`manufacturing${exporting3MF ? ' cancel' : ''}`}
              onClick={() => exporting3MF ? cancel3MFExport() : void export3MF()}
              title={exporting3MF ? '停止当前 3MF 生成' : '板件与配件按热床自动分盘，导出 Bambu Studio / OrcaSlicer 可打开的 3MF'}>
              {exporting3MF ? '取消' : '3MF'}
            </button>
            <button
              type="button"
              onClick={() => void shutdownDevServer()}
              title="停止网页后端 (dev server)，便于重启后加载最新的 vite 配置/中间件；重启请再次双击“一键启动 SnapBoard.bat”"
            >退出系统</button>
          </div>
          <div className="tb-file-status" title={fileStatus}>
            <strong>{workspaceDirectory ? `当前：${workspaceDirectory.name}` : '当前：项目内默认库'}</strong>
            <span>{fileStatus}</span>
          </div>
          {exportProgress !== null && <div className="tb-export-progress" role="progressbar" aria-label="3MF 导出进度"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress * 100)}>
            <i style={{ width: `${Math.max(2, exportProgress * 100)}%` }} />
            <span>{Math.round(exportProgress * 100)}%</span>
          </div>}
          <ToolTip title="项目文件与制造导出">默认写入项目内“已保存项目”；“保存位置”可授权其他本地文件夹，项目与 3MF 会一起使用该目录。另存为只改变当前项目文件。</ToolTip>
        </div>

        <div className="tb-group tb-action-group tb-history-group">
          <div className="tb-card-title">↶ 操作历史</div>
          <div className="tb-seg">
            <button onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">撤销 <span className="tb-key">Z</span></button>
            <button onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Y)">重做 <span className="tb-key">Y</span></button>
          </div>
          <ToolTip title="操作历史">撤销或重做最近的绘图与编辑操作；也可使用 Ctrl+Z / Ctrl+Y。</ToolTip>
        </div>

        <div className="tb-group tb-action-group tb-contour-group">
          <div className="tb-card-title">◎ 轮廓类型</div>
          <div className="tb-seg">
            <button className={newContourType === 'outer' ? 'on' : ''} onClick={() => setContourType('outer')}>▢ 外轮廓</button>
            <button className={newContourType === 'inner' ? 'on' : ''} onClick={() => setContourType('inner')}>◍ 内孔</button>
          </div>
          <ToolTip title="轮廓类型">决定接下来新建的是板材外边界还是挖空内孔；已有轮廓请在左侧属性栏修改。</ToolTip>
        </div>

        <button
          type="button"
          className={`tb-split-switch${splitBusy ? ' is-busy' : splitActive ? ' is-active' : ''}`}
          onClick={() => {
            runAutoSplit()
            setUI({ viewMode: '2d', splitOptionsOpen: true, partsOpen: false, textureStudioOpen: false })
            window.dispatchEvent(new Event('snapboard:expand-right-panel'))
          }}
          title={splitBusy ? '停止当前分割计算' : splitActive ? '取消分割并返回原轮廓' : '执行自动分割并打开右侧分割工作区'}
        >
          <span>{splitBusy ? '■' : splitActive ? '↩' : '⚡'}</span>
          <b>{splitBusy ? '停止分割' : splitActive ? `取消分割 · ${splitResultCount}` : '自动分割'}</b>
        </button>

        <button
          type="button"
          className={`tb-view-switch ${viewMode === '2d' ? 'is-2d' : 'is-3d'}`}
          onClick={toggleViewMode}
          role="switch"
          aria-checked={viewMode === '3d'}
          title={viewMode === '2d' ? '切换到 3D 视图（滑块滑到右侧）' : '返回 2D 草图（滑块滑到左侧）'}
        >
          <span className="tb-view-switch-label">2D</span>
          <span className="tb-view-switch-track" aria-hidden="true"><i /></span>
          <span className="tb-view-switch-label">3D</span>
        </button>

      </div>

      {!collapsed && <button type="button" className="tb-toolbar-collapse" onClick={onToggleCollapsed} title="收起顶部绘图与操作工具">⌃ 收起工具</button>}

      {projectLibraryOpen && (
        <div className="project-library-backdrop" role="presentation" onMouseDown={() => setProjectLibraryOpen(false)}>
          <section className="project-library-dialog" role="dialog" aria-modal="true" aria-label="打开 SnapBoard 项目" onMouseDown={event => event.stopPropagation()}>
            <header>
              <div>
                <strong>打开项目</strong>
                <span>{workspaceDirectory
                  ? `工作区：${workspaceDirectory.name} · 同时显示${PROJECT_STORAGE_API_BASE === '/api/project-library' ? '项目内默认库' : '云端项目库'}`
                  : PROJECT_STORAGE_API_BASE === '/api/project-library' ? '默认目录：snapboard-v2 / 已保存项目' : '当前来源：云端项目库'}</span>
              </div>
              <button type="button" onClick={() => setProjectLibraryOpen(false)} aria-label="关闭">×</button>
            </header>
            <div className="project-library-list">
              {projectLibraryFiles.length ? projectLibraryFiles.map((file, index) => (
                <button type="button" key={`${file.source}:${file.name}:${index}`} onClick={() => void openLibraryProject(file)}>
                  <span>{file.name} <em>{file.source === 'local-folder' ? workspaceDirectory?.name : PROJECT_STORAGE_API_BASE === '/api/project-library' ? '默认项目库' : '云端项目库'}</em></span>
                  <small>{new Date(file.updatedAt).toLocaleString()} · {Math.max(1, Math.round(file.size / 1024))} KB</small>
                </button>
              )) : <div className="project-library-empty">
                {workspaceDirectory
                  ? `“${workspaceDirectory.name}”和默认项目库中都没有 .snapboard 工程。请点击“保存”，或重新导出一次 3MF（会同步保存项目快照）。`
                  : '默认项目库还没有 .snapboard 工程。点击“保存”后会显示在这里；单独的 3MF 不是可继续编辑的项目。'}
              </div>}
            </div>
            <footer>
              <button type="button" onClick={() => void openProjectFromComputer()}>从其他位置选择…</button>
              <button type="button" className="secondary" onClick={() => setProjectLibraryOpen(false)}>取消</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
