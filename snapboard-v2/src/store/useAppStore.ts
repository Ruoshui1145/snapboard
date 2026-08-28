// ============ Zustand Store — 唯一数据源 ============
import { create } from 'zustand'
import type { Board, BoardTextureConfig, Project, SketchState, UIState, SplitConfig, SplitResultState, SplitSourceResult, Contour, Point2D, SplitPanel } from '../types/geometry'
import type { PlacedPart } from '../partLibrary/types'
import type { Command } from '../commands/Command'
import { computeContourState } from '../engine/solveState'
import { splitOrthogonalPolygon, PEGBOARD_DEFAULT_CONFIG } from '../utils/pegboardSplit'
import { mergeOpenChainGroups, isClosedGeo, type MergedChainGroup } from '../utils/contourMerge'
import type { ProjectWorkspaceData } from '../utils/projectFile'
import { createDefaultBoardTexture } from '../utils/boardTexture'
import type { SplitWorkerRequest, SplitWorkerResponse } from '../workers/splitEngineProtocol'

export interface SplitJobState {
  jobId: number
  phase: 'preparing' | 'partitioning' | 'committing'
  completed: number
  total: number
  startedAt: number
}

interface AppState {
  project: Project
  ui: UIState

  // ---- 洞洞板 & 配件 ----
  boards: Board[]
  placedParts: PlacedPart[]
  boardTexture: BoardTextureConfig

  // ---- 自动分割 ----
  splitConfig: SplitConfig
  splitResult: SplitResultState | null
  splitJob: SplitJobState | null

  // ---- 命令历史 ----
  undoStack: Command[]
  redoStack: Command[]

  // ---- 动作 ----
  setUI(partial: Partial<UIState>): void
  execute(command: Command): void
  undo(): void
  redo(): void
  newProject(name: string): void
  /** 用经过格式校验的项目文件完整替换当前工作区。 */
  loadProjectWorkspace(workspace: ProjectWorkspaceData): void
  setSplitConfig(partial: Partial<SplitConfig>): void
  setBoardTexture(partial: Partial<BoardTextureConfig>): void
  /** 2D/3D 共用：手动切换候选位置的贯通孔/完整板面状态。 */
  toggleEdgeHole(panelId: string, panelX: number, panelY: number, holeX: number, holeY: number): void
  openEdgeHole(panelId: string, panelX: number, panelY: number, holeX: number, holeY: number): void
  /** 【自动分割开关】: 首次生成预览；已有预览时关闭并返回原轮廓 */
  runAutoSplit(): Promise<void>
}

interface ActiveSplitTask {
  jobId: number
  worker: Worker
  reject(error: Error): void
}

let splitJobSequence = 0
let activeSplitTask: ActiveSplitTask | null = null

function abortError(message = '已取消自动分割'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function cancelActiveSplitTask(): void {
  const task = activeSplitTask
  if (!task) return
  activeSplitTask = null
  task.worker.terminate()
  task.reject(abortError())
}

function runSplitWorker(
  request: SplitWorkerRequest,
  onProgress: (completed: number, total: number) => void,
): Promise<SplitSourceResult[]> {
  // 脚本/测试环境没有 Web Worker 时保留同步降级；网页端始终走后台线程。
  if (typeof Worker === 'undefined') {
    return Promise.resolve(request.targets.map((target, index) => {
      const result = splitOrthogonalPolygon({
        points: target.points,
        holes: request.holes.length ? request.holes : undefined,
      }, request.config)
      onProgress(index + 1, request.targets.length)
      return {
        contourId: target.contourId,
        name: target.name || '未命名轮廓',
        sourceIds: target.sourceIds,
        panels: result.panels,
        warnings: result.warnings,
        coverageRatio: result.coverageRatio,
      }
    }))
  }

  cancelActiveSplitTask()
  const worker = new Worker(new URL('../workers/splitEngine.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<SplitSourceResult[]>((resolve, reject) => {
    activeSplitTask = { jobId: request.jobId, worker, reject }
    worker.onmessage = (event: MessageEvent<SplitWorkerResponse>) => {
      const response = event.data
      if (response.jobId !== request.jobId) return
      if (response.type === 'progress') {
        onProgress(response.completed, response.total)
        return
      }
      worker.terminate()
      if (activeSplitTask?.jobId === request.jobId) activeSplitTask = null
      if (response.type === 'result') resolve(response.sources)
      else reject(new Error(response.message))
    }
    worker.onerror = event => {
      worker.terminate()
      if (activeSplitTask?.jobId === request.jobId) activeSplitTask = null
      reject(new Error(event.message || '自动分割后台线程异常'))
    }
    worker.postMessage(request)
  })
}

/** 把草图内轮廓完整离散为 mm 多边形 (支持圆、槽口、圆弧边和普通闭合轮廓)。 */
function contourToHolePolygon(c: Contour, scale: number): Point2D[] | null {
  if (!c.closed || c.construction) return null
  let canvasPts: Point2D[] = []
  if (c.shape === 'circle' && c.center && c.radius && c.radius > 0) {
    const count = 48
    canvasPts = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2
      return { x: c.center!.x + c.radius! * Math.cos(a), y: c.center!.y + c.radius! * Math.sin(a) }
    })
  } else if (c.slotWidth && c.points.length >= 2) {
    const a = c.points[0]
    const b = c.points[1]
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const r = c.slotWidth / 2
    const capSteps = 16
    for (let i = 0; i <= capSteps; i++) {
      const t = angle - Math.PI / 2 + (i / capSteps) * Math.PI
      canvasPts.push({ x: b.x + Math.cos(t) * r, y: b.y + Math.sin(t) * r })
    }
    for (let i = 0; i <= capSteps; i++) {
      const t = angle + Math.PI / 2 + (i / capSteps) * Math.PI
      canvasPts.push({ x: a.x + Math.cos(t) * r, y: a.y + Math.sin(t) * r })
    }
  } else if (c.points.length >= 3) {
    for (let i = 0; i < c.points.length; i++) {
      const a = c.points[i]
      const b = c.points[(i + 1) % c.points.length]
      canvasPts.push({ ...a })
      const arc = c.arcs?.find(x => x.p1 === i)
      if (!arc) continue
      const a0 = Math.atan2(a.y - arc.center.y, a.x - arc.center.x)
      const a1 = Math.atan2(b.y - arc.center.y, b.x - arc.center.x)
      let sweep = a1 - a0
      if (arc.sweep === 'ccw') {
        while (sweep <= 0) sweep += Math.PI * 2
      } else {
        while (sweep >= 0) sweep -= Math.PI * 2
      }
      const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)))
      for (let k = 1; k < steps; k++) {
        const t = a0 + sweep * (k / steps)
        canvasPts.push({ x: arc.center.x + Math.cos(t) * arc.radius, y: arc.center.y + Math.sin(t) * arc.radius })
      }
    }
  }
  if (canvasPts.length < 3) return null
  return canvasPts.map(p => ({ x: p.x * scale, y: -p.y * scale }))
}

const coordKey = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`

/** 几何同步/重新分割后保留用户手动开关过的孔，自动推荐孔仍可随算法更新。 */
function preserveManualHoleStates(next: SplitPanel[], previous?: SplitPanel[]): void {
  if (!previous) return
  const manual = new Map<string, boolean>()
  for (const p of previous) {
    for (const h of p.edge_holes) {
      if (h.manual) manual.set(coordKey(h.x, h.y), !!h.knocked)
    }
  }
  for (const p of next) {
    for (const h of p.edge_holes) {
      const state = manual.get(coordKey(h.x, h.y))
      if (state !== undefined) {
        h.knocked = state
        h.manual = true
      }
    }
  }
}

function sameSource(a: SplitSourceResult, ids: string[], contourId: string): boolean {
  const oldIds = [...(a.sourceIds ?? [a.contourId])].sort()
  const newIds = [...ids].sort()
  return a.contourId === contourId ||
    (oldIds.length === newIds.length && oldIds.every((id, i) => id === newIds[i]))
}

/** 创建一个空项目 (含默认零件, 保证 2D 草图可工作) */
function createEmptyProject(name: string): Project {
  return {
    metadata: {
      name,
      author: '',
      version: '0.1.0',
      createdAt: new Date().toISOString(),
    },
    config: {
      pixelToMM: 0.5,
      material: 'PETG',
    },
    parts: [
      {
        id: 'part-1',
        name: '零件 1',
        features: [],
        material: { name: 'PETG', thickness: 5 },
      },
    ],
  }
}

/** 全量刷新轮廓求解状态 (execute/undo/redo 后调用, 保证约束增删/修剪后状态色同步) */
async function refreshSolveStates(get: () => AppState, set: (partial: Partial<AppState>) => void) {
  const s = get()
  const states: Record<string, SketchState> = {}
  for (const part of s.project.parts) {
    for (const f of part.features) {
      if (f.type !== 'sketch') continue
      for (const c of f.contours) {
        states[c.id] = await computeContourState(c, s.project.config.pixelToMM)
      }
    }
  }
  set({ ui: { ...get().ui, solveStates: states } })
}

/**
 * 分割结果与草图轮廓同步 (execute/undo/redo 后调用):
 *  - 源轮廓被撤销/删除 → 该来源的板材立即消失 (不再残留到下一次手动分割)
 *  - 源轮廓被重做/恢复 → 板材自动重新出现 (与轮廓图同生同灭)
 *  - 源轮廓几何变化 → 板材自动重新分割 (实时跟随)
 */
async function syncSplitToSketch(get: () => AppState, set: (partial: Partial<AppState>) => void): Promise<void> {
  const s = get()
  const sr = s.splitResult
  if (!sr || sr.sources.length === 0) return
  const cfg = s.splitConfig
  const scale = s.project.config.pixelToMM

  const allContours: Contour[] = s.project.parts
    .flatMap(p => p.features)
    .filter((f): f is Extract<typeof f, { type: 'sketch' }> => f.type === 'sketch')
    .flatMap(f => f.contours)
  const inners = allContours.filter(c => c.type === 'inner' && !c.construction)
  const toMM = (p: { x: number; y: number }) => ({ x: p.x * scale, y: -p.y * scale })
  const holePolygons = inners.map(c => contourToHolePolygon(c, scale)).filter((h): h is Point2D[] => !!h)

  const targets: SplitWorkerRequest['targets'] = []
  for (const src of sr.sources) {
    const ids = src.sourceIds ?? [src.contourId]
    const found = ids.map(id => allContours.find(c => c.id === id))
    if (found.some(c => !c)) continue // 源轮廓已不存在 → 丢弃该来源的板材
    const parts = found as Contour[]

    // 重新合并 (应对"两矩形擦公共边成 L") 并重新分割
    const groups: MergedChainGroup[] = mergeOpenChainGroups(parts.map(c => ({
      contourId: c.id, name: c.name, closed: c.closed, points: c.points,
    })))
    for (const g of groups) {
      if (!isClosedGeo(g.chain)) continue
      targets.push({
        contourId: g.chain.contourId,
        name: g.chain.name || src.name,
        sourceIds: g.sourceIds,
        points: g.chain.points.map(toMM),
      })
    }
  }

  if (targets.length === 0) {
    cancelActiveSplitTask()
    set({ splitResult: null, splitJob: null }) // 所有源轮廓都没了 → 整批清除
    return
  }

  const jobId = ++splitJobSequence
  const sourceProject = s.project
  const sourceConfig = s.splitConfig
  set({
    splitJob: {
      jobId,
      phase: 'partitioning',
      completed: 0,
      total: targets.length,
      startedAt: Date.now(),
    },
  })
  try {
    const newSources = await runSplitWorker({
      jobId,
      targets,
      holes: holePolygons,
      config: cfg,
    }, (completed, total) => {
      const current = get().splitJob
      if (current?.jobId === jobId) set({ splitJob: { ...current, completed, total } })
    })
    const current = get()
    if (current.splitJob?.jobId !== jobId || current.project !== sourceProject || current.splitConfig !== sourceConfig) {
      if (current.splitJob?.jobId === jobId) set({ splitJob: null })
      return
    }
    for (const next of newSources) {
      const previous = sr.sources.find(src => sameSource(src, next.sourceIds ?? [next.contourId], next.contourId))
      preserveManualHoleStates(next.panels, previous?.panels)
    }
    const warnings = Array.from(new Set(newSources.flatMap(x => x.warnings)))
    set({
      splitResult: {
        sources: newSources,
        panels: newSources.flatMap(x => x.panels),
        warnings,
        config: cfg,
        ts: Date.now(),
      },
      splitJob: null,
    })
  } catch (cause) {
    if (!(cause instanceof Error && cause.name === 'AbortError') && get().splitJob?.jobId === jobId) {
      set({ splitJob: null })
    }
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  project: createEmptyProject('未命名项目'),
  ui: {
    activeTool: 'select',
    lastDrawTool: 'rect',
    viewMode: '2d',
    activeSketchId: null,
    selectedFeatureId: null,
    selectedContourId: null,
    selectedConstraintId: null,
    selectedPartId: null,
    solveStates: {},
    newContourType: 'outer',
    lineSubMode: 'line',
    rectSubMode: 'corner',
    circleSubMode: 'center',
    arcSubMode: 'arc3pt',
    polygonSides: 6,
    polygonCircumscribed: false,
    eraserMode: 'point',
    splitOptionsOpen: false, // 右侧栏分割引擎默认折叠 (用时点开)
    partsOpen: true,         // 右侧栏配件库默认展开
    textureStudioOpen: false,
  },
  boards: [],
  placedParts: [],
  boardTexture: createDefaultBoardTexture(),
  splitConfig: { ...PEGBOARD_DEFAULT_CONFIG },
  splitResult: null,
  splitJob: null,
  undoStack: [],
  redoStack: [],

  setUI: (partial) => set((s) => {
    const ui = { ...s.ui, ...partial }
    // 跟踪最近一次绘图工具 (中键轮盘"返回上一步"用):
    // 只要切到绘图工具 (工具栏/快捷键/轮盘选择) 就记录 —
    // 之前只在"离开绘图工具"时记录, 导致 select→circle 这类切换不更新,
    // 轮盘一直显示"返回矩形"。
    const DRAW = new Set(['line', 'rect', 'circle', 'arc', 'polygon', 'slot', 'offset'])
    if (partial.activeTool !== undefined && DRAW.has(partial.activeTool)) {
      ui.lastDrawTool = partial.activeTool
    }
    return { ui }
  }),

  setSplitConfig: (partial) => {
    cancelActiveSplitTask()
    set((s) => ({
      splitConfig: { ...s.splitConfig, ...partial },
      splitJob: null,
    }))
  },

  setBoardTexture: (partial) =>
    set((s) => ({
      boardTexture: { ...s.boardTexture, ...partial },
    })),

  toggleEdgeHole: (panelId, panelX, panelY, holeX, holeY) =>
    set((s) => {
      if (!s.splitResult) return s
      const near = (a: number, b: number) => Math.abs(a - b) < 0.01
      const updatePanel = (panel: (typeof s.splitResult.panels)[number]) => {
        if (panel.id !== panelId || !near(panel.x, panelX) || !near(panel.y, panelY)) return panel
        return {
          ...panel,
          edge_holes: panel.edge_holes.map(h =>
            near(h.x, holeX) && near(h.y, holeY)
              ? { ...h, knocked: !h.knocked, manual: true }
              : h,
          ),
        }
      }
      const sources = s.splitResult.sources.map(src => ({
        ...src,
        panels: src.panels.map(updatePanel),
      }))
      const panels = sources.length ? sources.flatMap(src => src.panels) : s.splitResult.panels.map(updatePanel)
      return {
        splitResult: {
          ...s.splitResult,
          sources,
          panels,
          ts: Date.now(),
        },
      }
    }),

  openEdgeHole: (panelId, panelX, panelY, holeX, holeY) =>
    set((s) => {
      if (!s.splitResult) return s
      const near = (a: number, b: number) => Math.abs(a - b) < 0.01
      const updatePanel = (panel: (typeof s.splitResult.panels)[number]) => {
        if (panel.id !== panelId || !near(panel.x, panelX) || !near(panel.y, panelY)) return panel
        return {
          ...panel,
          edge_holes: panel.edge_holes.map(h =>
            near(h.x, holeX) && near(h.y, holeY)
              ? { ...h, knocked: true, manual: true }
              : h,
          ),
        }
      }
      const sources = s.splitResult.sources.map(src => ({
        ...src,
        panels: src.panels.map(updatePanel),
      }))
      const panels = sources.length ? sources.flatMap(src => src.panels) : s.splitResult.panels.map(updatePanel)
      return {
        splitResult: {
          ...s.splitResult,
          sources,
          panels,
          ts: Date.now(),
        },
      }
    }),

  // ---- 【自动分割】: 引擎读取当前草图轮廓 (选中/唯一存在), 切板 + 打孔 ----
  runAutoSplit: async () => {
    const s = get()
    // 计算中的按钮再次点击 = 立即停止；Worker 终止后主界面不会继续等待旧任务。
    if (s.splitJob) {
      cancelActiveSplitTask()
      set({ splitJob: null })
      return
    }
    // 自动分割是预览开关。关闭时只移除派生结果，草图轮廓和命令历史均不受影响。
    if (s.splitResult) {
      set({ splitResult: null })
      return
    }
    const cfg = s.splitConfig
    const scale = s.project.config.pixelToMM

    // 收集全部草图轮廓
    const allContours: Contour[] = s.project.parts
      .flatMap(p => p.features)
      .filter((f): f is Extract<typeof f, { type: 'sketch' }> => f.type === 'sketch')
      .flatMap(f => f.contours)

    const outers = allContours.filter(c => c.type === 'outer' && !c.construction && c.shape === undefined)
    const inners = allContours.filter(c => c.type === 'inner' && !c.construction)
    const holePolygons = inners.map(c => contourToHolePolygon(c, scale)).filter((h): h is Point2D[] => !!h)

    // 目标轮廓: 优先选中的外轮廓; 否则全部外轮廓 (唯一存在即视为目标)
    let targets = outers
    if (s.ui.selectedContourId) {
      const sel = allContours.find(c => c.id === s.ui.selectedContourId)
      if (sel && sel.type === 'outer' && !sel.construction) targets = [sel]
    }

    // 几何闭合判定 + 开放轮廓端点合并:
    // 两个矩形拼 L 型后擦除公共边 → 两个 open 轮廓, 端点重合 → 合并成闭合 L 型
    // mergeOpenChainGroups 返回: 已几何闭合的链 + 每条链的源轮廓 id (供撤销/重做联动)
    const mergedTargets = mergeOpenChainGroups(targets.map(c => ({
      contourId: c.id,
      name: c.name,
      closed: c.closed,
      points: c.points,
    })))
      .filter(g => isClosedGeo(g.chain))

    if (mergedTargets.length === 0) {
      set({
        splitResult: {
          sources: [],
          panels: [],
          warnings: ['没有可分割的外轮廓：请先绘制并选中一个闭合正交多边形轮廓（或用两个矩形拼出 L 型后擦除公共边，系统会自动合并）'],
          config: cfg,
          ts: Date.now(),
        },
      })
      return
    }

    // 像素(画布 y 向下) → 毫米(板面 y 向上)
    const toMM = (p: { x: number; y: number }) => ({ x: p.x * scale, y: -p.y * scale })

    const jobId = ++splitJobSequence
    const sourceProject = s.project
    const sourceConfig = s.splitConfig
    const workerTargets = mergedTargets.map(t => ({
      contourId: t.chain.contourId,
      name: t.chain.name || '未命名轮廓',
      sourceIds: t.sourceIds,
      points: t.chain.points.map(toMM),
    }))
    set({
      splitJob: {
        jobId,
        phase: 'partitioning',
        completed: 0,
        total: workerTargets.length,
        startedAt: Date.now(),
      },
    })

    try {
      const sources = await runSplitWorker({
        jobId,
        targets: workerTargets,
        holes: holePolygons,
        config: cfg,
      }, (completed, total) => {
        const current = get().splitJob
        if (current?.jobId === jobId) {
          set({ splitJob: { ...current, completed, total } })
        }
      })
      const current = get()
      // 绘图或参数已变化时丢弃旧计算，防止后台结果覆盖用户的新状态。
      if (current.splitJob?.jobId !== jobId || current.project !== sourceProject || current.splitConfig !== sourceConfig) {
        if (current.splitJob?.jobId === jobId) set({ splitJob: null })
        return
      }
      set({ splitJob: { ...current.splitJob, phase: 'committing' } })
      const warnings = Array.from(new Set(sources.flatMap(sr => sr.warnings)))
      // 让“计算完成”状态先绘制一帧，再一次性提交派生板件，避免按钮无响应的错觉。
      await new Promise<void>(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 0)
      })
      if (get().splitJob?.jobId !== jobId) return
      set({
        splitResult: {
          sources,
          panels: sources.flatMap(sr => sr.panels),
          warnings,
          config: cfg,
          ts: Date.now(),
        },
        splitJob: null,
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return
      if (get().splitJob?.jobId !== jobId) return
      set({
        splitJob: null,
        splitResult: {
          sources: [],
          panels: [],
          warnings: [`自动分割失败：${cause instanceof Error ? cause.message : String(cause)}`],
          config: cfg,
          ts: Date.now(),
        },
      })
    }
  },

  // ---- 命令模式: 所有修改都通过 execute ----
  // 注意: 命令直接 mutate project 内部对象, zustand 浅比较无法感知,
  // 因此 set 时必须给 project 做两层浅复制, 强制订阅者重渲染。
  execute: (command) => {
    cancelActiveSplitTask()
    command.execute()
    const s = get()
    set({
      project: { ...s.project, parts: s.project.parts.map(p => ({ ...p })) },
      undoStack: [...s.undoStack, command],
      redoStack: [],
      splitJob: null,
    })
    void refreshSolveStates(get, set)
    void syncSplitToSketch(get, set)
  },

  undo: () => {
    cancelActiveSplitTask()
    const { undoStack, redoStack } = get()
    if (undoStack.length === 0) return
    const cmd = undoStack[undoStack.length - 1]
    cmd.undo()
    const s = get()
    set({
      project: { ...s.project, parts: s.project.parts.map(p => ({ ...p })) },
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cmd],
      splitJob: null,
    })
    void refreshSolveStates(get, set)
    void syncSplitToSketch(get, set)
  },

  redo: () => {
    cancelActiveSplitTask()
    const { undoStack, redoStack } = get()
    if (redoStack.length === 0) return
    const cmd = redoStack[redoStack.length - 1]
    cmd.redo()
    const s = get()
    set({
      project: { ...s.project, parts: s.project.parts.map(p => ({ ...p })) },
      undoStack: [...undoStack, cmd],
      redoStack: redoStack.slice(0, -1),
      splitJob: null,
    })
    void refreshSolveStates(get, set)
    void syncSplitToSketch(get, set)
  },

  newProject: (name) => {
    cancelActiveSplitTask()
    set({
      project: createEmptyProject(name),
      boards: [],
      placedParts: [],
      boardTexture: createDefaultBoardTexture(),
      splitConfig: { ...PEGBOARD_DEFAULT_CONFIG },
      splitResult: null,
      splitJob: null,
      undoStack: [],
      redoStack: [],
      ui: {
        activeTool: 'select',
        lastDrawTool: 'rect',
        viewMode: '2d',
        activeSketchId: null,
        selectedFeatureId: null,
        selectedContourId: null,
        selectedConstraintId: null,
        selectedPartId: null,
        solveStates: {},
        newContourType: 'outer',
        lineSubMode: 'line',
        rectSubMode: 'corner',
        circleSubMode: 'center',
        arcSubMode: 'arc3pt',
        polygonSides: 6,
        polygonCircumscribed: false,
        eraserMode: 'point',
        splitOptionsOpen: false,
        partsOpen: true,
        textureStudioOpen: false,
      },
    })
  },

  loadProjectWorkspace: (workspace) => {
    cancelActiveSplitTask()
    set({
      project: workspace.project,
      boards: workspace.boards,
      placedParts: workspace.placedParts,
      boardTexture: workspace.boardTexture,
      splitConfig: workspace.splitConfig,
      splitResult: workspace.splitResult,
      splitJob: null,
      undoStack: [],
      redoStack: [],
      ui: {
        activeTool: 'select',
        lastDrawTool: 'rect',
        viewMode: '2d',
        activeSketchId: null,
        selectedFeatureId: null,
        selectedContourId: null,
        selectedConstraintId: null,
        selectedPartId: null,
        solveStates: {},
        newContourType: 'outer',
        lineSubMode: 'line',
        rectSubMode: 'corner',
        circleSubMode: 'center',
        arcSubMode: 'arc3pt',
        polygonSides: 6,
        polygonCircumscribed: false,
        eraserMode: 'point',
        splitOptionsOpen: false,
        partsOpen: true,
        textureStudioOpen: false,
      },
    })
    void refreshSolveStates(get, set)
  },
}))

// 仅开发环境暴露同一个 HMR store，供本地几何/交互回归使用；生产构建不会挂到 window。
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { __snapboardStore?: typeof useAppStore }).__snapboardStore = useAppStore
}
