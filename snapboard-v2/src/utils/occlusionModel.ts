// ============ 遮挡度量内核 ============
// 纯几何与数值计算，不依赖 Three.js、React 或 store，可在 Node.js 中单测。
// Viewport3D 异步加载配件模型；度量使用以下同步数据，无需等待 Object3D：
//   - 板件几何   SplitPanel.contour / cutouts（全局 mm）
//   - 配件尺寸   PartDefinition.model.dimensionsMm
//   - 配件位姿   PlacedPart.placement.{position, rotationZ, side}
// 设计说明见 docs/OCCLUSION_GOVERNANCE_PLAN.md。
// polygon-clipping 只有默认导出（union/intersection/xor/difference 都在它上面），
// 没有具名导出，必须走 default 形式。
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping'
import type { BoardTextureAvoidZone, Point2D, SplitPanel } from '../types/geometry'
import type { PartDefinition, PlacedPart } from '../partLibrary/types'
// 显式带 .js 后缀：与 assemblySnap/mountAxis 的写法一致，
// 也让 scripts/verify-occlusion.mjs 编出来的 ESM 能在 node 里直接跑。
import { splitAssemblyFrame } from './assemblySnap.js'

// ---------------------------------------------------------------------------
// 版面三区
// ---------------------------------------------------------------------------

/** 版面分区（自下而上）：承重收纳 → 高频使用 → 视觉核心。 */
export type BoardZoneId = 'load-storage' | 'frequent-use' | 'visual-core'

export interface BoardZone {
  id: BoardZoneId
  label: string
  /** 相对装配高度的自下而上归一化区间 [0,1] */
  from: number
  to: number
  /** 该分区内的真实板面有效面积 mm²（与板件轮廓求交，已扣除内孔与缺口） */
  area: number
}

export interface BoardZoneLayout {
  /** 装配体局部坐标包围盒（x 以装配中心为 0，y 以装配底边为 0） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
  zones: BoardZone[]
  /** 三区面积之和；等于全部板件的实体面积 */
  totalArea: number
}

/** 默认分区比例（自下而上），合计必须为 1。 */
export const DEFAULT_ZONE_RATIOS: Record<BoardZoneId, number> = {
  'load-storage': 0.30,
  'frequent-use': 0.40,
  'visual-core': 0.30,
}

export const ZONE_LABELS: Record<BoardZoneId, string> = {
  'load-storage': '承重收纳区',
  'frequent-use': '高频使用区',
  'visual-core': '视觉核心区',
}

/** 分区顺序固定为自下而上，UI 与验证脚本共用同一顺序。 */
export const ZONE_ORDER: BoardZoneId[] = ['load-storage', 'frequent-use', 'visual-core']

const signedArea = (ring: Point2D[]): number => {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

const toRing = (points: Point2D[]): Ring =>
  points.map(p => [p.x, p.y] as [number, number])

const closedRing = (points: Point2D[]): Ring => {
  const ring = toRing(points)
  if (ring.length === 0) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
  return ring
}

const polygonArea = (rings: Ring[]): number => {
  let total = 0
  rings.forEach((ring, index) => {
    const area = Math.abs(signedArea(ring.map(([x, y]) => ({ x, y }))))
    total += index === 0 ? area : -area
  })
  return total
}

/** 板件真实轮廓（含内孔环）；没有 contour 时退回矩形包围盒。 */
const panelPolygon = (panel: SplitPanel): Polygon => {
  const hasContour = (panel.contour?.length ?? 0) >= 3
  const outer = hasContour
    ? panel.contour!
    : [
      { x: panel.x, y: panel.y },
      { x: panel.x + panel.w, y: panel.y },
      { x: panel.x + panel.w, y: panel.y + panel.h },
      { x: panel.x, y: panel.y + panel.h },
    ]
  const rings: Ring[] = [closedRing(outer)]
  for (const cutout of [...(panel.cutouts ?? []), ...(panel.latticeCutouts ?? [])]) {
    if (cutout.length >= 3) rings.push(closedRing(cutout))
  }
  return rings
}

/**
 * 按高度比例把装配体切成三个横向带，并与每块板的真实轮廓求交得到各区有效面积。
 *
 * 必须走真实轮廓求交而不是包围盒近似：U 形、L 形板在视觉核心区可能完全没有材料，
 * 包围盒算法会给出"核心区遮挡率 60%"这类错误读数。
 */
export function boardZoneLayout(
  panels: SplitPanel[],
  ratios: Partial<Record<BoardZoneId, number>> = {},
): BoardZoneLayout {
  const frame = splitAssemblyFrame(panels)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const localPanels: SplitPanel[] = []
  for (const panel of panels) {
    const shift = (p: Point2D): Point2D => ({ x: p.x - frame.centerX, y: p.y - frame.minY })
    const local: SplitPanel = {
      ...panel,
      x: panel.x - frame.centerX,
      y: panel.y - frame.minY,
      contour: panel.contour?.map(shift),
      cutouts: panel.cutouts?.map(ring => ring.map(shift)),
      latticeCutouts: panel.latticeCutouts?.map(ring => ring.map(shift)),
    }
    localPanels.push(local)
    const points = local.contour?.length ? local.contour : [
      { x: local.x, y: local.y },
      { x: local.x + panel.w, y: local.y + panel.h },
    ]
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  }

  if (!Number.isFinite(minX) || localPanels.length === 0) {
    return {
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      zones: ZONE_ORDER.map(id => ({ id, label: ZONE_LABELS[id], from: 0, to: 0, area: 0 })),
      totalArea: 0,
    }
  }

  const height = Math.max(1e-6, maxY - minY)
  const resolved = { ...DEFAULT_ZONE_RATIOS, ...ratios }
  const sum = ZONE_ORDER.reduce((acc, id) => acc + Math.max(0, resolved[id]), 0)
  // 比例未归一化时按比例摊回，避免出现空隙或重叠。
  const normalized = sum > 0
    ? ZONE_ORDER.map(id => Math.max(0, resolved[id]) / sum)
    : ZONE_ORDER.map(() => 1 / ZONE_ORDER.length)

  const zones: BoardZone[] = []
  let lower = 0
  ZONE_ORDER.forEach((id, index) => {
    const upper = index === ZONE_ORDER.length - 1 ? 1 : lower + normalized[index]
    const y0 = minY + lower * height
    const y1 = minY + upper * height
    let area = 0
    if (y1 - y0 > 1e-9) {
      const band: Ring = [
        [minX - 1, y0], [maxX + 1, y0], [maxX + 1, y1], [minX - 1, y1], [minX - 1, y0],
      ]
      for (const panel of localPanels) {
        try {
          const clipped: MultiPolygon = polygonClipping.intersection(panelPolygon(panel), [band])
          for (const polygon of clipped) {
            if (!polygon.length) continue
            area += Math.abs(polygonArea(polygon))
          }
        } catch {
          // 单块板求交失败不应让整个度量崩掉；该板按 0 计入并继续。
        }
      }
    }
    zones.push({ id, label: ZONE_LABELS[id], from: lower, to: upper, area })
    lower = upper
  })

  const bounds = { minX, minY, maxX, maxY, width: Math.max(1e-6, maxX - minX), height }
  return { bounds, zones, totalArea: zones.reduce((acc, zone) => acc + zone.area, 0) }
}

// ---------------------------------------------------------------------------
// 配件投影足迹
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180

type Mat3 = [number, number, number, number, number, number, number, number, number]

const mul3 = (a: Mat3, b: Mat3): Mat3 => {
  const out = new Array<number>(9) as Mat3
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

const rotationX = (deg: number): Mat3 => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}
const rotationY = (deg: number): Mat3 => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}
const rotationZ = (deg: number): Mat3 => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** 上轴归一矩阵：把模型自身坐标系旋到 SnapBoard 的 Z 轴朝前、Y 轴向上。 */
const upAxisMatrix = (upAxis: string | undefined): Mat3 => {
  if (upAxis === 'z') return rotationX(-90)  // 与 glbLoader 的 raw.rotation.x = -PI/2 一致
  if (upAxis === 'x') return rotationZ(90)
  return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

/** 旋转后 AABB 的精确半长：|M| · dims。对长方体是精确值，不是保守估计。 */
const rotatedExtents = (dims: [number, number, number], m: Mat3): [number, number, number] => [
  Math.abs(m[0]) * dims[0] + Math.abs(m[1]) * dims[1] + Math.abs(m[2]) * dims[2],
  Math.abs(m[3]) * dims[0] + Math.abs(m[4]) * dims[1] + Math.abs(m[5]) * dims[2],
  Math.abs(m[6]) * dims[0] + Math.abs(m[7]) * dims[1] + Math.abs(m[8]) * dims[2],
]

export interface PartFootprint {
  partId: string
  defId: string
  side: 'front' | 'back'
  /** 装配体局部坐标下的投影盒中心（与 placement.position 同一坐标系） */
  cx: number
  cy: number
  /** 投影盒宽 / 高 mm */
  width: number
  height: number
  /** 毛投影面积 mm²（未做通透折算） */
  grossArea: number
  /** 通透折算系数 0~1，由调用方传入，默认 0；用于遮挡估算，不代表实测透光率。 */
  voidRatio: number
  /** dimensionsMm 缺失时为 true：遮挡数据不可信，调用方应显式提示而不是当成 0。 */
  unknown: boolean
}

/**
 * 计算单个已装配配件在板面上的投影矩形。
 *
 * 变换链与运行时一致（见 glbLoader.loadPartModel + Viewport3D.applyAssemblyTransform）：
 *   1. upAxis 归一；
 *   2. model.orientation（XYZ 欧拉，度）绕**模型包围盒中心**旋转；
 *   3. side === 'back' 时绕 Y 轴 180° —— 只翻转 x/z 符号，不改变 x/y 投影尺寸；
 *   4. 再绕 Z 轴转 placement.rotationZ。
 * 模型根节点原点就是包围盒中心，因此投影盒中心等于 placement.position 的 xy。
 */
export function partFootprint(
  def: PartDefinition,
  placed: PlacedPart,
  voidRatio = 0,
): PartFootprint | null {
  const placement = placed.placement
  if (!placement) return null
  const dims = def.model.dimensionsMm
  const unknown = !Array.isArray(dims) || dims.length !== 3 ||
    !dims.every(value => Number.isFinite(value) && value > 0)
  const safeDims: [number, number, number] = unknown
    ? [0, 0, 0]
    : [dims![0], dims![1], dims![2]]

  const orientation = def.model.orientation ?? [0, 0, 0]
  // three.js Euler 'XYZ' 等价矩阵为 Rx·Ry·Rz，与 glbLoader 的 rotation.set 一致。
  const orient = mul3(
    mul3(rotationX(orientation[0] ?? 0), rotationY(orientation[1] ?? 0)),
    rotationZ(orientation[2] ?? 0),
  )
  const modelMatrix = mul3(orient, upAxisMatrix(def.model.upAxis))
  const [ex, ey] = rotatedExtents(safeDims, modelMatrix)

  const theta = placement.rotationZ ?? 0
  const c = Math.abs(Math.cos(theta))
  const s = Math.abs(Math.sin(theta))
  const width = ex * c + ey * s
  const height = ex * s + ey * c

  return {
    partId: placed.id,
    defId: def.id,
    side: placement.side ?? 'front',
    cx: placement.position[0],
    cy: placement.position[1],
    width,
    height,
    grossArea: width * height,
    voidRatio: Math.max(0, Math.min(1, voidRatio)),
    unknown,
  }
}

// ---------------------------------------------------------------------------
// 遮挡栅格
// ---------------------------------------------------------------------------

export interface OcclusionGrid {
  minX: number
  minY: number
  cols: number
  rows: number
  cellSize: number
  /** 1 = 该格落在板件实体材料上（已扣除内孔） */
  material: Uint8Array
  /** 该格被多少件配件投影覆盖 */
  coverage: Uint16Array
  /** 覆盖该格的配件中最小的 voidRatio：最不透光的那件决定可见性 */
  minVoid: Float32Array
}

const MAX_GRID_CELLS = 240_000

/** 依据包围盒自动放宽格距，避免超大墙面把内存打爆。 */
export function gridCellSizeFor(width: number, height: number, preferred = 5): number {
  let cell = Math.max(0.5, preferred)
  while ((width / cell) * (height / cell) > MAX_GRID_CELLS) cell *= 2
  return cell
}

const pointInRing = (x: number, y: number, ring: Point2D[]): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * 建立装配体栅格：先标出哪些格有板材，再把配件投影叠加上去。
 *
 * 用栅格而不是解析求并，是因为配件投影是**旋转矩形**，`polygon-clipping` 对这类输入
 * 是 O(n²) 且数值不稳定；栅格天然给出并集语义，同时顺带产出密度热力图所需的覆盖计数。
 */
export function buildOcclusionGrid(
  panels: SplitPanel[],
  footprints: PartFootprint[],
  preferredCell = 5,
): OcclusionGrid {
  const frame = splitAssemblyFrame(panels)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const panel of panels) {
    const points = panel.contour?.length ? panel.contour : [
      { x: panel.x, y: panel.y },
      { x: panel.x + panel.w, y: panel.y + panel.h },
    ]
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  }
  // 配件可能探出板外，栅格必须把它们也框进来，否则遮挡面积会被截断。
  // 足迹是装配体局部坐标（x 以中心为 0、y 以底边为 0），这里转回全局 mm。
  for (const fp of footprints) {
    if (fp.width <= 0 || fp.height <= 0) continue
    minX = Math.min(minX, fp.cx - fp.width / 2 + frame.centerX)
    maxX = Math.max(maxX, fp.cx + fp.width / 2 + frame.centerX)
    minY = Math.min(minY, fp.cy - fp.height / 2 + frame.minY)
    maxY = Math.max(maxY, fp.cy + fp.height / 2 + frame.minY)
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, cols: 0, rows: 0, cellSize: preferredCell, material: new Uint8Array(0), coverage: new Uint16Array(0), minVoid: new Float32Array(0) }
  }

  const width = Math.max(1e-6, maxX - minX)
  const height = Math.max(1e-6, maxY - minY)
  const cellSize = gridCellSizeFor(width, height, preferredCell)
  const cols = Math.max(1, Math.ceil(width / cellSize))
  const rows = Math.max(1, Math.ceil(height / cellSize))
  const material = new Uint8Array(cols * rows)
  const coverage = new Uint16Array(cols * rows)
  const minVoid = new Float32Array(cols * rows).fill(1)

  // 板材掩膜：逐板只在自身包围盒范围内扫描，避免 O(格数 × 板数) 全量点判。
  for (const panel of panels) {
    const hasContour = (panel.contour?.length ?? 0) >= 3
    const outer: Point2D[] = hasContour ? panel.contour! : [
      { x: panel.x, y: panel.y },
      { x: panel.x + panel.w, y: panel.y },
      { x: panel.x + panel.w, y: panel.y + panel.h },
      { x: panel.x, y: panel.y + panel.h },
    ]
    const cutouts = [...(panel.cutouts ?? []), ...(panel.latticeCutouts ?? [])].map(ring => ({
      ring, minX: Math.min(...ring.map(point => point.x)), maxX: Math.max(...ring.map(point => point.x)),
      minY: Math.min(...ring.map(point => point.y)), maxY: Math.max(...ring.map(point => point.y)),
    }))
    let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity
    for (const p of outer) {
      pMinX = Math.min(pMinX, p.x); pMaxX = Math.max(pMaxX, p.x)
      pMinY = Math.min(pMinY, p.y); pMaxY = Math.max(pMaxY, p.y)
    }
    const c0 = Math.max(0, Math.floor((pMinX - minX) / cellSize))
    const c1 = Math.min(cols - 1, Math.ceil((pMaxX - minX) / cellSize))
    const r0 = Math.max(0, Math.floor((pMinY - minY) / cellSize))
    const r1 = Math.min(rows - 1, Math.ceil((pMaxY - minY) / cellSize))
    for (let r = r0; r <= r1; r++) {
      const y = minY + (r + 0.5) * cellSize
      for (let c = c0; c <= c1; c++) {
        const x = minX + (c + 0.5) * cellSize
        if (!pointInRing(x, y, outer)) continue
        if (cutouts.some(cutout => x >= cutout.minX && x <= cutout.maxX && y >= cutout.minY && y <= cutout.maxY
          && pointInRing(x, y, cutout.ring))) continue
        material[r * cols + c] = 1
      }
    }
  }

  // 配件投影叠加。只统计正面件：背面件不遮挡正面纹理与展示面。
  for (const fp of footprints) {
    if (fp.side !== 'front' || fp.width <= 0 || fp.height <= 0) continue
    const gx0 = fp.cx - fp.width / 2 + frame.centerX
    const gx1 = fp.cx + fp.width / 2 + frame.centerX
    const gy0 = fp.cy - fp.height / 2 + frame.minY
    const gy1 = fp.cy + fp.height / 2 + frame.minY
    const c0 = Math.max(0, Math.floor((gx0 - minX) / cellSize))
    const c1 = Math.min(cols - 1, Math.ceil((gx1 - minX) / cellSize))
    const r0 = Math.max(0, Math.floor((gy0 - minY) / cellSize))
    const r1 = Math.min(rows - 1, Math.ceil((gy1 - minY) / cellSize))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const index = r * cols + c
        coverage[index] = Math.min(65535, coverage[index] + 1)
        if (fp.voidRatio < minVoid[index]) minVoid[index] = fp.voidRatio
      }
    }
  }

  return { minX, minY, cols, rows, cellSize, material, coverage, minVoid }
}

// ---------------------------------------------------------------------------
// 汇总报告
// ---------------------------------------------------------------------------

export interface ZoneOcclusion {
  id: BoardZoneId
  label: string
  /** 该区板面有效面积 mm² */
  area: number
  /** 该区净遮挡面积 mm² */
  occludedArea: number
  /** 该区遮挡率 0~1；面积为 0 时为 0 */
  ratio: number
  /** 中心落在该区的正面配件件数 */
  partCount: number
}

export interface OcclusionReport {
  board: BoardZoneLayout
  footprints: PartFootprint[]
  grid: OcclusionGrid
  /** 全板净遮挡率 0~1（已按最不透光盘点折算，重叠不重复计数） */
  occlusionRatio: number
  /** 可见展示面保留率 = 1 - occlusionRatio。不要用 coverageRatio 命名，那个是板件覆盖率。 */
  visibleExposureRatio: number
  /** 排除纹理避让区后，实际具有装饰纹理的板面占全部板面的比例。 */
  texturedAreaRatio: number
  /** 有纹理板面在安装配件后的可见比例；无纹理区域时定义为 1。 */
  textureVisibleRatio: number
  /** 毛遮挡率（不做通透折算，仅用于诊断包围盒是否明显偏大） */
  grossOcclusionRatio: number
  zones: ZoneOcclusion[]
  /** 背面件数量（不计入正面遮挡） */
  backPartCount: number
  /** dimensionsMm 缺失、遮挡数据不可信的件数 */
  unknownFootprintCount: number
  cellSize: number
}

export interface OcclusionOptions {
  /** 分区比例覆盖 */
  zoneRatios?: Partial<Record<BoardZoneId, number>>
  /** 栅格格距 mm，默认 5 */
  cellSize?: number
  /** 覆盖配件定义中的通透系数；主要供试验参数与回归测试使用。 */
  voidRatioOf?: (def: PartDefinition, placed: PlacedPart) => number
  /** 纹理避让区；用于计算纹理可见度，不影响板面总体遮挡率。 */
  textureAvoidZones?: BoardTextureAvoidZone[]
}

export function computeOcclusionReport(
  panels: SplitPanel[],
  placedParts: PlacedPart[],
  defs: PartDefinition[],
  options: OcclusionOptions = {},
): OcclusionReport {
  const board = boardZoneLayout(panels, options.zoneRatios)
  const defById = new Map(defs.map(def => [def.id, def]))
  const footprints: PartFootprint[] = []
  let backPartCount = 0
  for (const placed of placedParts) {
    const def = defById.get(placed.defId)
    if (!def) continue
    const voidRatio = options.voidRatioOf?.(def, placed) ?? def.occlusion?.voidRatio ?? 0
    const fp = partFootprint(def, placed, voidRatio)
    if (!fp) continue
    footprints.push(fp)
    if (fp.side !== 'front') backPartCount++
  }

  const grid = buildOcclusionGrid(panels, footprints, options.cellSize ?? 5)
  const cellArea = grid.cellSize * grid.cellSize
  // 栅格用的是全局 mm，分区用的是装配体局部坐标（y 以底边为 0）。
  const frame = splitAssemblyFrame(panels)

  let materialCells = 0
  let grossCovered = 0
  let netOccluded = 0
  let texturedCells = 0
  let textureOccluded = 0
  const zoneGross = new Map<BoardZoneId, number>()
  const zoneNet = new Map<BoardZoneId, number>()
  for (const zone of board.zones) { zoneGross.set(zone.id, 0); zoneNet.set(zone.id, 0) }
  const zonePartCount = new Map<BoardZoneId, number>()
  for (const zone of board.zones) zonePartCount.set(zone.id, 0)

  const zoneOfY = (y: number): BoardZoneId | null => {
    const t = (y - board.bounds.minY) / board.bounds.height
    if (t < 0 || t > 1) return null
    for (const zone of board.zones) {
      if (t <= zone.to + 1e-9) return zone.id
    }
    return board.zones[board.zones.length - 1]?.id ?? null
  }

  const enabledAvoidZones = (options.textureAvoidZones ?? []).filter(zone => zone.enabled)
  const isTextureAvoided = (localX: number, localY: number): boolean => {
    if (!enabledAvoidZones.length || board.bounds.width <= 0 || board.bounds.height <= 0) return false
    const x = (localX - board.bounds.minX) / board.bounds.width
    const y = (localY - board.bounds.minY) / board.bounds.height
    return enabledAvoidZones.some(zone =>
      x >= zone.x && x <= zone.x + zone.width &&
      y >= zone.y && y <= zone.y + zone.height)
  }

  for (let r = 0; r < grid.rows; r++) {
    const y = grid.minY + (r + 0.5) * grid.cellSize - frame.minY
    const zoneId = zoneOfY(y)
    for (let c = 0; c < grid.cols; c++) {
      const index = r * grid.cols + c
      if (!grid.material[index]) continue
      materialCells++
      const x = grid.minX + (c + 0.5) * grid.cellSize - frame.centerX
      const isTextured = !isTextureAvoided(x, y)
      if (isTextured) texturedCells++
      if (!grid.coverage[index]) continue
      grossCovered++
      // 同一格上叠了多件时，最不透光的一件决定这一格能否被看见。
      const opaque = 1 - Math.max(0, Math.min(1, grid.minVoid[index]))
      netOccluded += opaque
      if (isTextured) textureOccluded += opaque
      if (zoneId) {
        zoneGross.set(zoneId, (zoneGross.get(zoneId) ?? 0) + 1)
        zoneNet.set(zoneId, (zoneNet.get(zoneId) ?? 0) + opaque)
      }
    }
  }

  // 分区件数按投影中心归属，用于给出"某区放了几件"的直观读数。
  // fp.cy 已经是装配体局部坐标，与 board.bounds 同一坐标系，不再叠加 frame。
  for (const fp of footprints) {
    if (fp.side !== 'front') continue
    const zoneId = zoneOfY(fp.cy)
    if (zoneId) zonePartCount.set(zoneId, (zonePartCount.get(zoneId) ?? 0) + 1)
  }

  const materialArea = materialCells * cellArea
  const occlusionRatio = materialArea > 0
    ? Math.max(0, Math.min(1, netOccluded / materialCells))
    : 0
  const grossOcclusionRatio = materialArea > 0
    ? Math.max(0, Math.min(1, grossCovered / materialCells))
    : 0
  const texturedAreaRatio = materialCells > 0 ? texturedCells / materialCells : 0
  const textureVisibleRatio = texturedCells > 0
    ? Math.max(0, Math.min(1, 1 - textureOccluded / texturedCells))
    : 1

  const zones: ZoneOcclusion[] = board.zones.map(zone => {
    const netCells = zoneNet.get(zone.id) ?? 0
    // 分区遮挡率以该区净遮挡面积除以该区板面有效面积；
    // 分母用真实轮廓面积，分子用栅格统计，两者在格距足够小时一致。
    const occludedArea = zone.area > 0 && materialArea > 0
      ? (netCells / materialCells) * materialArea
      : 0
    return {
      id: zone.id,
      label: zone.label,
      area: zone.area,
      occludedArea: Math.max(0, Math.min(zone.area, occludedArea)),
      ratio: zone.area > 0 ? Math.max(0, Math.min(1, occludedArea / zone.area)) : 0,
      partCount: zonePartCount.get(zone.id) ?? 0,
    }
  })

  return {
    board,
    footprints,
    grid,
    occlusionRatio,
    visibleExposureRatio: 1 - occlusionRatio,
    texturedAreaRatio,
    textureVisibleRatio,
    grossOcclusionRatio,
    zones,
    backPartCount,
    unknownFootprintCount: footprints.filter(fp => fp.unknown).length,
    cellSize: grid.cellSize,
  }
}
