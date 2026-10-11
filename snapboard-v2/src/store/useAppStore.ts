// ============ Zustand Store — 唯一数据源 ============
import { create } from 'zustand'
import { captureCadGeometry, preserveCadGeometry } from '../features/cad/lock'
import type { Board, BoardTextureConfig, Project, SketchState, UIState, SplitConfig, SplitResultState, SplitSourceResult, Contour, Point2D, SplitPanel, SvgLatticePlacement } from '../types/geometry'
import type { PlacedPart } from '../partLibrary/types'
import type { Command } from '../commands/Command'
import { computeContourState } from '../engine/solveState'
import { PEGBOARD_DEFAULT_CONFIG } from '../utils/pegboardSplit'
import { curveSegmentCount } from '../utils/curveTessellation'
import { extractPlanarFaces } from '../utils/planarFaces'
import type { ProjectWorkspaceData } from '../utils/projectFile'
import { createDefaultAssemblyScene, type AssemblySceneState } from '../assembly/mountInterfaces'
import { backTextureForRendering, boardTextureSidePatch, createBoardTextureCanvas, createDefaultBoardTexture, getSplitPanelTextureBounds, texturePanelsForSide, textureCanvasKey, hasBoardTextureSource } from '../utils/boardTexture'
import { createDefaultAssemblyMarking, projectKitCode, type AssemblyMarkingConfig } from '../utils/assemblyMarking'
import type { LastTextureSampling } from '../utils/textureSampling'
import type { SplitWorkerRequest } from '../workers/splitEngineProtocol'
import { startSplitWorker } from '../utils/splitWorkerClient'
import type { OcclusionMode } from '../utils/occlusionPolicy'
import { alignSpatialConnectionEdges, DEFAULT_SPATIAL_LAYOUT, type SpatialLayoutConfig } from '../utils/spatialLayout'
import { changePanelHole, preserveEditedHoles, type HoleMode, type HoleSelection } from '../utils/holeEditing'
import { currentWorkspace, workspaceSelection } from '../utils/workbenchNavigation'

export interface SplitJobState {
  jobId: number
  phase: 'preparing' | 'partitioning' | 'committing'
  completed: number
  total: number
  startedAt: number
}

interface TextureSolveState {
  revision: number
  solvedRevision: number
  panels: SplitPanel[] | null
  canvas: HTMLCanvasElement | null
  backCanvas: HTMLCanvasElement | null
  frontKey: string | null
  backKey: string | null
  status: 'dirty' | 'solving' | 'ready' | 'error'
  error: string | null
}

const newTextureSolve = (): TextureSolveState => ({ revision: 0, solvedRevision: -1, panels: null, canvas: null, backCanvas: null, frontKey: null, backKey: null, status: 'dirty', error: null })
const printOnlyTextureFields = new Set<keyof BoardTextureConfig>(['baseMaterialName', 'surfaceMaterialName', 'surfaceFilamentVendor', 'surfacePrintOverrides', 'baseInfillDensity',
  ])
let lastTextureEdit: { key: string; at: number; after: unknown; command: Command } | null = null

interface AppState {
  holeEditMode: boolean
  selectedHole: HoleSelection | null
  setHoleEditMode(enabled: boolean): void
  selectHole(selection: HoleSelection | null): void
  editSelectedHole(mode: HoleMode | 'restore'): void
  orderLink: ProjectWorkspaceData['orderLink']
  setOrderLink(link: ProjectWorkspaceData['orderLink']): void
  project: Project
  ui: UIState

  // ---- 洞洞板 & 配件 ----
  boards: Board[]
  placedParts: PlacedPart[]
  boardTexture: BoardTextureConfig
  textureSolve: TextureSolveState
  /** 板件背面品牌、板号、方向与接缝配对的永久制造标识。 */
  assemblyMarking: AssemblyMarkingConfig
  lastTextureSampling: LastTextureSampling | null
  /** 通用多场景装配图：宿主定义、实例层级、连接器与放置结果。 */
  assemblyScene: AssemblySceneState
  /** 遮挡分析的产品目标模式与 3D 叠加开关；属于会话 UI 状态，不写入工程。 */
  occlusionMode: OcclusionMode
  occlusionOverlayEnabled: boolean

  // ---- 自动分割 ----
  splitConfig: SplitConfig
  splitResult: SplitResultState | null
  splitJob: SplitJobState | null
  setOpenLattice(sections: Array<{ panel: SplitPanel; holes: Point2D[][]; face?: SplitPanel['latticeFace'] }>, style: 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs' | 'svg' | 'flower', legacyContourIds?: string[], svgSource?: string, placement?: SvgLatticePlacement, svgOptions?: SplitResultState['openLatticeSvgOptions'], surfaceMm?: number): void
  clearOpenLattice(): void
  spatialLayout: SpatialLayoutConfig
  /** Session-only result of the current spatial preview split. */
  spatialPreviewCount: { key: string; count: number } | null

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
  setSpatialLayout(partial: Partial<SpatialLayoutConfig>): void
  setBoardTexture(partial: Partial<BoardTextureConfig>, historyKey?: string): void
  setBoardTextureSide(side: 'front' | 'back', partial: Partial<BoardTextureConfig>): void
  runTextureSolve(): Promise<void>
  setAssemblyMarking(partial: Partial<AssemblyMarkingConfig>): void
  setLastTextureSampling(record: LastTextureSampling | null): void
  setAssemblyScene(partial: Partial<AssemblySceneState>): void
  setOcclusionMode(mode: OcclusionMode): void
  setOcclusionOverlayEnabled(enabled: boolean): void
  /** 2D/3D 共用：手动切换候选位置的贯通孔/完整板面状态。 */
  toggleEdgeHole(panelId: string, panelX: number, panelY: number, holeX: number, holeY: number): void
  openEdgeHole(panelId: string, panelX: number, panelY: number, holeX: number, holeY: number): void
  /** 【自动分割开关】: 首次生成预览；已有预览时关闭并返回原轮廓 */
  runAutoSplit(options?: { regenerate?: boolean }): Promise<void>
}

interface ActiveSplitTask {
  jobId: number
  cancel(): void
}

let splitJobSequence = 0
let activeSplitTask: ActiveSplitTask | null = null

function cancelActiveSplitTask(): void {
  const task = activeSplitTask
  if (!task) return
  activeSplitTask = null
  task.cancel()
}

function runSplitWorker(
  request: SplitWorkerRequest,
  onProgress: (completed: number, total: number) => void,
): Promise<SplitSourceResult[]> {
  cancelActiveSplitTask()
  const task = startSplitWorker(request, onProgress)
  activeSplitTask = { jobId: request.jobId, cancel: task.cancel }
  return task.promise.finally(() => { if (activeSplitTask?.jobId === request.jobId) activeSplitTask = null })
}

/** 把草图内轮廓完整离散为 mm 多边形 (支持圆、槽口、圆弧边和普通闭合轮廓)。 */
function contourToHolePolygon(c: Contour, scale: number): Point2D[] | null {
  if (!c.closed || c.construction) return null
  let canvasPts: Point2D[] = []
  if (c.shape === 'circle' && c.center && c.radius && c.radius > 0) {
    const count = Math.max(24, curveSegmentCount(c.radius, scale, Math.PI * 2))
    canvasPts = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2
      return { x: c.center!.x + c.radius! * Math.cos(a), y: c.center!.y + c.radius! * Math.sin(a) }
    })
  } else if (c.slotWidth && c.points.length >= 2) {
    const a = c.points[0]
    const b = c.points[1]
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const r = c.slotWidth / 2
    const capSteps = Math.max(8, curveSegmentCount(r, scale, Math.PI))
    for (let i = 0; i <= capSteps; i++) {
      const t = angle - Math.PI / 2 + (i / capSteps) * Math.PI
      canvasPts.push({ x: b.x + Math.cos(t) * r, y: b.y + Math.sin(t) * r })
    }
    for (let i = 0; i <= capSteps; i++) {
      const t = angle + Math.PI / 2 + (i / capSteps) * Math.PI
      canvasPts.push({ x: a.x + Math.cos(t) * r, y: a.y + Math.sin(t) * r })
    }
  } else if (c.points.length >= 3 || (c.points.length === 2 && Boolean(c.arcs?.length))) {
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
      const steps = curveSegmentCount(arc.radius, scale, Math.abs(sweep))
      for (let k = 1; k < steps; k++) {
        const t = a0 + sweep * (k / steps)
        canvasPts.push({ x: arc.center.x + Math.cos(t) * arc.radius, y: arc.center.y + Math.sin(t) * arc.radius })
      }
    }
  }
  if (canvasPts.length < 3) return null
  return canvasPts.map(p => ({ x: p.x * scale, y: -p.y * scale }))
}

/**
 * 外轮廓进入分割器前统一离散为毫米多边形。
 *
 * 分割引擎本身只接受 Point2D 多边形；旧流程把混合圆弧轮廓直接降成端点
 * 折线，导致圆角板在 2D 看起来正确、分板/3MF 却被切成尖角。复用内孔的
 * 离散逻辑，把闭合外轮廓的 arcs 按 ≤0.05mm 弦高误差（且不超过 7.5°）展开，直线轮廓仍保持
 * 原有点列和索引，避免影响开放链合并与旧工程。
 */
function contourToSplitPolygon(c: Contour, scale: number): Point2D[] | null {
  if (c.shape === 'circle' || c.shape === 'slot' || c.slotWidth !== undefined || (c.arcs?.length ?? 0) > 0) {
    return contourToHolePolygon(c, scale)
  }
  if (!c.closed || c.points.length < 3) return null
  return c.points.map(point => ({ x: point.x * scale, y: -point.y * scale }))
}

export interface PreparedSplitGeometry {
  targets: SplitWorkerRequest['targets']
  holes: Point2D[][]
}

export interface PrepareSplitGeometryOptions {
  /** 选中闭合外轮廓时只分该轮廓；选中开放图元时只保留包含该图元的有界面。 */
  selectedContourId?: string | null
  /** 多草图调用时用于避免自动面 contourId 冲突。 */
  idPrefix?: string
}

/**
 * 把一个草图中的闭合轮廓与“视觉闭合”的开放直线/圆弧图转换为分割输入。
 *
 * 不回写草图，也无需预先擦除或自动合并：开放 outer/inner 会在
 * 分割入口即时建立半边图并提取有界面。Planar face 仍保留 ArcEntity，随后统一
 * 走 contourToSplitPolygon 的自适应曲线离散，因此 2D、分割预览和 3MF 共用
 * 同一条曲线边界；sourceIds 则保持为真实源图元，供撤销/重做同步使用。
 */
export function prepareSplitGeometry(
  contours: readonly Contour[],
  scale: number,
  options: PrepareSplitGeometryOptions = {},
): PreparedSplitGeometry {
  const usable = contours.filter(contour => !contour.construction && !contour.infinite)
  const idPrefix = options.idPrefix ?? 'split-face'
  const selected = options.selectedContourId
    ? usable.find(contour => contour.id === options.selectedContourId)
    : undefined

  const closedOuters = usable.filter(contour => contour.type === 'outer' && contour.closed)
  const openOuters = usable.filter(contour => contour.type === 'outer' && !contour.closed)
  const outerFaces = extractPlanarFaces(openOuters, {
    tolerance: 0.1,
    minimumArea: 1,
    type: 'outer',
    idPrefix: `${idPrefix}-outer`,
  })

  let targets: SplitWorkerRequest['targets'] = []
  for (const contour of closedOuters) {
    const points = contourToSplitPolygon(contour, scale)
    if (!points || points.length < 3) continue
    targets.push({
      contourId: contour.id,
      name: contour.name || '未命名轮廓',
      sourceIds: [contour.id],
      points,
      cornerPolicy: contour.source ? 'preserve-source' : 'auto',
    })
  }
  for (const face of outerFaces) {
    const points = contourToSplitPolygon(face.contour, scale)
    if (!points || points.length < 3) continue
    targets.push({
      contourId: face.contour.id,
      name: face.contour.name || '自动识别区域',
      sourceIds: face.sourceIds,
      points,
      cornerPolicy: face.sourceIds.some(sourceId => usable.some(contour => contour.id === sourceId && contour.source))
        ? 'preserve-source'
        : 'auto',
    })
  }

  // 选中开放边时，选择的是它所属的完整有界面，而不是把这一小段当外轮廓；
  // 这样“点中大弧后分割”仍会带上与它首尾相接的小弧和直线。
  if (selected?.type === 'outer') {
    targets = targets.filter(target => (target.sourceIds ?? [target.contourId]).includes(selected.id))
  }

  const holeContours: Contour[] = usable
    .filter(contour => contour.type === 'inner' && contour.closed)
    .map(contour => ({ ...contour }))
  const openInnerFaces = extractPlanarFaces(
    usable.filter(contour => contour.type === 'inner' && !contour.closed),
    {
      tolerance: 0.1,
      minimumArea: 1,
      type: 'inner',
      idPrefix: `${idPrefix}-inner`,
    },
  )
  holeContours.push(...openInnerFaces.map(face => face.contour))
  const holes = holeContours
    .map(contour => contourToHolePolygon(contour, scale))
    .filter((polygon): polygon is Point2D[] => !!polygon && polygon.length >= 3)

  return { targets, holes }
}

const coordKey = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`

/** 几何同步/重新分割后保留用户手动开关过的孔，自动推荐孔仍可随算法更新。 */
function preserveManualHoleStates(next: SplitPanel[], previous: SplitPanel[] | undefined, cfg: SplitConfig): void {
  if (!previous) return
  const manual = new Map<string, boolean>()
  for (const p of previous) {
    for (const h of p.edge_holes) {
      if (h.manual && !h.editOrigin) manual.set(coordKey(h.x, h.y), !!h.knocked)
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
  preserveEditedHoles(next, previous, cfg)
}

function sameSource(a: SplitSourceResult, ids: string[], contourId: string): boolean {
  const oldIds = [...(a.sourceIds ?? [a.contourId])].sort()
  const newIds = [...ids].sort()
  return a.contourId === contourId ||
    (oldIds.length === newIds.length && oldIds.every((id, i) => id === newIds[i]))
}

/** 只比较分板实际读取的草图几何；约束标注等编辑不应重排已生成板件。 */
function splitGeometryKey(project: Project): string {
  return JSON.stringify([
    project.config.pixelToMM,
    project.parts.flatMap(part => part.features
      .filter((feature): feature is Extract<typeof feature, { type: 'sketch' }> => feature.type === 'sketch')
      .map(sketch => [sketch.id, sketch.contours.map(contour => [
        contour.id, contour.name, contour.type, contour.closed,
        contour.construction, contour.infinite, contour.shape,
        contour.slotWidth, contour.center, contour.radius, contour.arcs,
        !!contour.source, contour.points,
      ])])),
  ])
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
let solveStateRevision = 0
async function refreshSolveStates(get: () => AppState, set: (partial: Partial<AppState>) => void) {
  const revision = ++solveStateRevision
  const s = get()
  const states: Record<string, SketchState> = {}
  for (const part of s.project.parts) {
    for (const f of part.features) {
      if (f.type !== 'sketch') continue
      for (const c of f.contours) {
        states[c.id] = await computeContourState(c, s.project.config.pixelToMM)
        if (revision !== solveStateRevision || get().project !== s.project) return
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

  const sketches = s.project.parts
    .flatMap(p => p.features)
    .filter((f): f is Extract<typeof f, { type: 'sketch' }> => f.type === 'sketch')
  const contourLookup = new Map<string, { contour: Contour; sketchId: string }>()
  for (const sketch of sketches) {
    for (const contour of sketch.contours) contourLookup.set(contour.id, { contour, sketchId: sketch.id })
  }

  const targets: SplitWorkerRequest['targets'] = []
  const relevantSketchIds = new Set<string>()
  const visitedSourceSets = new Set<string>()
  let sourceSetIndex = 0
  for (const src of sr.sources) {
    const ids = [...new Set(src.sourceIds ?? [src.contourId])]
    const sourceSetKey = [...ids].sort().join('\u0001')
    if (visitedSourceSets.has(sourceSetKey)) continue
    visitedSourceSets.add(sourceSetKey)
    const found = ids.map(id => contourLookup.get(id))
    if (found.some(item => !item)) continue // 任一真实源图元被删除，旧派生面立即失效
    const entries = found as Array<{ contour: Contour; sketchId: string }>
    const sketchIds = new Set(entries.map(item => item.sketchId))
    if (sketchIds.size !== 1) continue // 不允许跨草图静默焊接
    const sketchId = entries[0].sketchId
    relevantSketchIds.add(sketchId)
    sourceSetIndex += 1
    const prepared = prepareSplitGeometry(
      entries.map(item => item.contour),
      scale,
      { idPrefix: `sync-face-${sourceSetIndex}` },
    )
    targets.push(...prepared.targets)
  }

  // 内轮廓不属于 sourceIds，但修改开孔后也必须随当前预览同步。只读取参与
  // 分割的源草图，避免两个不同草图在相同坐标处互相挖孔。
  const holePolygons = sketches
    .filter(sketch => relevantSketchIds.has(sketch.id))
    .flatMap((sketch, index) => prepareSplitGeometry(
      sketch.contours.filter(contour => contour.source?.id !== 'open-lattice-v1'),
      scale,
      { idPrefix: `sync-holes-${index + 1}` },
    ).holes)
  const passiveHoles = sketches
    .filter(sketch => relevantSketchIds.has(sketch.id))
    .flatMap((sketch, index) => prepareSplitGeometry(
      sketch.contours.filter(contour => contour.source?.id === 'open-lattice-v1'),
      scale,
      { idPrefix: `sync-lattice-${index + 1}` },
    ).holes)

  if (targets.length === 0) {
    cancelActiveSplitTask()
    set({ splitResult: null, splitJob: null }) // 所有源轮廓都没了 → 整批清除
    return
  }

  const jobId = ++splitJobSequence
  const sourceGeometry = splitGeometryKey(s.project)
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
      passiveHoles,
      config: cfg,
    }, (completed, total) => {
      const current = get().splitJob
      if (current?.jobId === jobId) set({ splitJob: { ...current, completed, total } })
    })
    const current = get()
    if (current.splitJob?.jobId !== jobId || splitGeometryKey(current.project) !== sourceGeometry || current.splitConfig !== sourceConfig) {
      if (current.splitJob?.jobId === jobId) set({ splitJob: null })
      return
    }
    const latestSources = get().splitResult?.sources ?? []
    for (const next of newSources) {
      const previous = latestSources.find(src => sameSource(src, next.sourceIds ?? [next.contourId], next.contourId))
      preserveManualHoleStates(next.panels, previous?.panels, sourceConfig)
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
    selectedContourIds: [],
    selectedConstraintId: null,
    selectedPartId: null,
    selectedTextureLayerId: null,
    selectedBackTextureLayerId: null,
    textureEditSide: 'front',
    solveStates: {},
    newContourType: 'outer',
    lineSubMode: 'line',
    rectSubMode: 'corner',
    circleSubMode: 'center',
    arcSubMode: 'arc3pt',
    polygonSides: 6,
    polygonCircumscribed: false,
    eraserMode: 'point',
    splitOptionsOpen: true, // 右侧栏分割引擎默认折叠 (用时点开)
    partsOpen: false,         // 右侧栏配件库默认展开
    structureOpen: false,
    textureStudioOpen: false,
    occlusionAnalysisOpen: false,
  },
  boards: [],
  placedParts: [],
  boardTexture: createDefaultBoardTexture(),
  textureSolve: newTextureSolve(),
  assemblyMarking: createDefaultAssemblyMarking(),
  orderLink: null,
  setOrderLink: orderLink => set({ orderLink }),
  lastTextureSampling: null,
  assemblyScene: createDefaultAssemblyScene('snapboard-pegboard-v1'),
  occlusionMode: 'balanced',
  occlusionOverlayEnabled: false,
  splitConfig: { ...PEGBOARD_DEFAULT_CONFIG },
  splitResult: null,
  splitJob: null,
  spatialLayout: { ...DEFAULT_SPATIAL_LAYOUT },
  spatialPreviewCount: null,
  holeEditMode: false,
  selectedHole: null,
  setHoleEditMode: holeEditMode => {
    if (holeEditMode) get().setUI(workspaceSelection('board'))
    set({ holeEditMode, selectedHole: null })
  },
  selectHole: selectedHole => set({ selectedHole }),
  editSelectedHole: mode => {
    const state = get(), selection = state.selectedHole
    if (!selection) return
    if (state.splitJob) throw new Error('请等板件生成完成后再编辑孔位')
    const cfg = selection.spatialKey ? { ...state.splitConfig, cornerRadius: 0 } : state.splitResult?.config ?? state.splitConfig
    if (selection.spatialKey) {
      changePanelHole(selection.panel, selection.x, selection.y, mode, cfg)
      const holeTypeOverrides = { ...state.spatialLayout.holeTypeOverrides }
      const holeOverrides = { ...state.spatialLayout.holeOverrides }
      delete holeOverrides[selection.spatialKey]
      if (mode === 'restore') delete holeTypeOverrides[selection.spatialKey]
      else holeTypeOverrides[selection.spatialKey] = mode
      get().setSpatialLayout({ holeTypeOverrides: Object.keys(holeTypeOverrides).length ? holeTypeOverrides : undefined, holeOverrides })
      return
    }
    const before = state.splitResult
    if (!before) return
    const panel = before.panels.find(item => item.id === selection.panel.id && item.x === selection.panel.x && item.y === selection.panel.y)
    if (!panel) throw new Error('该板件已改变，请重新选择孔位')
    const updated = changePanelHole(panel, selection.x, selection.y, mode, cfg)
    if (updated === panel) return
    const update = (item: SplitPanel) => item === panel || item.id === panel.id && item.x === panel.x && item.y === panel.y ? updated : item
    const after = { ...before, panels: before.panels.map(update), sources: before.sources.map(source => ({ ...source, panels: source.panels.map(update) })), ts: Date.now() }
    const apply = (splitResult: SplitResultState) => set(s => ({ splitResult,
      textureSolve: { ...s.textureSolve, revision: s.textureSolve.revision + 1, status: 'dirty', error: null } }))
    get().execute({ label: '修改单个孔', affectsSketch: false, execute: () => apply(after), undo: () => apply(before), redo: () => apply(after) })
  },
  undoStack: [],
  redoStack: [],

  setUI: (partial) => set((s) => {
    const ui = { ...s.ui, ...partial }
    if (s.spatialLayout.enabled) Object.assign(ui, workspaceSelection(currentWorkspace(ui, true)), { activeTool: ui.activeTool, viewMode: '3d' })
    if (partial.selectedContourId !== undefined && partial.selectedContourIds === undefined) {
      ui.selectedContourIds = partial.selectedContourId ? [partial.selectedContourId] : []
    } else if (partial.selectedContourIds !== undefined) {
      ui.selectedContourIds = [...new Set(partial.selectedContourIds)]
      ui.selectedContourId = ui.selectedContourIds[0] ?? null
    }
    // 切入绘图工具时记录 lastDrawTool，供中键轮盘的"返回上一步"使用。
    // 工具栏、快捷键和轮盘选择共用此逻辑。
    const DRAW = new Set(['line', 'rect', 'circle', 'arc', 'polygon', 'slot', 'offset'])
    if (partial.activeTool !== undefined && DRAW.has(partial.activeTool)) {
      ui.lastDrawTool = partial.activeTool
    }
    return { ui, ...(partial.activeTool !== undefined
      ? { holeEditMode: false, selectedHole: null } : {}) }
  }),

  setAssemblyScene: (partial) => set((s) => ({
    assemblyScene: { ...s.assemblyScene, ...partial, schemaVersion: 1 },
  })),

  setOcclusionMode: (mode) => set({ occlusionMode: mode }),
  setOcclusionOverlayEnabled: (enabled) => set({ occlusionOverlayEnabled: enabled }),

  setSplitConfig: (partial) => {
    cancelActiveSplitTask()
    set((s) => {
      const splitConfig = { ...s.splitConfig, ...partial }
      return { splitConfig, spatialLayout: alignSpatialConnectionEdges(s.spatialLayout, splitConfig), splitJob: null }
    })
  },
  setOpenLattice: (sections, style, legacyContourIds = [], svgSource, placement, svgOptions, surfaceMm) => {
    const before = get()
    const current = before.splitResult
    if (!current || before.splitJob || sections.length !== current.panels.length)
      throw new Error('板件已变化，请重新生成镂空预览')
    const panels = sections.map(({ panel, holes, face }) => ({ ...panel, latticeCutouts: holes, latticeFace: face }))
    let index = 0
    const sources = current.sources.map(source => ({ ...source,
      panels: source.panels.map(() => panels[index++]),
    }))
    const splitResult: SplitResultState = { ...current, panels, sources, openLatticeStyle: style,
      openLatticeSvg: style === 'svg' ? svgSource : undefined,
      openLatticePlacement: style === 'svg' ? placement : undefined,
      openLatticeSvgOptions: style === 'svg' || style === 'flower' ? svgOptions : undefined,
      openLatticeSurfaceMm: surfaceMm || undefined, ts: Date.now() }
    const removeIds = new Set(legacyContourIds)
    const project = removeIds.size ? { ...before.project, parts: before.project.parts.map(part => ({ ...part,
      features: part.features.map(feature => feature.type === 'sketch'
        ? { ...feature, contours: feature.contours.filter(contour => !removeIds.has(contour.id)) } : feature),
    })) } : before.project
    get().execute({
      label: current.openLatticeStyle || removeIds.size ? '更新制造镂空' : '应用制造镂空', affectsSketch: false,
      execute: () => set({ project, splitResult }),
      undo: () => set({ project: before.project, splitResult: current }),
      redo: () => set({ project, splitResult }),
    })
  },
  clearOpenLattice: () => {
    const current = get().splitResult
    if (!current?.openLatticeStyle) return
    const panels = current.panels.map(({ latticeCutouts: _latticeCutouts, latticeFace: _latticeFace, latticeOptions:_latticeOptions, ...panel }) => panel)
    let index = 0
    const sources = current.sources.map(source => ({ ...source,
      panels: source.panels.map(() => panels[index++]),
    }))
    const next: SplitResultState = { ...current, panels, sources, openLatticeStyle: undefined,
      openLatticeSvg: undefined, openLatticePlacement: undefined, openLatticeSvgOptions: undefined,
      openLatticeSurfaceMm: undefined, ts: Date.now() }
    get().execute({
      label: '移除制造镂空', affectsSketch: false,
      execute: () => set({ splitResult: next }),
      undo: () => set({ splitResult: current }),
      redo: () => set({ splitResult: next }),
    })
  },
  setSpatialLayout: (partial) => {
    const before = get().spatialLayout
    const after = alignSpatialConnectionEdges({ ...before, ...partial }, get().splitConfig)
    if (Object.keys(after).every(key => before[key as keyof SpatialLayoutConfig] === after[key as keyof SpatialLayoutConfig])) return
    const resetSelection = Object.keys(partial).some(key => key !== 'holeOverrides' && key !== 'holeTypeOverrides')
    const apply = (spatialLayout: SpatialLayoutConfig) => set(s => ({ spatialLayout,
      ...(s.spatialLayout.enabled !== spatialLayout.enabled ? { ui: { ...s.ui,
        ...workspaceSelection(currentWorkspace(s.ui), spatialLayout.enabled),
        viewMode: spatialLayout.enabled || currentWorkspace(s.ui, spatialLayout.enabled) !== 'board' ? '3d' as const : '2d' as const,
      } } : {}),
      ...(resetSelection ? { holeEditMode: false, selectedHole: null } : {}) }))
    get().execute({
      label: '修改立体版面', affectsSketch: false,
      execute: () => apply(after),
      undo: () => apply(before),
      redo: () => apply(after),
    })
  },

  setBoardTexture: (partial, historyKey) => {
    const before = get().boardTexture
    const after = { ...before, ...partial }
    // The newly selected mode wins; switching never deletes either face's artwork.
    if (partial.surfaceMode === 'veneer' || partial.surfaceMode === 'woodgrain') after.backEnabled = false
    else if (partial.backEnabled === true) after.surfaceMode = 'snapcolor'
    if (after.surfaceMode === 'woodgrain') after.surfaceFinish = 'smooth-top'
    if (Object.keys(after).every(key => before[key as keyof BoardTextureConfig] === after[key as keyof BoardTextureConfig])) return
    const modeChanged = before.surfaceMode !== after.surfaceMode || before.backEnabled !== after.backEnabled
    const key = historyKey ?? Object.keys(partial).sort().join(',')
    const apply = (boardTexture: BoardTextureConfig) => set(s => ({ boardTexture,
      ui: !boardTexture.backEnabled && s.ui.textureEditSide === 'back' ? { ...s.ui, textureEditSide: 'front' } : s.ui,
      textureSolve: Object.keys(partial).some(key => !printOnlyTextureFields.has(key as keyof BoardTextureConfig))
        ? { ...s.textureSolve, revision: s.textureSolve.revision + 1,
            status: s.textureSolve.status === 'solving' ? 'solving' : 'dirty', error: null } : s.textureSolve,
    }))
    const focusFace = () => { if (historyKey) set(s => ({ ui: { ...s.ui, textureEditSide: s.boardTexture.backEnabled && historyKey.startsWith('back:') ? 'back' : 'front' } })) }
    // A continuous slider gesture is one undo step; different fields/faces never merge.
    if (!modeChanged && lastTextureEdit?.key === key && lastTextureEdit.after === before && Date.now() - lastTextureEdit.at < 400
      && get().undoStack.at(-1) === lastTextureEdit.command && !get().redoStack.length) {
      lastTextureEdit.command.redo = () => { apply(after); focusFace() }
      lastTextureEdit.after = after; lastTextureEdit.at = Date.now()
      apply(after)
      return
    }
    const command: Command = { label: historyKey?.startsWith('back:') ? '修改背面映射' : '修改纹理映射', affectsSketch: false,
      execute: () => apply(after), undo: () => { apply(before); focusFace() }, redo: () => { apply(after); focusFace() } }
    get().execute(command)
    lastTextureEdit = { key, at: Date.now(), after, command }
  },
  setBoardTextureSide: (side, partial) => get().setBoardTexture(boardTextureSidePatch(get().boardTexture, side, partial),
    `${side}:${Object.keys(partial).sort().join(',')}`),
  runTextureSolve: async () => {
    const current = get()
    if (current.textureSolve.status === 'solving') return
    const panels = current.splitResult?.panels ?? null
    if (!panels?.length || !current.boardTexture.enabled) return
    const revision = current.textureSolve.revision
    const config = structuredClone(current.boardTexture)
    const snapshot = structuredClone(panels)
    set(s => ({ textureSolve: { ...s.textureSolve, status: 'solving', error: null } }))
    try {
      const bounds = getSplitPanelTextureBounds(snapshot)
      if (!hasBoardTextureSource(config)) throw new Error('请先为正面添加素材')
      const back = backTextureForRendering(config, snapshot, current.splitConfig, current.assemblyMarking, current.project.metadata.name)
      if (config.backEnabled && !back) throw new Error('请先为背面导入图片或选择图案')
      const backPanels = texturePanelsForSide(snapshot, 'back')
      const frontKey = textureCanvasKey(config, bounds.width / bounds.height, snapshot)
      const backKey = back ? textureCanvasKey(back, bounds.width / bounds.height, backPanels) : null
      const [canvas, backCanvas] = await Promise.all([
        current.textureSolve.frontKey === frontKey && current.textureSolve.canvas ? current.textureSolve.canvas : createBoardTextureCanvas(config, bounds.width / bounds.height, snapshot),
        back ? current.textureSolve.backKey === backKey && current.textureSolve.backCanvas ? current.textureSolve.backCanvas : createBoardTextureCanvas(back, bounds.width / bounds.height, backPanels) : null,
      ])
      if (get().textureSolve.revision !== revision || get().splitResult?.panels !== panels) {
        set(s => ({ textureSolve: { ...s.textureSolve, status: 'dirty' } }))
        return
      }
      set(s => ({ textureSolve: { ...s.textureSolve, canvas, backCanvas: backCanvas ?? s.textureSolve.backCanvas,
        frontKey, backKey: backKey ?? s.textureSolve.backKey, panels, solvedRevision: revision, status: 'ready' } }))
    } catch (error) {
      const stale = get().textureSolve.revision !== revision || get().splitResult?.panels !== panels
      set(s => ({ textureSolve: { ...s.textureSolve, status: stale ? 'dirty' : 'error', error: stale ? null : error instanceof Error ? error.message : String(error) } }))
    }
  },

  setAssemblyMarking: (partial) => {
    const before = get().assemblyMarking
    if (Object.keys(partial).every(key => before[key as keyof AssemblyMarkingConfig] === partial[key as keyof AssemblyMarkingConfig])) return
    const after = { ...before, ...partial }
    if (after.includeKitCode && !after.kitCode) after.kitCode = projectKitCode(get().project.metadata.name)
    const apply = (assemblyMarking: AssemblyMarkingConfig) => set(s => ({ assemblyMarking,
      textureSolve: { ...s.textureSolve, revision: s.textureSolve.revision + 1, status: s.textureSolve.status === 'solving' ? 'solving' : 'dirty', error: null } }))
    const key = `mark:${Object.keys(partial).sort().join(',')}`
    if (lastTextureEdit?.key === key && lastTextureEdit.after === before && Date.now() - lastTextureEdit.at < 400
      && get().undoStack.at(-1) === lastTextureEdit.command && !get().redoStack.length) {
      lastTextureEdit.command.redo = () => apply(after); lastTextureEdit.after = after; lastTextureEdit.at = Date.now(); apply(after); return
    }
    const command = { label: '修改标识与凹刻', affectsSketch: false, execute: () => apply(after), undo: () => apply(before), redo: () => apply(after) }
    get().execute(command)
    lastTextureEdit = { key, at: Date.now(), after, command }
  },
  setLastTextureSampling: (lastTextureSampling) => set({ lastTextureSampling }),

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
  runAutoSplit: async (options) => {
    const s = get()
    // 计算中的按钮再次点击 = 立即停止；Worker 终止后主界面不会继续等待旧任务。
    if (s.splitJob) {
      cancelActiveSplitTask()
      set({ splitJob: null })
      return
    }
    // 自动分割是预览开关。关闭时只移除派生结果，草图轮廓和命令历史均不受影响。
    if (s.splitResult?.panels.length && !options?.regenerate) {
      set({ splitResult: null })
      return
    }
    const cfg = s.splitConfig
    const scale = s.project.config.pixelToMM

    const sketches = s.project.parts
      .flatMap(p => p.features)
      .filter((f): f is Extract<typeof f, { type: 'sketch' }> => f.type === 'sketch')
    const activeSketch = s.ui.activeSketchId
      ? sketches.find(sketch => sketch.id === s.ui.activeSketchId)
      : undefined
    const selectedSketch = s.ui.selectedContourId
      ? sketches.find(sketch => sketch.contours.some(contour => contour.id === s.ui.selectedContourId))
      : undefined
    // 活动草图是唯一编辑坐标系；没有活动草图时再回退到选中项所属草图，
    // 最后才逐草图处理全部内容。绝不把不同草图的近邻端点拼成一个面。
    const scopedSketches = activeSketch
      ? [activeSketch]
      : selectedSketch
        ? [selectedSketch]
        : sketches
    const prepared = scopedSketches.map((sketch, index) => prepareSplitGeometry(
      sketch.contours,
      scale,
      {
        selectedContourId: sketch.contours.some(contour => contour.id === s.ui.selectedContourId)
          ? s.ui.selectedContourId
          : null,
        idPrefix: `split-${index + 1}`,
      },
    ))
    const workerTargets = prepared.flatMap(item => item.targets)
    const holePolygons = prepared.flatMap(item => item.holes)

    if (workerTargets.length === 0) {
      set({
        splitResult: {
          sources: [],
          panels: [],
          warnings: ['没有可分割的外轮廓：请绘制闭合轮廓，或让开放直线/圆弧的端点首尾精确相接形成有界区域'],
          config: cfg,
          ts: Date.now(),
        },
      })
      return
    }

    const jobId = ++splitJobSequence
    const sourceGeometry = splitGeometryKey(s.project)
    const sourceConfig = s.splitConfig
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
      if (current.splitJob?.jobId !== jobId || splitGeometryKey(current.project) !== sourceGeometry || current.splitConfig !== sourceConfig) {
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
      const latestSources = get().splitResult?.sources ?? []
      for (const next of sources) {
        const previous = latestSources.find(src => sameSource(src, next.sourceIds ?? [next.contourId], next.contourId))
        preserveManualHoleStates(next.panels, previous?.panels, cfg)
      }
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
      const warning = `自动分割失败：${cause instanceof Error ? cause.message : String(cause)}`
      set({
        splitJob: null,
        splitResult: s.splitResult?.panels.length
          ? { ...s.splitResult, warnings: [...s.splitResult.warnings, warning] }
          : { sources: [], panels: [], warnings: [warning], config: cfg, ts: Date.now() },
      })
    }
  },

  // ---- 命令模式: 所有修改都通过 execute ----
  // 注意: 命令直接 mutate project 内部对象, zustand 浅比较无法感知,
  // 因此 set 时必须给 project 做两层浅复制, 强制订阅者重渲染。
  execute: (command) => {
    const cadGeometry = captureCadGeometry(get().project)
    const affectsSketch = command.affectsSketch !== false
    const before = affectsSketch && (get().splitResult || get().splitJob) ? splitGeometryKey(get().project) : null
    command.execute()
    preserveCadGeometry(get().project, cadGeometry)
    const s = get()
    const geometryChanged = before !== null && before !== splitGeometryKey(s.project)
    if (geometryChanged) cancelActiveSplitTask()
    set({
      ...(affectsSketch ? { project: { ...s.project, parts: s.project.parts.map(p => ({ ...p })) } } : {}),
      undoStack: [...s.undoStack, command],
      redoStack: [],
      splitJob: geometryChanged ? null : s.splitJob,
    })
    if (affectsSketch) {
      void refreshSolveStates(get, set)
      if (geometryChanged) void syncSplitToSketch(get, set)
    }
  },

  undo: () => {
    const { undoStack, redoStack } = get()
    if (undoStack.length === 0) return
    const cmd = undoStack[undoStack.length - 1]
    const affectsSketch = cmd.affectsSketch !== false
    const before = affectsSketch && (get().splitResult || get().splitJob) ? splitGeometryKey(get().project) : null
    cmd.undo()
    const s = get()
    const geometryChanged = before !== null && before !== splitGeometryKey(s.project)
    if (geometryChanged) cancelActiveSplitTask()
    set({
      ...(affectsSketch ? { project: { ...s.project, parts: s.project.parts.map(p => ({ ...p })) } } : {}),
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cmd],
      splitJob: geometryChanged ? null : s.splitJob,
    })
    if (affectsSketch) {
      void refreshSolveStates(get, set)
      if (geometryChanged) void syncSplitToSketch(get, set)
    }
  },

  redo: () => {
    const { undoStack, redoStack } = get()
    if (redoStack.length === 0) return
    const cmd = redoStack[redoStack.length - 1]
    const affectsSketch = cmd.affectsSketch !== false
    const before = affectsSketch && (get().splitResult || get().splitJob) ? splitGeometryKey(get().project) : null
    const cadGeometry = captureCadGeometry(get().project)
    cmd.redo()
    preserveCadGeometry(get().project, cadGeometry)
    const s = get()
    const geometryChanged = before !== null && before !== splitGeometryKey(s.project)
    if (geometryChanged) cancelActiveSplitTask()
    set({
      ...(affectsSketch ? { project: { ...s.project, parts: s.project.parts.map(p => ({ ...p })) } } : {}),
      undoStack: [...undoStack, cmd],
      redoStack: redoStack.slice(0, -1),
      splitJob: geometryChanged ? null : s.splitJob,
    })
    if (affectsSketch) {
      void refreshSolveStates(get, set)
      if (geometryChanged) void syncSplitToSketch(get, set)
    }
  },

  newProject: (name) => {
    cancelActiveSplitTask()
    set({
      holeEditMode: false, selectedHole: null,
      orderLink: null,
      project: createEmptyProject(name),
      boards: [],
      placedParts: [],
      boardTexture: createDefaultBoardTexture(),
      textureSolve: newTextureSolve(),
      assemblyMarking: createDefaultAssemblyMarking(),
      lastTextureSampling: null,
      assemblyScene: createDefaultAssemblyScene('snapboard-pegboard-v1'),
      occlusionOverlayEnabled: false,
      splitConfig: { ...PEGBOARD_DEFAULT_CONFIG },
      splitResult: null,
      splitJob: null,
      spatialLayout: { ...DEFAULT_SPATIAL_LAYOUT },
      spatialPreviewCount: null,
      undoStack: [],
      redoStack: [],
      ui: {
        activeTool: 'select',
        lastDrawTool: 'rect',
        viewMode: '2d',
        activeSketchId: null,
        selectedFeatureId: null,
        selectedContourId: null,
        selectedContourIds: [],
        selectedConstraintId: null,
        selectedPartId: null,
        selectedTextureLayerId: null,
        selectedBackTextureLayerId: null,
        textureEditSide: 'front',
        solveStates: {},
        newContourType: 'outer',
        lineSubMode: 'line',
        rectSubMode: 'corner',
        circleSubMode: 'center',
        arcSubMode: 'arc3pt',
        polygonSides: 6,
        polygonCircumscribed: false,
        eraserMode: 'point',
        splitOptionsOpen: true,
        partsOpen: false,
        structureOpen: false,
        textureStudioOpen: false,
        occlusionAnalysisOpen: false,
      },
    })
  },

  loadProjectWorkspace: (workspace) => {
    cancelActiveSplitTask()
    set({
      holeEditMode: false, selectedHole: null,
      orderLink: workspace.orderLink ?? null,
      project: workspace.project,
      boards: workspace.boards,
      placedParts: workspace.placedParts,
      boardTexture: workspace.boardTexture,
      textureSolve: newTextureSolve(),
      assemblyMarking: workspace.assemblyMarking,
      lastTextureSampling: workspace.lastTextureSampling ?? null,
      assemblyScene: workspace.assemblyScene,
      occlusionOverlayEnabled: false,
      splitConfig: workspace.splitConfig,
      splitResult: workspace.splitResult,
      splitJob: null,
      spatialLayout: alignSpatialConnectionEdges(workspace.spatialLayout, workspace.splitConfig),
      spatialPreviewCount: null,
      undoStack: [],
      redoStack: [],
      ui: {
        activeTool: 'select',
        lastDrawTool: 'rect',
        viewMode: workspace.spatialLayout.enabled ? '3d' : '2d',
        activeSketchId: null,
        selectedFeatureId: null,
        selectedContourId: null,
        selectedContourIds: [],
        selectedConstraintId: null,
        selectedPartId: null,
        selectedTextureLayerId: null,
        selectedBackTextureLayerId: null,
        textureEditSide: 'front',
        solveStates: {},
        newContourType: 'outer',
        lineSubMode: 'line',
        rectSubMode: 'corner',
        circleSubMode: 'center',
        arcSubMode: 'arc3pt',
        polygonSides: 6,
        polygonCircumscribed: false,
        eraserMode: 'point',
        splitOptionsOpen: true,
        partsOpen: false,
        structureOpen: false,
        textureStudioOpen: false,
        occlusionAnalysisOpen: false,
      },
    })
    void refreshSolveStates(get, set)
  },
}))

// 仅开发环境暴露同一个 HMR store，供本地几何/交互回归使用；生产构建不会挂到 window。
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { __snapboardStore?: typeof useAppStore }).__snapboardStore = useAppStore
}
