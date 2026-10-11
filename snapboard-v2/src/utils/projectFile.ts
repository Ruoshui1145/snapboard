import type { PlacedPart } from '../partLibrary/types'
import type {
  ArcEntity,
  Board,
  BoardTextureConfig,
  Contour,
  Feature,
  Part,
  Project,
  SplitConfig,
  SplitPanel,
  SplitResultState,
} from '../types/geometry'
import { PEGBOARD_DEFAULT_CONFIG } from './pegboardSplit'
import { createDefaultBoardTexture } from './boardTexture'
import { normalizeWoodGrain, normalizeWoodGrainTexture } from './woodGrain'
import { normalizeSnapColorLutId } from './snapColorLut'
import { createDefaultAssemblyScene, normalizeAssemblyScene, type AssemblySceneState } from '../assembly/mountInterfaces'
import { normalizeTextureComposition } from './textureComposition'
import { normalizeTexturePattern } from './texturePatterns'
import { createSnapBoardAttribution, normalizeSnapBoardAttribution, type SnapBoardAttribution } from './snapboardAttribution'
import { createDefaultAssemblyMarking, normalizeAssemblyMarking, projectKitCode, type AssemblyMarkingConfig } from './assemblyMarking'
import { normalizeLastTextureSampling, type LastTextureSampling } from './textureSampling'
import { alignSpatialConnectionEdges, DEFAULT_SPATIAL_LAYOUT, type SpatialLayoutConfig } from './spatialLayout'

export const SNAPBOARD_PROJECT_FORMAT = 'snapboard-project' as const
export const SNAPBOARD_PROJECT_SCHEMA_VERSION = 1 as const

/**
 * 可恢复编辑状态的工作区数据。命令历史、临时选择和相机位置属于会话状态，不写入项目文件。
 */
export interface FarmOrderLink { id: string; number: string }
export function normalizeFarmOrderLink(value: unknown): FarmOrderLink | null {
  if(import.meta.env.VITE_SNAPBOARD_EDITION==='diy')return null
  if (value === undefined || value === null) return null
  const link = value as FarmOrderLink
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(link.id)
    || !/^SB-\d{8}-\d{4}$/.test(link.number)) throw new Error('工程订单关联信息无效')
  return { id: link.id, number: link.number }
}

export interface ProjectWorkspaceData {
  /** Farm only: store identifiers here; customer data stays in the local order DB. */
  orderLink?: FarmOrderLink | null
  project: Project
  boards: Board[]
  placedParts: PlacedPart[]
  boardTexture: BoardTextureConfig
  assemblyMarking: AssemblyMarkingConfig
  /** 通用安装场景；旧工程缺失时回退到现有洞洞板宿主。 */
  assemblyScene: AssemblySceneState
  splitConfig: SplitConfig
  /** 保留派生板件及用户手动开/关孔状态；关闭自动分割时为 null。 */
  splitResult: SplitResultState | null
  /** Optional in older projects; a separate parametric 3D board layout. */
  spatialLayout: SpatialLayoutConfig
  /** Last successfully saved coupon export; older projects omit it. */
  lastTextureSampling?: LastTextureSampling | null
}

/** Shared by file saving and farm orders; session UI/history never enters either. */
export function projectWorkspaceFromState(state: ProjectWorkspaceData): ProjectWorkspaceData {
  return { project: state.project, boards: state.boards, placedParts: state.placedParts, boardTexture: state.boardTexture,
    assemblyMarking: state.assemblyMarking, assemblyScene: state.assemblyScene, splitConfig: state.splitConfig,
    splitResult: state.splitResult, spatialLayout: state.spatialLayout, lastTextureSampling: state.lastTextureSampling,
    orderLink: state.orderLink }
}

export function sameManufacturingWorkspace(first: ProjectWorkspaceData, second: ProjectWorkspaceData): boolean {
  return (Object.keys(first) as Array<keyof ProjectWorkspaceData>).every(key =>
    key === 'orderLink' || key === 'lastTextureSampling' || first[key] === second[key])
}

export interface SnapBoardProjectFile {
  format: typeof SNAPBOARD_PROJECT_FORMAT
  schemaVersion: typeof SNAPBOARD_PROJECT_SCHEMA_VERSION
  appVersion: string
  savedAt: string
  attribution: SnapBoardAttribution
  workspace: ProjectWorkspaceData
}

export interface SnapBoardManufacturingFile {
  format: 'snapboard-manufacturing'
  schemaVersion: 1
  exportedAt: string
  attribution: SnapBoardAttribution
  units: 'millimeter'
  project: { name: string; version: string }
  config: SplitConfig
  panels: SplitPanel[]
  assemblyMarking?: AssemblyMarkingConfig
}

/**
 * 旧工程可能已把图片/SVG离散台阶保存为可圆角顶点。根据草图中仍然存在的
 * source 元数据清除这类派生 roundIdx；只修派生圆角，不触碰面板轮廓和孔位。
 */
export function restoreImportedCornerPolicy(project: Project, splitResult: SplitResultState | null): SplitResultState | null {
  if (!splitResult?.sources.length) return splitResult
  const importedContourIds = new Set(project.parts.flatMap(part => part.features).flatMap(feature =>
    feature.type === 'sketch'
      ? feature.contours.filter(contour => Boolean(contour.source)).map(contour => contour.id)
      : []))
  if (!importedContourIds.size) return splitResult
  let changed = false
  const sources = splitResult.sources.map(source => {
    const ids = source.sourceIds ?? [source.contourId]
    if (!ids.some(id => importedContourIds.has(id))) return source
    const panels = source.panels.map(panel => {
      if (!(panel.roundIdx?.length)) return panel
      changed = true
      return { ...panel, roundIdx: [] }
    })
    return panels === source.panels ? source : { ...source, panels }
  })
  if (!changed) return splitResult
  return {
    ...splitResult,
    sources,
    panels: sources.flatMap(source => source.panels),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isPoint = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x) && isFiniteNumber(value.y)
}

function isContour(value: unknown): value is Contour {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    (value.type === 'outer' || value.type === 'inner') &&
    typeof value.name === 'string' &&
    typeof value.closed === 'boolean' &&
    Array.isArray(value.points) && value.points.every(isPoint) &&
    Array.isArray(value.constraints)
}

/**
 * 校验并清理单个圆弧实体。返回 null 表示丢弃该弧 (不因此拒绝整个轮廓)。
 * 清理规则向后兼容: 旧工程中合法的数据一律原样保留。
 */
function sanitizeArc(value: unknown, pointCount: number): ArcEntity | null {
  if (!isRecord(value)) return null
  const { id, p1, p2, radius, sweep, center } = value
  if (typeof id !== 'string') return null
  if (typeof p1 !== 'number' || !Number.isInteger(p1)) return null
  if (typeof p2 !== 'number' || !Number.isInteger(p2)) return null
  if (pointCount > 0 && (p1 < 0 || p1 >= pointCount || p2 < 0 || p2 >= pointCount)) return null
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) return null
  if (sweep !== 'ccw' && sweep !== 'cw') return null
  if (!isRecord(center) || typeof center.x !== 'number' || typeof center.y !== 'number') return null
  const next: ArcEntity = {
    id, p1, p2, center: { x: center.x, y: center.y }, radius, sweep,
  }
  if (value.radiusDriving === true) next.radiusDriving = true
  return next
}

/**
 * 轮廓加载时的字段加固。
 *
 * 只丢弃非法的可选字段，保留已通过必填字段校验的轮廓，
 * 避免历史工程因个别可选字段损坏而无法打开。
 * 通过 isContour 的必填字段判定后, 对 arcs / center / radius / slotWidth / slotParams
 * 逐个校验; 合法则保留, 非法则删除该字段 (回退到缺省语义)。
 */
export function sanitizeContour(value: unknown): Contour | null {
  if (!isContour(value)) return null
  const contour = value as Contour
  const pointCount = contour.points.length

  if (Array.isArray(contour.arcs)) {
    const arcs = contour.arcs
      .map(arc => sanitizeArc(arc, pointCount))
      .filter((arc): arc is ArcEntity => arc !== null)
    if (arcs.length > 0) contour.arcs = arcs
    else delete contour.arcs
  } else if ('arcs' in contour) {
    delete contour.arcs
  }

  if (contour.center !== undefined && !isPoint(contour.center)) delete contour.center
  if (contour.radius !== undefined && (!isFiniteNumber(contour.radius) || contour.radius <= 0)) delete contour.radius
  if (contour.slotWidth !== undefined && (!isFiniteNumber(contour.slotWidth) || contour.slotWidth <= 0)) delete contour.slotWidth

  const slot = contour.slotParams
  if (slot !== undefined) {
    const ok = isRecord(slot) && isFiniteNumber(slot.length) && slot.length > 0
      && isFiniteNumber(slot.width) && slot.width > 0
    if (ok) contour.slotParams = { length: (slot as { length: number }).length, width: (slot as { width: number }).width }
    else delete contour.slotParams
  }

  // slotParams 与 slotWidth 保持一致, 避免两处宽度语义打架
  if (contour.slotParams) contour.slotWidth = contour.slotParams.width
  else if (contour.slotWidth !== undefined && contour.points.length >= 2) {
    const [a, b] = contour.points
    const centerline = Math.hypot(b.x - a.x, b.y - a.y)
    contour.slotParams = { length: centerline + contour.slotWidth, width: contour.slotWidth }
  }

  if (contour.construction !== undefined && typeof contour.construction !== 'boolean') delete contour.construction
  if (contour.infinite !== undefined && typeof contour.infinite !== 'boolean') delete contour.infinite
  if (contour.rotation !== undefined && !isFiniteNumber(contour.rotation)) delete contour.rotation
  if (contour.polygonCircumscribed !== undefined && typeof contour.polygonCircumscribed !== 'boolean') delete contour.polygonCircumscribed

  return contour
}

function isFeature(value: unknown): value is Feature {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.type !== 'string') return false
  if (value.type === 'sketch') {
    if (value.plane !== 'xy' && value.plane !== 'xz' && value.plane !== 'yz') return false
    if (!Array.isArray(value.contours)) return false
    // 先全量清理再判定: 避免 Array.every 短路导致后续轮廓漏掉字段加固
    const cleaned = value.contours.map(entry => sanitizeContour(entry))
    if (cleaned.some(entry => entry === null)) return false
    value.contours = cleaned as Contour[]
    return true
  }
  return value.type === 'extrude' || value.type === 'hole' || value.type === 'holePattern'
}

function isPart(value: unknown): value is Part {
  if (!isRecord(value) || !isRecord(value.material)) return false
  return typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.material.name === 'string' &&
    isFiniteNumber(value.material.thickness) &&
    Array.isArray(value.features) && value.features.every(isFeature)
}

function isProject(value: unknown): value is Project {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.config)) return false
  return typeof value.metadata.name === 'string' &&
    typeof value.metadata.author === 'string' &&
    typeof value.metadata.version === 'string' &&
    typeof value.metadata.createdAt === 'string' &&
    isFiniteNumber(value.config.pixelToMM) && value.config.pixelToMM > 0 &&
    typeof value.config.material === 'string' &&
    Array.isArray(value.parts) && value.parts.every(isPart)
}

function isBoard(value: unknown): value is Board {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.contour) && value.contour.every(isPoint) &&
    isFiniteNumber(value.thickness) &&
    isRecord(value.holePattern) &&
    isRecord(value.split) &&
    isRecord(value.position)
}

function isPlacedPart(value: unknown): value is PlacedPart {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.defId === 'string' &&
    isFiniteNumber(value.rotation) &&
    isRecord(value.params)
}

function isHolePos(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    (value.knocked === undefined || typeof value.knocked === 'boolean') &&
    (value.manual === undefined || typeof value.manual === 'boolean') &&
    (value.editOrigin === undefined || isRecord(value.editOrigin) &&
      ['slots', 'round_holes', 'edge_holes'].includes(value.editOrigin.group as string) &&
      (value.editOrigin.index === undefined || isFiniteNumber(value.editOrigin.index) && Number.isInteger(value.editOrigin.index) && value.editOrigin.index >= 0) &&
      (value.editOrigin.knocked === undefined || typeof value.editOrigin.knocked === 'boolean') &&
      (value.editOrigin.manual === undefined || typeof value.editOrigin.manual === 'boolean'))
}

function isSplitPanel(value: unknown): value is SplitPanel {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    isFiniteNumber(value.w) && isFiniteNumber(value.h) &&
    Array.isArray(value.slots) && value.slots.every(isHolePos) &&
    Array.isArray(value.round_holes) && value.round_holes.every(isHolePos) &&
    Array.isArray(value.edge_holes) && value.edge_holes.every(isHolePos) &&
    (value.closed_holes === undefined || Array.isArray(value.closed_holes) && value.closed_holes.every(isHolePos)) &&
    (value.contour === undefined || (Array.isArray(value.contour) && value.contour.every(isPoint))) &&
    (value.cutouts === undefined || (Array.isArray(value.cutouts) && value.cutouts.every(hole => Array.isArray(hole) && hole.every(isPoint)))) &&
    (value.latticeCutouts === undefined || (Array.isArray(value.latticeCutouts) && value.latticeCutouts.every(hole => Array.isArray(hole) && hole.every(isPoint)))) &&
    (value.latticeOptions === undefined || (isRecord(value.latticeOptions) && typeof value.latticeOptions.fillWindows === 'boolean' &&
      typeof value.latticeOptions.openCoreCaps === 'boolean' && isFiniteNumber(value.latticeOptions.cellPitchMm) && value.latticeOptions.cellPitchMm >= 8 && value.latticeOptions.cellPitchMm <= 32 &&
      isFiniteNumber(value.latticeOptions.cellRibMm) && value.latticeOptions.cellRibMm >= 1.26 && value.latticeOptions.cellRibMm <= 3)) &&
    (value.latticeFace === undefined || (isRecord(value.latticeFace) &&
      (value.latticeFace.source === undefined || (isRecord(value.latticeFace.source) &&
        (value.latticeFace.source.templateStyle === undefined || ['organic', 'hex', 'diamond', 'honeycomb', 'ribs'].includes(value.latticeFace.source.templateStyle as string)) &&
        (value.latticeFace.source.silhouette === undefined || (Array.isArray(value.latticeFace.source.silhouette) &&
          value.latticeFace.source.silhouette.every(p => Array.isArray(p) && p.length > 0 &&
            p.every(r => Array.isArray(r) && r.length >= 3 && r.every(isPoint))))) &&
        typeof value.latticeFace.source.signature === 'string' && value.latticeFace.source.signature.length <= 300_000 &&
        isSvgLatticeOptions(value.latticeFace.source.options) &&
        Array.isArray(value.latticeFace.source.artwork) && value.latticeFace.source.artwork.every(p =>
          Array.isArray(p) && p.length > 0 && p.every(r => Array.isArray(r) && r.length >= 3 && r.every(isPoint))))) &&
      (value.latticeFace.contrastColor === undefined || (typeof value.latticeFace.contrastColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.latticeFace.contrastColor))) &&
      Array.isArray(value.latticeFace.layers) && value.latticeFace.layers.length <= 4 &&
      value.latticeFace.layers.every(layer => isRecord(layer) && ['structure', 'backing', 'face', 'detail'].includes(layer.role as string) &&
        isFiniteNumber(layer.zMin) && isFiniteNumber(layer.zMax) && layer.zMin >= 0 && layer.zMax > layer.zMin && layer.zMax <= 100 &&
        Array.isArray(layer.polygons) && layer.polygons.every(p => Array.isArray(p) && p.length > 0 &&
          p.every(r => Array.isArray(r) && r.length >= 3 && r.every(isPoint))))))
}

function isSvgLatticeOptions(value: unknown): boolean {
  return isRecord(value) && ['cutout', 'fidelity'].includes(value.mode as string) &&
    isFiniteNumber(value.lineWidthMm) && value.lineWidthMm >= 0.84 && value.lineWidthMm <= 4 &&
    isFiniteNumber(value.backingMm) && value.backingMm >= 0.8 && value.backingMm <= 2 &&
    (value.coverage === undefined || ['artwork', 'whole'].includes(value.coverage as string)) &&
    (value.padShape === undefined || ['rectangle', 'silhouette', 'contour'].includes(value.padShape as string)) &&
    (value.outlineGapMm === undefined || (isFiniteNumber(value.outlineGapMm) && value.outlineGapMm >= 0 && value.outlineGapMm <= 10)) &&
    (value.baseStyle === undefined || ['organic', 'hex', 'diamond', 'honeycomb', 'ribs'].includes(value.baseStyle as string)) &&
    (value.sourceLayerId === undefined || (typeof value.sourceLayerId === 'string' && value.sourceLayerId.length <= 200)) &&
    (value.sourceSignature === undefined || (typeof value.sourceSignature === 'string' && value.sourceSignature.length <= 20_000)) &&
    (value.contrastColor === undefined || (typeof value.contrastColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.contrastColor)))
}

function normalizeSplitConfig(value: unknown): SplitConfig {
  if (!isRecord(value)) throw new Error('项目缺少有效的分割参数')
  const next: SplitConfig = { ...PEGBOARD_DEFAULT_CONFIG, bedKeepouts: [] }
  for (const key of Object.keys(next).filter(key => key !== 'bedKeepouts') as Array<keyof SplitConfig>) {
    const candidate = value[key]
    const fallback = next[key]
    if (typeof fallback === 'boolean') {
      if (typeof candidate === 'boolean') (next[key] as boolean) = candidate
    } else if (typeof fallback === 'string') {
      if (typeof candidate === 'string') (next[key] as string) = candidate
    } else if (isFiniteNumber(candidate)) {
      (next[key] as number) = candidate
    }
  }
  if (Array.isArray(value.bedKeepouts)) {
    next.bedKeepouts = value.bedKeepouts.flatMap((item, index) => {
      if (!isRecord(item) || !isFiniteNumber(item.x) || !isFiniteNumber(item.y) ||
          !isFiniteNumber(item.w) || !isFiniteNumber(item.h)) return []
      return [{
        id: typeof item.id === 'string' ? item.id : `keepout-${index + 1}`,
        name: typeof item.name === 'string' ? item.name : `禁放区 ${index + 1}`,
        x: item.x, y: item.y,
        w: Math.max(0, item.w), h: Math.max(0, item.h),
        enabled: item.enabled !== false,
      }]
    })
  }
  return next
}

export function normalizeSpatialLayout(value: unknown, cfg: SplitConfig = PEGBOARD_DEFAULT_CONFIG): SpatialLayoutConfig {
  const next = { ...DEFAULT_SPATIAL_LAYOUT }
  if (!isRecord(value)) return next
  if (typeof value.enabled === 'boolean') next.enabled = value.enabled
  if (value.template === 'L' || value.template === 'U' || value.template === 'prism' || value.template === 'cylinder') next.template = value.template
  if (isFiniteNumber(value.polygonSides) && Number.isSafeInteger(value.polygonSides) && value.polygonSides >= 3) next.polygonSides = value.polygonSides
  for (const key of ['width', 'depth', 'height', 'customPrintHeight'] as const) {
    if (isFiniteNumber(value[key]) && value[key] >= 20 && value[key] <= 5000) next[key] = value[key]
  }
  if (isFiniteNumber(value.angleDegrees) && value.angleDegrees >= 45 && value.angleDegrees <= 150) next.angleDegrees = value.angleDegrees
  if (isFiniteNumber(value.printSafetyMarginMm) && value.printSafetyMarginMm >= 0 && value.printSafetyMarginMm <= 25) next.printSafetyMarginMm = value.printSafetyMarginMm
  if (value.bendStyle === 'round' || value.bendStyle === 'chamfer') next.bendStyle = value.bendStyle
  if (isFiniteNumber(value.bendSizeMm) && value.bendSizeMm >= 0 && value.bendSizeMm <= 80) next.bendSizeMm = value.bendSizeMm
  if (isFiniteNumber(value.cornerHoleInsetMm) && value.cornerHoleInsetMm >= 5 && value.cornerHoleInsetMm <= 120) next.cornerHoleInsetMm = value.cornerHoleInsetMm
  if (value.manufacturingMode === 'auto' || value.manufacturingMode === 'monolithic') next.manufacturingMode = 'monolithic'
  if (value.manufacturingMode === 'per-face' || value.manufacturingMode === 'bed-split') next.manufacturingMode = 'bed-split'
  if (typeof value.printedAngleConnector === 'boolean') next.printedAngleConnector = value.printedAngleConnector
  if (isFiniteNumber(value.connectorClearanceMm) && value.connectorClearanceMm >= 0.1 && value.connectorClearanceMm <= 0.7) {
    next.connectorClearanceMm = value.connectorClearanceMm
  }
  if (isRecord(value.holeOverrides)) {
    next.holeOverrides = Object.fromEntries(Object.entries(value.holeOverrides)
      .filter((entry): entry is [string, boolean] =>
        /^-?\d+,-?\d+$/.test(entry[0]) && typeof entry[1] === 'boolean')
      .slice(0, 10000))
  }
  if (isRecord(value.holeTypeOverrides)) {
    const types = Object.fromEntries(Object.entries(value.holeTypeOverrides)
      .filter((entry): entry is [string, 'slot' | 'round' | 'closed'] =>
        /^-?\d+,-?\d+$/.test(entry[0]) && ['slot', 'round', 'closed'].includes(entry[1] as string))
      .slice(0, 10000))
    if (Object.keys(types).length) next.holeTypeOverrides = types
  }
  return alignSpatialConnectionEdges(next, cfg)
}

function normalizeBoardTexture(value: unknown, isBack = false): BoardTextureConfig {
  const next = createDefaultBoardTexture()
  if (!isRecord(value)) return next
  if (typeof value.enabled === 'boolean') next.enabled = value.enabled
  if (value.source === 'preset' || value.source === 'image' || value.source === 'composition' || value.source === 'pattern') next.source = value.source
  if (typeof value.presetId === 'string' && value.presetId.length <= 80) next.presetId = value.presetId
  next.composition = normalizeTextureComposition(value.composition)
  next.pattern = normalizeTexturePattern(isRecord(value.pattern) ? value.pattern : next.pattern)
  if (typeof value.imageDataUrl === 'string' && value.imageDataUrl.startsWith('data:image/') && value.imageDataUrl.length <= 32 * 1024 * 1024) {
    next.imageDataUrl = value.imageDataUrl
  }
  if (typeof value.imageName === 'string' && value.imageName.length <= 200) next.imageName = value.imageName
  if (isFiniteNumber(value.imageAspect) && value.imageAspect > 0) next.imageAspect = value.imageAspect
  if (typeof value.backImageDataUrl === 'string' && value.backImageDataUrl.startsWith('data:image/')
      && value.backImageDataUrl.length <= 32 * 1024 * 1024) next.backImageDataUrl = value.backImageDataUrl
  if (typeof value.backImageName === 'string' && value.backImageName.length <= 200) next.backImageName = value.backImageName
  if (isFiniteNumber(value.backImageAspect) && value.backImageAspect > 0) next.backImageAspect = value.backImageAspect
  if (!isBack && isRecord(value.backTexture)) next.backTexture = normalizeBoardTexture(value.backTexture, true)
  if (!isBack && typeof value.backEnabled === 'boolean') next.backEnabled = value.backEnabled
  if (value.backFit === 'cover' || value.backFit === 'contain' || value.backFit === 'stretch' || value.backFit === 'tile') next.backFit = value.backFit
  if (isFiniteNumber(value.backScale)) next.backScale = Math.max(10, Math.min(400, value.backScale))
  if (isFiniteNumber(value.backOffsetX)) next.backOffsetX = Math.max(-100, Math.min(100, value.backOffsetX))
  if (isFiniteNumber(value.backOffsetY)) next.backOffsetY = Math.max(-100, Math.min(100, value.backOffsetY))
  if (isFiniteNumber(value.backRotation)) next.backRotation = Math.max(-180, Math.min(180, value.backRotation))
  if (Array.isArray(value.avoidZones)) {
    const usedIds = new Set<string>()
    next.avoidZones = value.avoidZones.slice(0, 32).flatMap((item, index) => {
      if (!isRecord(item) || !isFiniteNumber(item.x) || !isFiniteNumber(item.y) ||
          !isFiniteNumber(item.width) || !isFiniteNumber(item.height)) return []
      const x = Math.max(0, Math.min(0.98, item.x))
      const y = Math.max(0, Math.min(0.98, item.y))
      const width = Math.max(0.02, Math.min(1 - x, item.width))
      const height = Math.max(0.02, Math.min(1 - y, item.height))
      const baseId = typeof item.id === 'string' && item.id.trim() && item.id.length <= 100
        ? item.id.trim()
        : `avoid-zone-${index + 1}`
      let id = baseId
      let suffix = 2
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`
      usedIds.add(id)
      return [{
        id,
        name: typeof item.name === 'string' && item.name.trim() && item.name.length <= 80
          ? item.name.trim()
          : `纹理避让区 ${index + 1}`,
        x,
        y,
        width,
        height,
        enabled: item.enabled !== false,
      }]
    })
  }
  if (value.fit === 'cover' || value.fit === 'contain' || value.fit === 'stretch' || value.fit === 'tile') next.fit = value.fit
  if (isFiniteNumber(value.scale)) next.scale = Math.max(10, Math.min(400, value.scale))
  if (isFiniteNumber(value.offsetX)) next.offsetX = Math.max(-100, Math.min(100, value.offsetX))
  if (isFiniteNumber(value.offsetY)) next.offsetY = Math.max(-100, Math.min(100, value.offsetY))
  if (isFiniteNumber(value.rotation)) next.rotation = Math.max(-180, Math.min(180, value.rotation))
  if (isFiniteNumber(value.opacity)) next.opacity = Math.max(0.05, Math.min(1, value.opacity))
  if (isFiniteNumber(value.brightness)) next.brightness = Math.max(0.2, Math.min(2, value.brightness))
  if (isFiniteNumber(value.contrast)) next.contrast = Math.max(0.2, Math.min(2, value.contrast))
  if (isFiniteNumber(value.saturation)) next.saturation = Math.max(0, Math.min(2, value.saturation))
  if (value.colorMode === 'original' || value.colorMode === 'mono' || value.colorMode === 'posterize') next.colorMode = value.colorMode
  if (isFiniteNumber(value.colorCount)) next.colorCount = Math.max(2, Math.min(8, Math.round(value.colorCount)))
  // Preserve modeling intent across save/reopen, including restored pixel and SVG modes.
  if (value.modelingMode === 'high-fidelity' || value.modelingMode === 'pixel' || value.modelingMode === 'vector') next.modelingMode = value.modelingMode
  if (typeof value.lutId === 'string') next.lutId = normalizeSnapColorLutId(value.lutId)
  if (isFiniteNumber(value.quantizeColors)) next.quantizeColors = Math.max(2, Math.min(256, Math.round(value.quantizeColors)))
  if (isFiniteNumber(value.hueWeight)) next.hueWeight = Math.max(0, Math.min(1, value.hueWeight))
  if (typeof value.cleanup === 'boolean') next.cleanup = value.cleanup
  if (isFiniteNumber(value.textureThickness)) next.textureThickness = Math.max(0.08, Math.min(3, value.textureThickness))
  if (typeof value.edgeSealEnabled === 'boolean') next.edgeSealEnabled = value.edgeSealEnabled
  if (isFiniteNumber(value.edgeSealWidth)) next.edgeSealWidth = Math.max(0.3, Math.min(2, value.edgeSealWidth))
  if (isFiniteNumber(value.pixelSize)) next.pixelSize = Math.max(0.4, Math.min(8, value.pixelSize))
  if (value.surfaceMode === 'snapcolor' || value.surfaceMode === 'veneer' || value.surfaceMode === 'woodgrain') next.surfaceMode = value.surfaceMode
  else if (value.surfaceMode === 'lumina') next.surfaceMode = 'snapcolor'
  next.woodGrain = normalizeWoodGrain(value.woodGrain)
  if (value.surfaceFinish === 'textured-pei' || value.surfaceFinish === 'smooth-top') next.surfaceFinish = value.surfaceFinish
  if (typeof value.baseMaterialName === 'string' && value.baseMaterialName.length <= 80) next.baseMaterialName = value.baseMaterialName
  if (typeof value.surfaceMaterialName === 'string' && value.surfaceMaterialName.length <= 80) next.surfaceMaterialName = value.surfaceMaterialName
  if (value.surfaceMaterialKind === 'decorative-petg' || value.surfaceMaterialKind === 'transparent-petg') next.surfaceMaterialKind = value.surfaceMaterialKind
  else if (/透明|透光|translucent|transparent/i.test(next.surfaceMaterialName)) next.surfaceMaterialKind = 'transparent-petg'
  if (value.surfacePrintGoal === 'standard' || value.surfacePrintGoal === 'frosted' || value.surfacePrintGoal === 'clear-experimental') next.surfacePrintGoal = value.surfacePrintGoal
  if (next.surfaceMaterialKind !== 'transparent-petg') next.surfacePrintGoal = 'standard'
  if (typeof value.surfaceFilamentVendor === 'string' && value.surfaceFilamentVendor.length <= 80) next.surfaceFilamentVendor = value.surfaceFilamentVendor
  if (isRecord(value.surfacePrintOverrides)) {
    const overrides = value.surfacePrintOverrides
    if (isFiniteNumber(overrides.nozzleTempC) && overrides.nozzleTempC >= 220 && overrides.nozzleTempC <= 270) next.surfacePrintOverrides.nozzleTempC = overrides.nozzleTempC
    if (isFiniteNumber(overrides.flowRatio) && overrides.flowRatio >= 0.85 && overrides.flowRatio <= 1.15) next.surfacePrintOverrides.flowRatio = overrides.flowRatio
    if (isFiniteNumber(overrides.maxFlowMm3s) && overrides.maxFlowMm3s >= 3 && overrides.maxFlowMm3s <= 30) next.surfacePrintOverrides.maxFlowMm3s = overrides.maxFlowMm3s
    if (isFiniteNumber(overrides.fanPercent) && overrides.fanPercent >= 0 && overrides.fanPercent <= 100) next.surfacePrintOverrides.fanPercent = overrides.fanPercent
  }
  if (typeof value.baseColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.baseColor)) next.baseColor = value.baseColor.toUpperCase()
  if (typeof value.surfaceColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.surfaceColor)) next.surfaceColor = value.surfaceColor.toUpperCase()
  if (typeof value.manufacturingContours === 'boolean') next.manufacturingContours = value.manufacturingContours
  if (value.manufacturingEdgeQuality === 'standard' || value.manufacturingEdgeQuality === 'fine') next.manufacturingEdgeQuality = value.manufacturingEdgeQuality
  if (isFiniteNumber(value.baseInfillDensity)) next.baseInfillDensity = Math.max(5, Math.min(50, Math.round(value.baseInfillDensity)))
  if (next.source === 'image' && !next.imageDataUrl) next.enabled = false
  if (next.surfaceMode === 'snapcolor' && next.source === 'composition' && !next.composition.layers.length) next.enabled = false
  if (next.surfaceMode !== 'snapcolor') next.backEnabled = false
  if (isBack) { next.backEnabled = false; next.backTexture = undefined }
  else if (next.backEnabled) next.surfaceMode = 'snapcolor'
  if (next.surfaceMode === 'woodgrain') return normalizeWoodGrainTexture(next,
    !isRecord(value.woodGrain) || value.woodGrain.algorithm !== 'growth-rings-v2')
  return next
}

function isSvgLatticePlacement(value: unknown): boolean {
  if (!isRecord(value)) return false
  return ['offsetX', 'offsetY', 'scale', 'rotationDeg'].every(key => isFiniteNumber(value[key])) &&
    (value.scale as number) >= 0.1 && (value.scale as number) <= 4 &&
    Math.abs(value.offsetX as number) <= 2000 && Math.abs(value.offsetY as number) <= 2000 &&
    Math.abs(value.rotationDeg as number) <= 180 &&
    typeof value.flipX === 'boolean' && typeof value.flipY === 'boolean'
}

function isSplitResult(value: unknown): value is SplitResultState {
  if (!isRecord(value)) return false
  return Array.isArray(value.sources) && value.sources.every(source =>
    isRecord(source) &&
    typeof source.contourId === 'string' &&
    typeof source.name === 'string' &&
    Array.isArray(source.panels) && source.panels.every(isSplitPanel) &&
    Array.isArray(source.warnings) && source.warnings.every(item => typeof item === 'string') &&
    isFiniteNumber(source.coverageRatio)) &&
    Array.isArray(value.panels) && value.panels.every(isSplitPanel) &&
    Array.isArray(value.warnings) && value.warnings.every(item => typeof item === 'string') &&
    isRecord(value.config) &&
    isFiniteNumber(value.ts) &&
    (value.openLatticeStyle === undefined || ['organic', 'hex', 'diamond', 'honeycomb', 'ribs', 'svg', 'flower'].includes(value.openLatticeStyle as string)) &&
    (value.openLatticeSvg === undefined || (typeof value.openLatticeSvg === 'string' && value.openLatticeSvg.length <= 2_000_000)) &&
    (value.openLatticePlacement === undefined || isSvgLatticePlacement(value.openLatticePlacement)) &&
    (value.openLatticeSvgOptions === undefined || isSvgLatticeOptions(value.openLatticeSvgOptions)) &&
    (value.openLatticeSurfaceMm === undefined || (isFiniteNumber(value.openLatticeSurfaceMm) &&
      (value.openLatticeSurfaceMm === 0 || (value.openLatticeSurfaceMm >= 0.8 && value.openLatticeSurfaceMm <= 2))))
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createProjectFile(workspace: ProjectWorkspaceData): SnapBoardProjectFile {
  const savedAt = new Date().toISOString()
  return {
    format: SNAPBOARD_PROJECT_FORMAT,
    schemaVersion: SNAPBOARD_PROJECT_SCHEMA_VERSION,
    appVersion: workspace.project.metadata.version,
    savedAt,
    attribution: createSnapBoardAttribution({
      projectName: workspace.project.metadata.name,
      projectVersion: workspace.project.metadata.version,
      generatedAt: savedAt,
    }),
    workspace: structuredClone(workspace),
  }
}

/** 解析并校验用户选择的项目文件；旧版缺失的分割参数会按当前默认值补齐。 */
export function parseProjectFile(text: string): SnapBoardProjectFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  if (!isRecord(raw) || raw.format !== SNAPBOARD_PROJECT_FORMAT) {
    throw new Error('这不是 SnapBoard 项目文件')
  }
  if (raw.schemaVersion !== SNAPBOARD_PROJECT_SCHEMA_VERSION) {
    throw new Error(`不支持的项目版本：${String(raw.schemaVersion)}`)
  }
  if (!isRecord(raw.workspace)) throw new Error('项目工作区数据缺失')
  const workspace = raw.workspace
  if (!isProject(workspace.project)) throw new Error('项目草图数据损坏或字段不完整')
  if (!Array.isArray(workspace.boards) || !workspace.boards.every(isBoard)) throw new Error('项目演示板数据无效')
  if (!Array.isArray(workspace.placedParts) || !workspace.placedParts.every(isPlacedPart)) throw new Error('项目装配数据无效')
  if (workspace.splitResult !== null && workspace.splitResult !== undefined && !isSplitResult(workspace.splitResult)) {
    throw new Error('项目分割结果数据无效')
  }

  const splitConfig = normalizeSplitConfig(workspace.splitConfig)
  const normalizedSplitResult = workspace.splitResult == null
    ? null
    : { ...workspace.splitResult, config: normalizeSplitConfig(workspace.splitResult.config) }
  const splitResult = restoreImportedCornerPolicy(workspace.project, normalizedSplitResult)
  const assemblyMarking = workspace.assemblyMarking === undefined ? createDefaultAssemblyMarking() : normalizeAssemblyMarking(workspace.assemblyMarking)
  if (assemblyMarking.includeKitCode && !assemblyMarking.kitCode) assemblyMarking.kitCode = projectKitCode(workspace.project.metadata.name)
  return {
    format: SNAPBOARD_PROJECT_FORMAT,
    schemaVersion: SNAPBOARD_PROJECT_SCHEMA_VERSION,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : workspace.project.metadata.version,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    attribution: normalizeSnapBoardAttribution(raw.attribution, {
      projectName: workspace.project.metadata.name,
      projectVersion: workspace.project.metadata.version,
      generatedAt: typeof raw.savedAt === 'string' ? raw.savedAt : undefined,
    }),
    workspace: cloneJson({
      orderLink: normalizeFarmOrderLink(workspace.orderLink),
      project: workspace.project,
      boards: workspace.boards,
      placedParts: workspace.placedParts,
      boardTexture: normalizeBoardTexture(workspace.boardTexture),
      assemblyMarking,
      assemblyScene: workspace.assemblyScene === undefined
        ? createDefaultAssemblyScene('snapboard-pegboard-v1')
        : normalizeAssemblyScene(workspace.assemblyScene),
      splitConfig,
      splitResult,
      spatialLayout: normalizeSpatialLayout(workspace.spatialLayout, splitConfig),
      lastTextureSampling: normalizeLastTextureSampling(workspace.lastTextureSampling),
    }),
  }
}

export function safeFileName(name: string): string {
  const withoutControls = [...name.trim()].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('')
  const cleaned = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '')
  return cleaned || '未命名项目'
}

export function projectFileName(name: string): string {
  return `${safeFileName(name)}.snapboard`
}

export function serializeProjectFile(workspace: ProjectWorkspaceData): string {
  return JSON.stringify(createProjectFile(workspace), null, 2)
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadProjectFile(workspace: ProjectWorkspaceData): void {
  downloadBlob(
    new Blob([serializeProjectFile(workspace)], { type: 'application/json;charset=utf-8' }),
    projectFileName(workspace.project.metadata.name),
  )
}

export interface ProjectLibraryEntry {
  name: string
  updatedAt: string
  size: number
}

export interface ProjectFileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: Blob | string): Promise<void>
    close(): Promise<void>
  }>
}

interface ProjectDirectoryEntryHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

export interface ProjectDirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  values(): AsyncIterableIterator<ProjectDirectoryEntryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ProjectFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProjectDirectoryHandle>
  queryPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied'>
}

interface ProjectFilePickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<ProjectFileHandle[]>
  showSaveFilePicker?: (options?: unknown) => Promise<ProjectFileHandle>
  showDirectoryPicker?: (options?: unknown) => Promise<ProjectDirectoryHandle>
}

const projectPickerOptions = (suggestedName?: string) => ({
  suggestedName,
  types: [{
    description: 'SnapBoard 项目',
    accept: { 'application/json': ['.snapboard'] },
  }],
  excludeAcceptAllOption: false,
})

const isPickerCancelled = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

const LOCAL_HANDLE_DB = 'snapboard-local-workspace'
const LOCAL_HANDLE_STORE = 'handles'
const LOCAL_HANDLE_KEY = 'project-directory'

function openLocalHandleDb(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_HANDLE_DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LOCAL_HANDLE_STORE)) {
        request.result.createObjectStore(LOCAL_HANDLE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function rememberLocalWorkspace(handle: ProjectDirectoryHandle): Promise<void> {
  const db = await openLocalHandleDb()
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(LOCAL_HANDLE_STORE, 'readwrite')
        .objectStore(LOCAL_HANDLE_STORE)
        .put(handle, LOCAL_HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** 恢复上次授权的本地项目目录；浏览器仍可能要求用户重新确认权限。 */
export async function restoreLocalWorkspace(): Promise<ProjectDirectoryHandle | null> {
  const db = await openLocalHandleDb().catch(() => null)
  if (!db) return null
  try {
    return await new Promise<ProjectDirectoryHandle | null>((resolve, reject) => {
      const request = db.transaction(LOCAL_HANDLE_STORE, 'readonly')
        .objectStore(LOCAL_HANDLE_STORE)
        .get(LOCAL_HANDLE_KEY)
      request.onsuccess = () => resolve((request.result as ProjectDirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** 恢复默认项目库时一并清掉持久化目录，避免下次启动又跳回旧位置。 */
export async function forgetLocalWorkspace(): Promise<void> {
  const db = await openLocalHandleDb()
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(LOCAL_HANDLE_STORE, 'readwrite')
        .objectStore(LOCAL_HANDLE_STORE).delete(LOCAL_HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}

export async function ensureLocalWorkspacePermission(
  handle: ProjectDirectoryHandle,
  requestIfNeeded: boolean,
): Promise<boolean> {
  if (!handle.queryPermission) return true
  const current = await handle.queryPermission({ mode: 'readwrite' })
  if (current === 'granted') return true
  if (!requestIfNeeded || !handle.requestPermission) return false
  return await handle.requestPermission({ mode: 'readwrite' }) === 'granted'
}

/** 选择一个普通本地文件夹作为工作区，并把目录句柄保存到 IndexedDB。 */
export async function chooseLocalWorkspace(): Promise<ProjectDirectoryHandle | null | undefined> {
  const picker = (window as ProjectFilePickerWindow).showDirectoryPicker
  if (!picker) return undefined
  try {
    const handle = await picker.call(window, { id: 'snapboard-project-workspace', mode: 'readwrite' })
    await rememberLocalWorkspace(handle).catch(() => undefined)
    return handle
  } catch (error) {
    if (isPickerCancelled(error)) return null
    throw error
  }
}

export interface LocalWorkspaceProject extends ProjectLibraryEntry {
  handle: ProjectFileHandle
}

export async function listLocalWorkspaceProjects(handle: ProjectDirectoryHandle): Promise<LocalWorkspaceProject[]> {
  const files: LocalWorkspaceProject[] = []
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.snapboard')) continue
    const fileHandle = await handle.getFileHandle(entry.name)
    const file = await fileHandle.getFile()
    files.push({
      name: entry.name,
      updatedAt: new Date(file.lastModified).toISOString(),
      size: file.size,
      handle: fileHandle,
    })
  }
  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function writeProjectToLocalWorkspace(
  workspace: ProjectWorkspaceData,
  directory: ProjectDirectoryHandle,
): Promise<ProjectFileHandle> {
  const handle = await directory.getFileHandle(projectFileName(workspace.project.metadata.name), { create: true })
  await writeProjectFile(workspace, handle)
  return handle
}

export async function writeBinaryToLocalWorkspace(
  directory: ProjectDirectoryHandle,
  fileName: string,
  data: Uint8Array | Blob,
  subdirectory?: string,
): Promise<string> {
  const targetDirectory = subdirectory
    ? await directory.getDirectoryHandle(subdirectory, { create: true })
    : directory
  if (!navigator.locks?.request) throw new Error('此浏览器不能安全地为同名制造文件编号，请使用支持 Web Locks 的浏览器')
  return navigator.locks.request(`snapboard-export:${directory.name}/${subdirectory ?? ''}`, async () => {
    const names = new Set<string>()
    for await (const entry of targetDirectory.values()) names.add(entry.name.toLowerCase())
    const requested = safeFileName(fileName)
    const dot = requested.lastIndexOf('.')
    const base = dot > 0 ? requested.slice(0, dot) : requested
    const extension = dot > 0 ? requested.slice(dot) : ''
    let index = 0
    let name = requested
    while (names.has(name.toLowerCase())) name = `${base}(${++index})${extension}`
    const handle = await targetDirectory.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Blob([data as BlobPart], { type: fileName.toLowerCase().endsWith('.png') ? 'image/png' : fileName.toLowerCase().endsWith('.zip') ? 'application/zip' : 'model/3mf' }))
    await writable.close()
    return subdirectory ? `${directory.name}/${subdirectory}/${handle.name}` : `${directory.name}/${handle.name}`
  })
}

/** 将项目写入用户通过“另存为”选择的位置；支持后续覆盖同一文件。 */
export async function writeProjectFile(
  workspace: ProjectWorkspaceData,
  handle: ProjectFileHandle,
): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(new Blob([serializeProjectFile(workspace)], { type: 'application/json;charset=utf-8' }))
  await writable.close()
}

/** 系统“另存为”。不支持 File System Access API 的浏览器返回 null，由调用方回退到下载。 */
export async function saveProjectFileAs(
  workspace: ProjectWorkspaceData,
): Promise<ProjectFileHandle | null> {
  const picker = (window as ProjectFilePickerWindow).showSaveFilePicker
  if (!picker) return null
  try {
    const handle = await picker.call(window, projectPickerOptions(projectFileName(workspace.project.metadata.name)))
    await writeProjectFile(workspace, handle)
    return handle
  } catch (error) {
    if (isPickerCancelled(error)) return null
    throw error
  }
}

/** 为制造文件打开系统“另存为”；undefined 表示浏览器不支持，null 表示用户取消。 */
export async function saveManufacturingFileAs(
  data: Uint8Array | Blob,
  suggestedName: string,
): Promise<ProjectFileHandle | null | undefined> {
  const picker = (window as ProjectFilePickerWindow).showSaveFilePicker
  if (!picker) return undefined
  // 逐板导出交付的是分板 ZIP；保存对话框的类型要跟着实际内容走，
  // 否则浏览器会按 3MF 类型给 ZIP 再补一个 .3mf 后缀，切片软件打不开。
  const isZipBundle = suggestedName.toLowerCase().endsWith('.zip')
  try {
    const handle = await picker.call(window, {
      suggestedName: safeFileName(suggestedName),
      types: [{ description: isZipBundle ? '分板制造压缩包' : '3MF 制造文件',
        accept: isZipBundle ? { 'application/zip': ['.zip'] } : { 'model/3mf': ['.3mf'] } }],
      excludeAcceptAllOption: false,
    })
    const writable = await handle.createWritable()
    await writable.write(new Blob([data as BlobPart], { type: isZipBundle ? 'application/zip' : 'model/3mf' }))
    await writable.close()
    return handle
  } catch (error) {
    if (isPickerCancelled(error)) return null
    throw error
  }
}

const projectStorageApiBase = (import.meta.env.VITE_PROJECT_STORAGE_API_BASE as string | undefined)?.trim().replace(/\/$/, '')
  || '/api/project-library'

/**
 * 本地开发时指向 Vite 的文件 API；云端部署时设置 VITE_PROJECT_STORAGE_API_BASE，
 * 即可把相同的保存、列表、打开和制造导出调用切到服务器对象存储/数据库。
 */
export const PROJECT_STORAGE_API_BASE = projectStorageApiBase

const projectStorageUrl = (path: string) => `${PROJECT_STORAGE_API_BASE}${path}`

/** 本地后端在系统文件管理器中打开固定的项目或制造目录；云端/静态站点返回 false。 */
export async function revealProjectLibrary(kind: 'projects' | 'exports' = 'projects'): Promise<boolean> {
  const response = await fetch(projectStorageUrl(`/reveal?kind=${kind}`), { method: 'POST' }).catch(() => null)
  if (!response || response.status === 404) return false
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `保存目录打开失败 (HTTP ${response.status})`)
  }
  return true
}

/** 本地工作流的默认项目库；静态部署没有该 API 时返回 false。 */
export async function saveProjectToLibrary(workspace: ProjectWorkspaceData): Promise<boolean> {
  const response = await fetch(projectStorageUrl(`/save?filename=${encodeURIComponent(projectFileName(workspace.project.metadata.name))}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: serializeProjectFile(workspace),
  }).catch(() => null)
  if (!response || response.status === 404) return false
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `默认项目库保存失败 (HTTP ${response.status})`)
  }
  return true
}

export async function listProjectLibrary(): Promise<ProjectLibraryEntry[] | null> {
  const response = await fetch(projectStorageUrl('/list'), { cache: 'no-store' }).catch(() => null)
  if (!response || response.status === 404) return null
  if (!response.ok) throw new Error(`项目库读取失败 (HTTP ${response.status})`)
  const body = await response.json() as { files?: ProjectLibraryEntry[] }
  return Array.isArray(body.files) ? body.files : []
}

export async function readProjectFromLibrary(fileName: string): Promise<SnapBoardProjectFile> {
  const response = await fetch(projectStorageUrl(`/open?filename=${encodeURIComponent(fileName)}`), { cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `项目打开失败 (HTTP ${response.status})`)
  }
  return parseProjectFile(await response.text())
}

/** 将 3MF 写入本地开发项目库的“制造导出”子目录；云端使用同名二进制端点。 */
export async function saveManufacturingToLibrary(fileName: string, data: Uint8Array | Blob, options: { exportTicket?: string; signal?: AbortSignal } = {}): Promise<string | null> {
  const response = await fetch(projectStorageUrl(`/export?filename=${encodeURIComponent(safeFileName(fileName))}`), {
    method: 'POST',
    headers: { 'Content-Type': fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'model/3mf',
      ...(options.exportTicket ? { 'X-SnapBoard-Export-Ticket': options.exportTicket } : {}) },
    signal: options.signal,
    body: data as BodyInit,
  }).catch(error => { if (options.signal?.aborted) throw error; return null })
  if (!response || response.status === 404) return null
  const body = await response.json().catch(() => ({})) as { error?: string; folder?: string; filename?: string }
  if (!response.ok) throw new Error(body.error || `制造文件保存失败 (HTTP ${response.status})`)
  return [body.folder, body.filename].filter(Boolean).join('/') || fileName
}

export function downloadManufacturingJSON(
  project: Project,
  panels: SplitPanel[],
  config: SplitConfig,
): void {
  if (!panels.length) throw new Error('没有可导出的分割板件')
  const payload: SnapBoardManufacturingFile = {
    format: 'snapboard-manufacturing',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    attribution: createSnapBoardAttribution({
      projectName: project.metadata.name,
      projectVersion: project.metadata.version,
    }),
    units: 'millimeter',
    project: { name: project.metadata.name, version: project.metadata.version },
    config: cloneJson(config),
    panels: cloneJson(panels),
  }
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
    `${safeFileName(project.metadata.name)}-板件清单.json`,
  )
}

/** 浏览器安全文件选择器；取消选择时返回 null。 */
export async function chooseProjectFile(): Promise<{ file: File; handle: ProjectFileHandle | null } | null> {
  const picker = (window as ProjectFilePickerWindow).showOpenFilePicker
  if (picker) {
    try {
      const handles = await picker.call(window, projectPickerOptions())
      const handle = handles[0]
      return handle ? { file: await handle.getFile(), handle } : null
    } catch (error) {
      if (isPickerCancelled(error)) return null
      throw error
    }
  }
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.snapboard,application/json'
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file ? { file, handle: null } : null)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null
      finish(file)
    }, { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}
