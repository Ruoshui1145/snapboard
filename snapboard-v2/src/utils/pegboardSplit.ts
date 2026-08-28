// ============================================================================
// pegboardSplit.ts - 洞洞板自动正交分割引擎 v2.6 (零依赖)
//
// 策略:
//   - 贪心矩形先快速铺满 (每次取面积最大、能放进热床的矩形板)
//   - 再对相邻板执行块数优先的边缘融合；只要合并后的包围盒能放进热床，
//     就允许 L 型、阶梯型或多凹边正交板，减少接缝/紧固件并释放更多挂孔面积
//   - 锚点/切割严格沿模数线 (x = 板原点 + 40k, y = 板原点 + 20k) → 不切孔
//   - 缺块补偿: ① 允许"贴板边条料"作为小矩形板 (w/h ≥20, 面积足够);
//               ② 剩余碎料优先并进相邻板;
//               ③ 其余无法补偿的碎料给出警告 (不再静默丢失)
//   - 孔位: 整个装配轮廓共享同一晶体槽阵列; 分板只裁切阵列，不重置相位
//           边缘圆孔按各分板边界生成，但只落在全局槽孔横/纵轴线交点
//   - 圆角: 仅整体外轮廓的真实凸角按 DXF 倒 R8; 拼接角保持直角以便无缝装配
//
// 输出:
//   { panels: [ { id, x, y, w, h, contour, roundIdx, slots, edge_holes, ... } ] }
// ============================================================================

import type {
  Point2D,
  SplitConfig,
  SplitResult,
  SplitInput,
  SplitPanel,
  HolePos,
} from '../types/geometry'
import { intersectPanelWithPolygon, subtractHolesFromPanel } from './panelBoolean.js'
import { findFootprintPlacement, getPrintBedBounds, rotatePlanarPoints } from './printBed.js'

/** 宜家洞洞板标准默认参数 */
export const PEGBOARD_DEFAULT_CONFIG: SplitConfig = {
  printerPreset: 'bambu-p1s',
  bedW: 256,
  bedH: 256,
  bedMarginLeft: 0,
  bedMarginRight: 0,
  bedMarginBottom: 0,
  bedMarginTop: 0,
  bedKeepouts: [{ id: 'bambu-front-left', name: '前左擦嘴/机构禁放区', x: 0, y: 0, w: 18, h: 28, enabled: true }],
  mx: 40,
  my: 20,
  edgeMargin: 20,
  minW: 80,
  minH: 60,
  holeSeamClearance: 10,
  jointOffsetX: 10,
  jointOffsetY: 10,
  lidThickness: 0, // 旧字段兼容；候选孔不再生成薄盖，只有完整板面/贯通孔两种状态
  recommendKnockouts: true, // 自动把推荐固定锚位设为贯通孔，其余只显示虚线提示
  cornerRadius: 8,
  // ---- 孔型: 200×200 工程图 (SKÅDIS 20cm 板, 200.200边缘带孔.DXF) ----
  // 竖向长圆孔(胶囊) 5.0(短轴)×15.0(长轴), 端部半圆 R=2.5
  slotLength: 15,
  slotWidth: 5,
  slotPairGapY: 12.5,        // ⚠ 已废弃: 旧"半圆槽两两成对"参数, 不再参与生成
  slotGridX0: 10,            // A 列胶囊中心 x 零位 (相对整板左下角, 工程图 10)
  slotGridY0: 30,            // A 列胶囊中心 y 零位 (工程图 30)
  slotStaggerX: 22.2648,     // SVG 实测 B 列 x 错位: 32.2648+40i，相对 A 列 10+40i
  slotStaggerY: 20,          // B 列 y 错位 (对中心 30 -> 10)
  jointDiameter: 5,        // 默认圆孔 φ5；中心距与 SVG 保持严格 10mm 边距
  cornerHoleDiameter: 5,   // (兼容字段; 工程图无网格角圆孔)
  thickness: 5,
  manufacturingChamfer: 0.35,
  gapTolerance: 0.2,
}

// ---------------------------------------------------------------------------
// 基础几何工具
// ---------------------------------------------------------------------------

const EPS = 1e-6

/** 规范化轮廓: 按指定精度吸附、去重、统一为逆时针且不重复闭合点。 */
function normalizeContour(pts: Point2D[], precision = 1): Point2D[] {
  if (pts.length < 3) return []
  const out: Point2D[] = []
  for (const p of pts) {
    const x = Math.round(p.x / precision) * precision
    const y = Math.round(p.y / precision) * precision
    if (out.length === 0 || out[out.length - 1].x !== x || out[out.length - 1].y !== y) {
      out.push({ x, y })
    }
  }
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) {
    out.pop()
  }
  if (out.length < 3) return []
  let a2 = 0
  for (let i = 0; i < out.length; i++) {
    const p = out[i]
    const q = out[(i + 1) % out.length]
    a2 += p.x * q.y - q.x * p.y
  }
  if (a2 < 0) out.reverse()
  return out
}

/** 扫描线填充多边形 -> 1mm 栅格 */
function rasterize(poly: Point2D[], minX: number, minY: number, W: number, H: number): Uint8Array {
  const grid = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const sy = minY + y + 0.5
    const xs: number[] = []
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      if (p.y === q.y) continue
      if ((p.y > sy) !== (q.y > sy)) {
        const x = p.x + ((sy - p.y) * (q.x - p.x)) / (q.y - p.y)
        xs.push(x)
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i] - minX))
      const x1 = Math.min(W, Math.max(0, Math.floor(xs[i + 1] - minX)))
      for (let x = x0; x < x1; x++) grid[y * W + x] = 1
    }
  }
  return grid
}

/** 点在正交多边形内 (射线法) */
function pointInPolygon(p: Point2D, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** 多边形面积 (鞋带公式, 绝对值) */
function polygonArea(pts: Point2D[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

// ---------------------------------------------------------------------------
// 区域 (1mm 栅格) + 贪心矩形分割
// ---------------------------------------------------------------------------

interface Region {
  x: number
  y: number
  w: number
  h: number
  mask: Uint8Array
}

// 融合阶段会反复查询同一 Region 的面积、边界和轮廓。板数达到 20+ 时若每次都
// 扫描整张 1mm mask，会形成明显的 O(n² × 板面积) 放大；Region 在进入融合阶段
// 后视为不可变，使用 WeakMap 可在任务结束后自动释放缓存。
const regionAreaCache = new WeakMap<Region, number>()
const regionLoopsCache = new WeakMap<Region, Point2D[][]>()
const regionContourCache = new WeakMap<Region, Point2D[]>()
const regionRightRunsCache = new WeakMap<Region, Uint32Array>()
const regionBoundaryEdgesCache = new WeakMap<Region, Set<string>>()

function regionArea(r: Region): number {
  const cached = regionAreaCache.get(r)
  if (cached !== undefined) return cached
  const area = countOnes(r.mask)
  regionAreaCache.set(r, area)
  return area
}

/** 每个材料单元向右连续覆盖的毫米数；同一区域的候选锚点会反复复用。 */
function regionRightRuns(r: Region): Uint32Array {
  const cached = regionRightRunsCache.get(r)
  if (cached) return cached
  const runs = new Uint32Array(r.mask.length)
  for (let y = 0; y < r.h; y++) {
    let run = 0
    const row = y * r.w
    for (let x = r.w - 1; x >= 0; x--) {
      run = r.mask[row + x] ? run + 1 : 0
      runs[row + x] = run
    }
  }
  regionRightRunsCache.set(r, runs)
  return runs
}

/**
 * 区域外边界的无向单位边集合。融合阶段只需要比较边界，不能每次都重新
 * 扫描整个填充区域；缓存后共享边计算从 O(板面积) 降为 O(板周长)。
 */
function regionBoundaryEdges(r: Region): Set<string> {
  const cached = regionBoundaryEdgesCache.get(r)
  if (cached) return cached
  const edges = new Set<string>()
  for (let ly = 0; ly < r.h; ly++) {
    for (let lx = 0; lx < r.w; lx++) {
      if (!r.mask[ly * r.w + lx]) continue
      const x = r.x + lx, y = r.y + ly
      if (!regionCell(r, x, y - 1)) edges.add(`h:${x},${y}`)
      if (!regionCell(r, x + 1, y)) edges.add(`v:${x + 1},${y}`)
      if (!regionCell(r, x, y + 1)) edges.add(`h:${x},${y + 1}`)
      if (!regionCell(r, x - 1, y)) edges.add(`v:${x},${y}`)
    }
  }
  regionBoundaryEdgesCache.set(r, edges)
  return edges
}

interface RectMM {
  x: number
  y: number
  w: number
  h: number
}

interface HoleBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

function regionCell(r: Region, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h &&
    r.mask[(y - r.y) * r.w + (x - r.x)] === 1
}

function polygonBox(poly: Point2D[]): HoleBox {
  return {
    x0: Math.min(...poly.map(p => p.x)),
    y0: Math.min(...poly.map(p => p.y)),
    x1: Math.max(...poly.map(p => p.x)),
    y1: Math.max(...poly.map(p => p.y)),
  }
}

/** 避缝阶段：候选面板不能切过受保护的内孔安全包围盒；必要时主流程会逐孔放宽。 */
function cutsHole(rect: RectMM, holes: HoleBox[]): boolean {
  const rx1 = rect.x + rect.w
  const ry1 = rect.y + rect.h
  return holes.some(h => {
    // 给内孔和拼板接缝留出最小几何间隔，避免 hole Path 与外环相切导致三角化失败。
    const clearance = 0.5
    const x0 = h.x0 - clearance, x1 = h.x1 + clearance
    const y0 = h.y0 - clearance, y1 = h.y1 + clearance
    const overlaps = x1 > rect.x + EPS && x0 < rx1 - EPS &&
      y1 > rect.y + EPS && y0 < ry1 - EPS
    if (!overlaps) return false
    const contains = x0 >= rect.x - EPS && x1 <= rx1 + EPS &&
      y0 >= rect.y - EPS && y1 <= ry1 + EPS
    return !contains
  })
}

function countOnes(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++
  return n
}

const printFitCache = new Map<string, number | null>()

/**
 * 计算轮廓在矩形热床中的建议旋转角。旋转后 X/Y 投影必须同时落入热床；
 * 因此细长件可利用对角线超过单边尺寸，但宽件不会仅凭自身长度小于对角线就被放行。
 */
function findPrintFitAngle(points: Point2D[], cfg: SplitConfig): number | null {
  if (points.length < 3) return null
  const STEP = 0.25
  for (let angle = 0; angle <= 90 + EPS; angle += STEP) {
    if (findFootprintPlacement(rotatePlanarPoints(points, angle), cfg)) {
      return Math.round(angle * 100) / 100
    }
  }
  return null
}

function findRectPrintFitAngle(w: number, h: number, cfg: SplitConfig): number | null {
  const keepouts = cfg.bedKeepouts.filter(z => z.enabled)
    .map(z => `${z.x},${z.y},${z.w},${z.h}`).join(';')
  const key = `${w}:${h}:${cfg.bedW}:${cfg.bedH}:${cfg.bedMarginLeft}:${cfg.bedMarginRight}:${cfg.bedMarginBottom}:${cfg.bedMarginTop}:${keepouts}`
  if (printFitCache.has(key)) return printFitCache.get(key) ?? null
  const printableBed = getPrintBedBounds(cfg)
  // 矩形的长边不能超过热床对角线，面积也不能超过有效热床面积。
  // 先排除这些必定失败的候选，避免逐 0.25° 做 361 次旋转/禁放区检测。
  if (Math.max(w, h) > Math.hypot(printableBed.width, printableBed.height) + EPS ||
      w * h > printableBed.width * printableBed.height + EPS) {
    printFitCache.set(key, null)
    return null
  }
  const angle = findPrintFitAngle([
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
  ], cfg)
  printFitCache.set(key, angle)
  return angle
}

/** 连通分量 (4 邻接) → Region 列表 */
function splitComponents(r: Region): Region[] {
  const comps: Region[] = []
  const seen = new Uint8Array(r.mask.length)
  const dirs = [1, -1, r.w, -r.w]
  for (let i = 0; i < r.mask.length; i++) {
    if (!r.mask[i] || seen[i]) continue
    let minX = i % r.w, maxX = i % r.w, minY = (i / r.w) | 0, maxY = minY
    const stack = [i]
    seen[i] = 1
    const pts: number[] = []
    while (stack.length) {
      const cur = stack.pop()!
      pts.push(cur)
      const cx = cur % r.w, cy = (cur / r.w) | 0
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
      for (const d of dirs) {
        const ni = cur + d
        if (ni < 0 || ni >= r.mask.length) continue
        if (Math.abs((ni % r.w) - cx) + Math.abs(((ni / r.w) | 0) - cy) !== 1) continue
        if (r.mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni) }
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1
    const mask = new Uint8Array(w * h)
    for (const p of pts) mask[(((p / r.w) | 0) - minY) * w + (p % r.w - minX)] = 1
    comps.push({ x: r.x + minX, y: r.y + minY, w, h, mask })
  }
  return comps
}

/** 板是否可接受: 标准 (≥minW×minH) 或 补边条料 (≥20×20 且面积足够) */
function pieceAcceptable(w: number, h: number, cfg: SplitConfig): boolean {
  if (w <= 0 || h <= 0) return false
  if (findRectPrintFitAngle(w, h, cfg) === null) return false
  if (w >= cfg.minW && h >= cfg.minH) return true
  // 缺块补偿: 边缘条料/小补偿板 (≥20mm 厚, 面积 ≥2400mm²) 也出板
  return w >= 20 && h >= 20 && w * h >= 2400
}

/**
 * 最大合法矩形 (greedy v2):
 *  - 锚点只在模数线 (板原点 + 40k / +20k) 上 → 接缝不切孔
 *  - 宽/高向下取整到模数; 当矩形到达区域边界 (板外缘) 时允许以边界为准 (补偿条料)
 *  - 面积最大优先, 平局取更宽
 */
function findBestRect(
  r: Region, cfg: SplitConfig, boardX: number, boardY: number, holes: HoleBox[],
): RectMM | null {
  let best: RectMM | null = null
  let bestArea = -1
  let bestExposed = -1
  const fullRectRegion = countOnes(r.mask) === r.w * r.h
  const printableBed = getPrintBedBounds(cfg)
  const maxPrintableSpan = Math.hypot(printableBed.width, printableBed.height)
  const rightRuns = regionRightRuns(r)
  const tinyRemainder = (w: number, h: number) =>
    w > 0 && h > 0 && (w < 20 || h < 20 || w * h < 2400)
  const cell = (x: number, y: number) =>
    x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h &&
    r.mask[(y - r.y) * r.w + (x - r.x)] === 1

  for (let x0 = Math.ceil((r.x - boardX) / cfg.mx) * cfg.mx + boardX; x0 < r.x + r.w; x0 += cfg.mx) {
    if (x0 < r.x) continue
    for (let y0 = Math.ceil((r.y - boardY) / cfg.my) * cfg.my + boardY; y0 < r.y + r.h; y0 += cfg.my) {
      if (y0 < r.y || !cell(x0, y0)) continue
      const localX = x0 - r.x
      const localY = y0 - r.y
      let runHeight = 0
      while (localY + runHeight < r.h && rightRuns[(localY + runHeight) * r.w + localX] > 0) {
        runHeight++
      }
      let minW = Infinity
      let lastTestedMinW = -1
      let lastTestedHMod = -1
      for (let hRaw = 1; hRaw <= runHeight; hRaw++) {
        minW = Math.min(minW, rightRuns[(localY + hRaw - 1) * r.w + localX])
        // 宽度候选: 模数取整; 若直到区域右边界则可取实际宽 (边缘条料补偿)
        const wMod = Math.floor(Math.min(minW, maxPrintableSpan) / cfg.mx) * cfg.mx
        const rightEdge = x0 + minW >= r.x + r.w - EPS
        // 不能只尝试“该锚点能取得的最大宽度”：当它放不进热床时，旧逻辑会跳到
        // 中间锚点取一块大板，导致余量同时散落在左右两边。现在向下枚举模数宽度，
        // 再用贴外缘平局规则选中边界板，使一整排通常只留下单侧余块。
        const wCands: number[] = []
        for (let w = wMod; w > 0; w -= cfg.mx) wCands.push(w)
        if (rightEdge && minW > 0 && minW <= maxPrintableSpan + EPS && !wCands.includes(minW)) {
          wCands.push(minW)
        }
        // 高度候选: 模数取整; 若直到区域顶边界则可取实际高
        const hMod = Math.floor(hRaw / cfg.my) * cfg.my
        const topEdge = y0 + hRaw >= r.y + r.h - EPS
        const hCands = hMod > 0 ? [hMod] : []
        if (topEdge && hRaw !== hMod) hCands.push(hRaw)
        // 在正交轮廓的连续竖带内，minW 通常数十行不变；hMod 也只按 my
        // 改变。旧实现会对相同的宽高候选逐毫米重复测试。
        if (!topEdge && minW === lastTestedMinW && hMod === lastTestedHMod) continue
        lastTestedMinW = minW
        lastTestedHMod = hMod
        for (const w of wCands) {
          for (const h of hCands) {
            if (!pieceAcceptable(w, h, cfg)) continue
            if (cutsHole({ x: x0, y: y0, w, h }, holes)) continue
            if (fullRectRegion) {
              // 覆盖率优先：完整矩形区域若被候选板切出 <20mm 或 <2400mm² 的
              // 单侧薄条，后续既无法独立成板也通常无法回并，直接放弃该候选。
              if (y0 === r.y && h === r.h && (
                tinyRemainder(x0 - r.x, r.h) ||
                tinyRemainder(r.x + r.w - x0 - w, r.h)
              )) continue
              if (x0 === r.x && w === r.w && (
                tinyRemainder(r.w, y0 - r.y) ||
                tinyRemainder(r.w, r.y + r.h - y0 - h)
              )) continue
            }
            const area = w * h
            // 同面积时优先贴住原轮廓外缘：把不可规则化的小余料推向装配外侧，
            // 后续融合时能用更短的内部接缝把它吸收到相邻大板里。
            let exposed = 0
            if (area >= bestArea) {
              for (let x = x0; x < x0 + w; x++) {
                if (!cell(x, y0 - 1)) exposed++
                if (!cell(x, y0 + h)) exposed++
              }
              for (let y = y0; y < y0 + h; y++) {
                if (!cell(x0 - 1, y)) exposed++
                if (!cell(x0 + w, y)) exposed++
              }
            }
            if (area > bestArea ||
              (area === bestArea && (exposed > bestExposed ||
                (exposed === bestExposed && best && w > best.w)))) {
              bestArea = area
              bestExposed = exposed
              best = { x: x0, y: y0, w, h }
            }
          }
        }
      }
    }
  }
  return best
}

/** 从区域中挖走一个矩形, 返回剩余分量 */
function removeRect(r: Region, rect: RectMM): Region[] {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) {
        r.mask[(y - r.y) * r.w + (x - r.x)] = 0
      }
    }
  }
  return splitComponents(r)
}

/** 贪心矩形分割 + 缺块补偿 (v2 风格) */
function greedyPartition(
  root: Region, cfg: SplitConfig, boardX: number, boardY: number, holes: HoleBox[] = [],
): { pieces: Region[]; warnings: string[] } {
  const pieces: Region[] = []
  const leftovers: Region[] = []
  const work: Region[] = [root]
  let guard = 0
  while (work.length && guard++ < 3000) {
    const r = work.pop()!
    // 极小残留: 留给补偿/合并阶段
    if (r.w * r.h < 400) { leftovers.push(r); continue }
    const best = findBestRect(r, cfg, boardX, boardY, holes)
    if (!best) { leftovers.push(r); continue }
    pieces.push({ x: best.x, y: best.y, w: best.w, h: best.h, mask: new Uint8Array(best.w * best.h).fill(1) })
    work.push(...removeRect(r, best))
  }

  const warnings: string[] = []
  // 碎料合并: 先尽量并进共享边最长的相邻板；这里允许形成可打印的正交异形板。
  for (const L of leftovers) {
    const lArea = regionArea(L)
    if (lArea === 0) continue
    // ① 本身就是完整矩形且可接受 (小补偿板) → 直接出板
    if (L.w * L.h === lArea && pieceAcceptable(L.w, L.h, cfg)) {
      pieces.push({ x: L.x, y: L.y, w: L.w, h: L.h, mask: new Uint8Array(L.w * L.h).fill(1) })
      continue
    }
    // ② 找共享边最长的相邻板合并
    let bestN: Region | null = null
    let bestShared = 0
    for (const p of pieces) {
      const s = sharedEdgeLen(p, L)
      if (s > bestShared) { bestShared = s; bestN = p }
    }
    let merged = false
    if (bestN && bestShared > 0) {
      const union = mergeRegions(bestN, L, cfg)
      if (union && regionBoundaryLoops(union).length === 1) {
        const bestIndex = pieces.indexOf(bestN)
        if (bestIndex >= 0) pieces[bestIndex] = union
        merged = true
      }
    }
    if (!merged) {
      warnings.push(`已丢弃无法补偿的碎料 (${L.w}x${L.h}mm @ ${L.x},${L.y})`)
    }
  }
  const fused = fuseAdjacentPieces(pieces, cfg)
  return { pieces: fused.pieces, warnings }
}

function isOrthogonalContour(points: Point2D[]): boolean {
  return points.every((point, index) => {
    const next = points[(index + 1) % points.length]
    return Math.abs(next.x - point.x) <= EPS || Math.abs(next.y - point.y) <= EPS
  })
}

/** 将一个跨度均匀切成不超过 maxSpan 的段，内部接缝尽量吸附到模数线。 */
function partitionAxis(start: number, span: number, maxSpan: number, module: number): number[] {
  if (span <= maxSpan + EPS) return [start, start + span]
  const count = Math.max(1, Math.ceil(span / maxSpan))
  const cuts = [start]
  for (let index = 1; index < count; index++) {
    const ideal = start + span * index / count
    const snapped = start + Math.round((ideal - start) / module) * module
    const minCut = cuts[cuts.length - 1] + Math.min(module, maxSpan)
    const remaining = count - index
    const maxCut = start + span - remaining * Math.min(module, maxSpan)
    cuts.push(Math.max(minCut, Math.min(maxCut, snapped)))
  }
  cuts.push(start + span)
  return cuts
}

/**
 * 可靠覆盖模式：先用能放入热床的最大矩形平铺包围盒，随后再与原轮廓精确相交。
 * 矩形分区本身无缝且不重叠，因此相交后的子板并集严格等于原多边形。
 */
function exactCoverTiles(
  minX: number, minY: number, width: number, height: number, cfg: SplitConfig,
): Region[] {
  const bed = getPrintBedBounds(cfg)
  const diagonal = Math.hypot(bed.width, bed.height)
  let tileW = Math.min(width, bed.width)
  let tileH = Math.min(height, bed.height)
  let bestArea = 0
  for (let w = cfg.mx; w <= diagonal + EPS; w += cfg.mx) {
    for (let h = cfg.my; h <= diagonal + EPS; h += cfg.my) {
      const area = w * h
      if (area <= bestArea || !pieceAcceptable(w, h, cfg)) continue
      bestArea = area
      tileW = w
      tileH = h
    }
  }
  const xs = partitionAxis(minX, width, Math.max(1, tileW), Math.max(1, cfg.mx))
  const ys = partitionAxis(minY, height, Math.max(1, tileH), Math.max(1, cfg.my))
  const tiles: Region[] = []
  for (let yi = 0; yi + 1 < ys.length; yi++) {
    for (let xi = 0; xi + 1 < xs.length; xi++) {
      const x = xs[xi], y = ys[yi]
      const w = Math.max(1, Math.round(xs[xi + 1] - x))
      const h = Math.max(1, Math.round(ys[yi + 1] - y))
      tiles.push({ x, y, w, h, mask: new Uint8Array(w * h).fill(1) })
    }
  }
  return tiles
}

/** 两块（矩形或异形）区域的真实共享边长度。 */
function sharedEdgeLen(a: Region, b: Region): number {
  // 大布局中绝大多数板块相距很远。先用半开包围盒排除，避免为每一对板
  // 扫描较小板块的整张 1mm mask。
  if (a.x + a.w < b.x - EPS || b.x + b.w < a.x - EPS ||
      a.y + a.h < b.y - EPS || b.y + b.h < a.y - EPS) return 0
  const small = regionArea(a) <= regionArea(b) ? a : b
  const other = small === a ? b : a
  const smallEdges = regionBoundaryEdges(small)
  const otherEdges = regionBoundaryEdges(other)
  let shared = 0
  for (const edge of smallEdges) if (otherEdges.has(edge)) shared++
  return shared
}

/** 合并两块相邻材料；只检查热床包围盒，轮廓可为任意连通正交形状。 */
function mergeRegions(a: Region, b: Region, cfg: SplitConfig, knownShared?: number): Region | null {
  if ((knownShared ?? sharedEdgeLen(a, b)) <= 0) return null
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  const w = x2 - x, h = y2 - y
  const mask = new Uint8Array(w * h)
  for (const r of [a, b]) {
    for (let ry = 0; ry < r.h; ry++) {
      for (let rx = 0; rx < r.w; rx++) {
        if (r.mask[ry * r.w + rx]) mask[(r.y + ry - y) * w + r.x + rx - x] = 1
      }
    }
  }
  const union = { x, y, w, h, mask }
  const contour = regionContour(union)
  if (contour.length < 4 || findPrintFitAngle(contour, cfg) === null) return null
  return union
}

interface GridPoint { x: number; y: number }
interface GridEdge { a: GridPoint; b: GridPoint; used: boolean }

function gridKey(p: GridPoint): string { return `${p.x},${p.y}` }

function simplifyGridLoop(points: Point2D[]): Point2D[] {
  const out = points.slice()
  let changed = true
  while (changed && out.length > 3) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i - 1 + out.length) % out.length]
      const cur = out[i]
      const next = out[(i + 1) % out.length]
      if ((prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y)) {
        out.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return out
}

/** 从 1mm 材料掩膜追踪真实外环；外环 CCW，若有空腔会额外返回 CW 环。 */
function regionBoundaryLoops(r: Region): Point2D[][] {
  const cached = regionLoopsCache.get(r)
  if (cached) return cached
  const edges: GridEdge[] = []
  const add = (ax: number, ay: number, bx: number, by: number) =>
    edges.push({ a: { x: ax, y: ay }, b: { x: bx, y: by }, used: false })
  for (let ly = 0; ly < r.h; ly++) {
    for (let lx = 0; lx < r.w; lx++) {
      if (!r.mask[ly * r.w + lx]) continue
      const x = r.x + lx, y = r.y + ly
      if (!regionCell(r, x, y - 1)) add(x, y, x + 1, y)
      if (!regionCell(r, x + 1, y)) add(x + 1, y, x + 1, y + 1)
      if (!regionCell(r, x, y + 1)) add(x + 1, y + 1, x, y + 1)
      if (!regionCell(r, x - 1, y)) add(x, y + 1, x, y)
    }
  }
  const byStart = new Map<string, GridEdge[]>()
  for (const edge of edges) {
    const list = byStart.get(gridKey(edge.a)) ?? []
    list.push(edge)
    byStart.set(gridKey(edge.a), list)
  }
  const loops: Point2D[][] = []
  for (const first of edges) {
    if (first.used) continue
    const points: Point2D[] = []
    let edge: GridEdge | undefined = first
    const startKey = gridKey(first.a)
    let guard = 0
    while (edge && !edge.used && guard++ <= edges.length + 1) {
      edge.used = true
      points.push({ ...edge.a })
      const endKey = gridKey(edge.b)
      if (endKey === startKey) break
      edge = (byStart.get(endKey) ?? []).find(candidate => !candidate.used)
    }
    const loop = simplifyGridLoop(points)
    if (loop.length >= 4 && Math.abs(polygonArea(loop)) > EPS) loops.push(loop)
  }
  const sorted = loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))
  regionLoopsCache.set(r, sorted)
  return sorted
}

function regionContour(r: Region): Point2D[] {
  const cached = regionContourCache.get(r)
  if (cached) return cached
  const loops = regionBoundaryLoops(r)
  if (loops.length === 0) return []
  const outer = loops[0]
  const contour = polygonArea(outer) >= 0 ? outer : outer.slice().reverse()
  regionContourCache.set(r, contour)
  return contour
}

/**
 * 快速边缘融合：每次选择能消除最长内部接缝的一对，相同接缝时优先吸收小板。
 * 这是受热床包围盒约束的局部凝聚过程，不做指数级 DFS；常见 10~30 块布局为毫秒级。
 */
function fuseAdjacentPieces(source: Region[], cfg: SplitConfig): { pieces: Region[]; mergedCount: number } {
  const pieces = source.slice()
  let mergedCount = 0
  let guard = 0
  while (guard++ < 500) {
    let best: { i: number; j: number; union: Region; shared: number; absorbed: number; fill: number } | null = null
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const shared = sharedEdgeLen(pieces[i], pieces[j])
        if (shared <= 0) continue
        const union = mergeRegions(pieces[i], pieces[j], cfg, shared)
        if (!union) continue
        // 拒绝产生临时空腔或自接触轮廓，避免与尚未融合的板重叠。
        if (regionBoundaryLoops(union).length !== 1) continue
        const area = regionArea(union)
        const absorbed = Math.min(regionArea(pieces[i]), regionArea(pieces[j]))
        const fill = area / (union.w * union.h)
        if (!best || shared > best.shared ||
          (shared === best.shared && (absorbed < best.absorbed ||
            (absorbed === best.absorbed && fill > best.fill)))) {
          best = { i, j, union, shared, absorbed, fill }
        }
      }
    }
    if (!best) break
    pieces[best.i] = best.union
    pieces.splice(best.j, 1)
    mergedCount++
  }
  return { pieces, mergedCount }
}

// ---------------------------------------------------------------------------
// 孔位生成 (所有分板共享整张装配轮廓的全局晶体阵列)
// ---------------------------------------------------------------------------

/** 分板包围盒 (全局 mm 坐标) */
export interface BoardBox {
  x: number
  y: number
  w: number
  h: number
}

/** 最终板材外轮廓 (全局 mm, CCW); 可包含布尔扣孔形成的凹边。 */
function panelContour(p: { x: number; y: number; w: number; h: number; contour?: Point2D[] }): Point2D[] {
  if (p.contour && p.contour.length >= 4) return p.contour
  return [
    { x: p.x, y: p.y }, { x: p.x + p.w, y: p.y },
    { x: p.x + p.w, y: p.y + p.h }, { x: p.x, y: p.y + p.h },
  ]
}

/**
 * 槽孔 (竖向长圆孔 5×15) 晶体错列阵列:
 *   A 列族: (ox+10 + 40i, oy+30 + 40j); B 列族: (ox+30 + 40i, oy+10 + 40j)
 * ox/oy 是整张装配轮廓左下角。分板只裁切这套阵列，不能重新从自身左下角起排，
 * 否则相邻板（例如上下相差 220mm 的 P7/P4）会出现相同相位而中断晶格交错。
 * 仅保留整颗胶囊 (含两端半圆) 完全落在板轮廓内。
 */
function boxTouchesCutout(
  x0: number, y0: number, x1: number, y1: number, cutouts: Point2D[][],
): boolean {
  return cutouts.some(c => {
    const b = polygonBox(c)
    return x1 >= b.x0 - EPS && x0 <= b.x1 + EPS && y1 >= b.y0 - EPS && y0 <= b.y1 + EPS
  })
}

function generateSlots(
  contour: Point2D[], board: BoardBox, lattice: Pick<BoardBox, 'x' | 'y'>,
  cfg: SplitConfig, cutouts: Point2D[][] = [],
): HolePos[] {
  const halfL = cfg.slotLength / 2
  const halfW = cfg.slotWidth / 2
  const slots: HolePos[] = []
  const families = [
    { dx: 0, dy: 0 },
    { dx: cfg.slotStaggerX, dy: -cfg.slotStaggerY },
  ]
  for (const fam of families) {
    const baseX = lattice.x + cfg.slotGridX0 + fam.dx
    const baseY = lattice.y + cfg.slotGridY0 + fam.dy
    const pitchY = cfg.my * 2
    const i0 = Math.floor((board.x - baseX) / cfg.mx) - 1
    const i1 = Math.ceil((board.x + board.w - baseX) / cfg.mx) + 1
    const j0 = Math.floor((board.y - baseY) / pitchY) - 1
    const j1 = Math.ceil((board.y + board.h - baseY) / pitchY) + 1
    for (let i = i0; i <= i1; i++) {
      const cx = baseX + i * cfg.mx
      for (let j = j0; j <= j1; j++) {
        const cy = baseY + j * pitchY
        const ok = pointInPolygon({ x: cx - halfW, y: cy - halfL }, contour) &&
          pointInPolygon({ x: cx + halfW, y: cy - halfL }, contour) &&
          pointInPolygon({ x: cx - halfW, y: cy + halfL }, contour) &&
          pointInPolygon({ x: cx + halfW, y: cy + halfL }, contour)
        if (ok && !boxTouchesCutout(cx - halfW, cy - halfL, cx + halfW, cy + halfL, cutouts)) {
          slots.push({ x: cx, y: cy })
        }
      }
    }
  }
  return slots
}

/**
 * 边缘敲落圆孔 (默认 φ5，中心距边 10mm，40mm 间距)。
 *
 * DXF 不是“沿边盲排孔”，而是把圆孔放在槽孔两组中心轴线的交点：
 *   A 槽中心轴: x=10+40i, y=30+40j
 *   B 槽中心轴: x=32.2648+40i, y=10+40j（来自 200.200 平面工程图 SVG）
 *   边内缩 10mm 后吸附到最近 A/B 轴线；超过 5mm 仍无轴线时，该边不生成圆孔。
 * 所有相位均锚定整张装配轮廓。每块分板仍独立沿自身边界内缩并生成孔列，
 * 但接缝两侧的孔列继承全局 A/B 相位，因此会连续交错而不会重复起排。
 */
function generateEdgeHoles(
  contour: Point2D[], board: BoardBox, lattice: Pick<BoardBox, 'x' | 'y'>,
  cfg: SplitConfig, cutouts: Point2D[][] = [], materialContour: Point2D[] = contour,
): HolePos[] {
  const insetX = cfg.jointOffsetX
  const insetY = cfg.jointOffsetY
  const pit = cfg.mx
  const slots = generateSlots(materialContour, board, lattice, cfg, cutouts)
  const holes: HolePos[] = []
  const seen = new Set<string>()
  type AxisFamily = 'A' | 'B'
  const nearestAxis = (
    local: number,
    aPhase: number,
    bPhase: number,
  ): { value: number; family: AxisFamily } | null => {
    const candidate = (phase: number, family: AxisFamily) => {
      const value = phase + Math.round((local - phase) / pit) * pit
      return { value, family, distance: Math.abs(value - local) }
    }
    const a = candidate(aPhase, 'A')
    const b = candidate(bPhase, 'B')
    const best = a.distance <= b.distance ? a : b
    // 边长不是 20mm 模数整数时允许最多半个 10mm 边距的补偿吸附。
    // 例如 145mm 高板: 顶部目标135 → 槽轴130 (5mm, 合法);
    // 32mm 窄条: 右侧目标22 → 最近槽轴30 (8mm, 非法)。
    const tolerance = Math.max(insetX, insetY) / 2 + cfg.gapTolerance
    return best.distance <= tolerance + EPS ? { value: best.value, family: best.family } : null
  }
  /**
   * 水平边孔的 y 轴若属于 A 槽行(30相位)，x 取 B 槽列(30相位)；
   * 若属于 B 槽行(10相位)，x 取 A 槽列(10相位)。其余无交点。
   */
  const horizontalAxis = (globalY: number) => nearestAxis(
    globalY,
    lattice.y + cfg.slotGridY0,
    lattice.y + cfg.slotGridY0 - cfg.slotStaggerY,
  )
  const verticalAxis = (globalX: number) => nearestAxis(
    globalX,
    lattice.x + cfg.slotGridX0,
    lattice.x + cfg.slotGridX0 + cfg.slotStaggerX,
  )
  const push = (x: number, y: number) => {
    const k = `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`
    if (seen.has(k)) return
    // 与槽孔冲突: 把胶囊中心线按圆孔半径膨胀后做精确距离判断。
    // 旧代码使用严格小于号, 相切/浮点边界会漏掉, 于是薄盖圆片可能落进长圆孔。
    const expandedR = cfg.slotWidth / 2 + cfg.jointDiameter / 2 + 0.2
    const straightHalf = Math.max(0, (cfg.slotLength - cfg.slotWidth) / 2)
    const collide = slots.some(s => {
      const dx = x - s.x
      const dy = Math.max(0, Math.abs(y - s.y) - straightHalf)
      return dx * dx + dy * dy <= expandedR * expandedR + EPS
    })
    if (collide) return
    const hr = cfg.jointDiameter / 2
    if (boxTouchesCutout(x - hr, y - hr, x + hr, y + hr, cutouts)) return
    seen.add(k)
    holes.push({ x, y })
  }
  const pushHorizontal = (
    y: number, x0: number, x1: number, xPhase: number,
  ) => {
    const i0 = Math.ceil((x0 + insetX - xPhase - EPS) / pit)
    for (let i = i0; ; i++) {
      const cx = xPhase + i * pit
      if (cx > x1 - insetX + EPS) break
      push(cx, y)
    }
  }
  const pushVertical = (
    x: number, y0: number, y1: number, yPhase: number,
  ) => {
    const j0 = Math.ceil((y0 + insetY - yPhase - EPS) / pit)
    for (let j = j0; ; j++) {
      const cy = yPhase + j * pit
      if (cy > y1 - insetY + EPS) break
      push(x, cy)
    }
  }
  const n = contour.length
  for (let i = 0; i < n; i++) {
    const a = contour[i]
    const b = contour[(i + 1) % n]
    const horizontal = Math.abs(b.y - a.y) < EPS
    if (!horizontal && Math.abs(b.x - a.x) > EPS) continue
    if (horizontal) {
      // contour 为 CCW: 边的左侧就是面板内部。
      // 水平向右=底边, 内法线 +Y; 水平向左=顶边, 内法线 -Y。
      const isBottom = b.x > a.x
      const desiredY = a.y + (isBottom ? insetY : -insetY)
      const axis = horizontalAxis(desiredY)
      if (!axis) continue
      const holeY = axis.value
      // A 横轴配 B 竖轴；B 横轴配 A 竖轴。
      const xPhase = axis.family === 'A'
        ? lattice.x + cfg.slotGridX0 + cfg.slotStaggerX
        : lattice.x + cfg.slotGridX0
      pushHorizontal(
        holeY, Math.min(a.x, b.x), Math.max(a.x, b.x), xPhase,
      )
    } else {
      // 竖直向上=右边, 内法线 -X; 竖直向下=左边, 内法线 +X。
      const isRight = b.y > a.y
      const desiredX = a.x + (isRight ? -insetX : insetX)
      const axis = verticalAxis(desiredX)
      if (!axis) continue
      const holeX = axis.value
      const yPhase = axis.family === 'A'
        ? lattice.y + cfg.slotGridY0 - cfg.slotStaggerY
        : lattice.y + cfg.slotGridY0
      pushVertical(
        holeX, Math.min(a.y, b.y), Math.max(a.y, b.y), yPhase,
      )
    }
  }
  const diskInsideMaterial = (hole: HolePos) => {
    const radius = cfg.jointDiameter / 2 + 0.15
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      if (!pointInPolygon({
        x: hole.x + Math.cos(a) * radius,
        y: hole.y + Math.sin(a) * radius,
      }, materialContour)) return false
    }
    return true
  }
  return holes.filter(diskInsideMaterial)
}

/**
 * 推荐敲落: 只保留【装配体外边界边】端点附近的锚位 (距离 ≤35mm), 内部拼缝不成对。
 */
function recommendKnockouts(panels: SplitPanel[], cfg: SplitConfig, origPoly: Point2D[]): void {
  if (!cfg.recommendKnockouts) return
  const isOutside = (p: Point2D) => !pointInPolygon(p, origPoly)
  for (const p of panels) {
    const contour = panelContour(p)
    const n = contour.length
    const ends: Point2D[] = []
    for (let i = 0; i < n; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % n]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      // contour 为 CCW, 面板外侧是边行进方向的右法线 (dy, -dx)。
      // 不能再按整板中心猜测，否则上半部面板的底边、右半部面板的左边会被误判为外边界。
      const dx = Math.sign(b.x - a.x)
      const dy = Math.sign(b.y - a.y)
      const out = { x: mid.x + dy, y: mid.y - dx }
      if (!isOutside(out)) continue
      ends.push(a, b)
    }
    const ringed: Point2D[] = []
    for (const c of ends) {
      if (!ringed.some(q => Math.abs(q.x - c.x) < 0.01 && Math.abs(q.y - c.y) < 0.01)) ringed.push(c)
    }
    for (const c of ringed) {
      let best: HolePos | null = null
      let bestD = Infinity
      for (const h of p.edge_holes) {
        if (h.knocked) continue
        const d = Math.hypot(h.x - c.x, h.y - c.y)
        if (d < bestD) { bestD = d; best = h }
      }
      if (best && bestD <= 35) best.knocked = true
    }
  }
  const PAIR = 29
  for (let i = 0; i < panels.length; i++) {
    for (const h of panels[i].edge_holes) {
      if (!h.knocked) continue
      for (let j = 0; j < i; j++) {
        for (const g of panels[j].edge_holes) {
          if (!g.knocked) continue
          if (Math.hypot(h.x - g.x, h.y - g.y) < PAIR) { h.knocked = false; break }
        }
        if (!h.knocked) break
      }
    }
  }
}

/**
 * 用【最终分板并集】在板角四个象限的占用关系判定：
 *   - 仅 1 个象限被任意成品板占用 → 当前成品装配的外露凸角，做 R8；
 *   - 2 个象限 → 成品装配平边上的分割点，直角；
 *   - 3 个象限 → 成品装配凹角，直角；
 *   - 4 个象限 → 装配内部拼接点，直角。
 *
 * 不能继续查询原始草图多边形：栅格取整、窄补偿条或碎料合并后，最终板角可能与
 * 原轮廓相差少量距离。此时画面上已经外露的 P4/P5 凸角仍会被原轮廓误判为平边，
 * 导致 2D/3D 都漏掉圆角。以实际输出板块并集判断才与最终制造几何一致。
 */
function roundableIndices(
  p: { x: number; y: number; w: number; h: number; contour?: Point2D[] },
  panels: Array<{ x: number; y: number; w: number; h: number; contour?: Point2D[] }>,
  holes: Point2D[][] = [],
): number[] {
  const contour = panelContour(p)
  const out: number[] = []
  const probe = 0.75
  const n = contour.length
  for (let i = 0; i < n; i++) {
    const prev = contour[(i - 1 + n) % n]
    const cur = contour[i]
    const next = contour[(i + 1) % n]
    const d1 = { x: cur.x - prev.x, y: cur.y - prev.y }
    const d2 = { x: next.x - cur.x, y: next.y - cur.y }
    const cross = d1.x * d2.y - d1.y * d2.x
    if (cross <= EPS) continue
    const firstAxisAligned = Math.abs(d1.x) <= EPS || Math.abs(d1.y) <= EPS
    const secondAxisAligned = Math.abs(d2.x) <= EPS || Math.abs(d2.y) <= EPS
    if (!firstAxisAligned || !secondAxisAligned) continue
    // 用户开孔边界必须保持用户绘制的方/圆形状，不能套用板材外角 R8。
    const onHoleBoundary = holes.some(hole => hole.some((a, hi) => {
      const b = hole[(hi + 1) % hole.length]
      const vx = b.x - a.x, vy = b.y - a.y
      const len2 = vx * vx + vy * vy
      if (len2 < EPS) return Math.hypot(cur.x - a.x, cur.y - a.y) < 0.02
      const t = Math.max(0, Math.min(1, ((cur.x - a.x) * vx + (cur.y - a.y) * vy) / len2))
      return Math.hypot(cur.x - (a.x + vx * t), cur.y - (a.y + vy * t)) < 0.02
    }))
    if (onHoleBoundary) continue
    const occupied = [
      { x: cur.x - probe, y: cur.y - probe },
      { x: cur.x + probe, y: cur.y - probe },
      { x: cur.x + probe, y: cur.y + probe },
      { x: cur.x - probe, y: cur.y + probe },
    ].filter(q => panels.some(panel => pointInPolygon(q, panelContour(panel)))).length
    if (occupied === 1) out.push(i)
  }
  return out
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 正交多边形自动分割 (v2.6 主入口: 贪心铺板 + 块数优先边缘融合)
 */
export function splitOrthogonalPolygon(
  input: SplitInput,
  config: Partial<SplitConfig> = {},
): SplitResult {
  const cfg: SplitConfig = {
    ...PEGBOARD_DEFAULT_CONFIG,
    ...config,
    bedKeepouts: (config.bedKeepouts ?? PEGBOARD_DEFAULT_CONFIG.bedKeepouts).map(zone => ({ ...zone })),
  }
  const warnings: string[] = []

  // 1mm 栅格只用于规划内部接缝；用户外轮廓保留 0.001mm 精度，最终会精确裁剪回该轮廓。
  const poly = normalizeContour(input.points, 0.001)
  if (poly.length < 3) {
    return { panels: [], warnings: ['轮廓顶点不足，无法分割'], config: cfg, coveredArea: 0, inputArea: 0, coverageRatio: 0 }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const W = Math.max(1, Math.ceil(maxX - minX))
  const H = Math.max(1, Math.ceil(maxY - minY))
  const grid = rasterize(poly, minX, minY, W, H)

  // 内轮廓是真正的板内通孔。外轮廓先负责得到稳定的大板布局；内孔只用于接缝规划，
  // 最终再逐板执行精确布尔差集。这样小孔能完整归属单板，大孔也不会卡死分割器。
  const validHoles: Point2D[][] = []
  for (const hole of (input.holes ?? []).filter(h => h.length >= 3)) {
    const hp = normalizeContour(hole, 0.001)
    if (hp.length < 3) continue
    const insideCount = hp.filter(p => pointInPolygon(p, poly)).length
    if (insideCount === hp.length) validHoles.push(hp)
    else if (insideCount > 0) warnings.push('有内轮廓跨出外轮廓边界，已忽略该无效内孔')
  }

  const inputArea = Math.abs(polygonArea(poly)) - validHoles.reduce(
    (sum, hole) => sum + Math.abs(polygonArea(hole)), 0,
  )
  if (inputArea <= EPS) {
    return { panels: [], warnings: ['可用区域为空（外轮廓被内孔完全挖空）'], config: cfg, coveredArea: 0, inputArea: 0, coverageRatio: 0 }
  }

  // ---- 混合分板: 小孔优先完整归属单板；放不下时逐孔降级为允许跨板 ----
  const exactHoleBoxes = validHoles.map(polygonBox)
  const seamClearance = Math.max(0, cfg.holeSeamClearance)
  const expandedHoleBoxes = exactHoleBoxes.map(b => ({
    x0: b.x0 - seamClearance,
    y0: b.y0 - seamClearance,
    x1: b.x1 + seamClearance,
    y1: b.y1 + seamClearance,
  }))
  const containsBox = (p: Region, b: HoleBox) => {
    if (b.x0 < p.x - EPS || b.x1 > p.x + p.w + EPS ||
      b.y0 < p.y - EPS || b.y1 > p.y + p.h + EPS) return false
    const x0 = Math.floor(b.x0), x1 = Math.ceil(b.x1)
    const y0 = Math.floor(b.y0), y1 = Math.ceil(b.y1)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x + 1 <= b.x0 + EPS || x >= b.x1 - EPS ||
          y + 1 <= b.y0 + EPS || y >= b.y1 - EPS) continue
        if (!regionCell(p, x, y)) return false
      }
    }
    return true
  }
  const protectedHoleIdx = new Set<number>()
  for (let i = 0; i < expandedHoleBoxes.length; i++) {
    const b = expandedHoleBoxes[i]
    const w = b.x1 - b.x0, h = b.y1 - b.y0
    if (findRectPrintFitAngle(w, h, cfg) !== null) protectedHoleIdx.add(i)
    else {
      const exact = exactHoleBoxes[i]
      warnings.push(`内孔 ${Math.round(exact.x1 - exact.x0)}x${Math.round(exact.y1 - exact.y0)}mm 超出单板安全容纳范围，已自动允许跨板开孔`)
    }
  }

  let pieces: Region[] = []
  let partitionWarnings: string[] = []
  // 若严格避缝无法让某个孔完整归属单板，只放宽该孔，不牺牲其他可完整保留的孔。
  for (let attempt = 0; attempt <= validHoles.length; attempt++) {
    const root: Region = { x: minX, y: minY, w: W, h: H, mask: grid.slice() }
    const keepouts = [...protectedHoleIdx].map(i => expandedHoleBoxes[i])
    const partition = greedyPartition(root, cfg, minX, minY, keepouts)
    pieces = partition.pieces
    partitionWarnings = partition.warnings
    const failed = [...protectedHoleIdx].filter(i =>
      !pieces.some(piece => containsBox(piece, expandedHoleBoxes[i])))
    if (failed.length === 0) break
    for (const i of failed) {
      protectedHoleIdx.delete(i)
      const exact = exactHoleBoxes[i]
      warnings.push(`内孔 ${Math.round(exact.x1 - exact.x0)}x${Math.round(exact.y1 - exact.y0)}mm 无法在当前模数分板中完整避缝，已自动改用跨板开孔`)
    }
  }
  const rasterArea = countOnes(grid)
  const partitionArea = pieces.reduce((sum, piece) => sum + regionArea(piece), 0)
  const needsExactCover = !isOrthogonalContour(poly) ||
    partitionArea < rasterArea - EPS ||
    partitionWarnings.some(warning => warning.includes('丢弃'))
  if (needsExactCover) {
    pieces = exactCoverTiles(minX, minY, W, H, cfg)
    if (!isOrthogonalContour(poly)) warnings.push('已按原始矢量轮廓保留斜边，分板边界不会栅格化为台阶')
    else warnings.push('已自动切换完整覆盖分割，避免边缘碎料在板件之间形成空洞')
  } else {
    warnings.push(...partitionWarnings)
  }
  if (pieces.length === 0) {
    return {
      panels: [],
      warnings: ['当前板块无法生成任何满足尺寸要求的可打印板', ...warnings],
      config: cfg,
      coveredArea: 0,
      inputArea,
      coverageRatio: 0,
    }
  }

  // ---- 融合后的正交板逐板扣孔: 完整孔成为 hole ring，跨板孔成为外环上的真实缺口 ----
  const boxesOverlap = (a: HoleBox, b: HoleBox) =>
    a.x1 > b.x0 + EPS && a.x0 < b.x1 - EPS &&
    a.y1 > b.y0 + EPS && a.y0 < b.y1 - EPS
  for (let i = 0; i < exactHoleBoxes.length; i++) {
    const touched = pieces.filter(piece => boxesOverlap(
      { x0: piece.x, y0: piece.y, x1: piece.x + piece.w, y1: piece.y + piece.h },
      exactHoleBoxes[i],
    )).length
    if (touched > 1) {
      const b = exactHoleBoxes[i]
      warnings.push(`内孔 ${Math.round(b.x1 - b.x0)}x${Math.round(b.y1 - b.y0)}mm 已跨 ${touched} 块板精确开孔`)
    }
  }

  const latticeOrigin = { x: minX, y: minY }
  const outPanels: SplitPanel[] = []
  for (const piece of pieces) {
    const baseContour = regionContour(piece)
    if (baseContour.length < 4) {
      warnings.push(`板块 ${piece.w}x${piece.h}mm 的融合轮廓无效，已跳过`)
      continue
    }
    let clippedRegions: ReturnType<typeof intersectPanelWithPolygon>
    try {
      clippedRegions = intersectPanelWithPolygon(baseContour, poly)
    } catch (error) {
      warnings.push(`板块 ${piece.w}x${piece.h}mm 与原轮廓相交失败：${error instanceof Error ? error.message : '未知几何错误'}`)
      clippedRegions = []
    }
    for (const clipped of clippedRegions) {
      const clippedXs = clipped.contour.map(p => p.x)
      const clippedYs = clipped.contour.map(p => p.y)
      const clippedBox = {
        x0: Math.min(...clippedXs), y0: Math.min(...clippedYs),
        x1: Math.max(...clippedXs), y1: Math.max(...clippedYs),
      }
      const relevantHoles = validHoles.filter((_, i) => boxesOverlap(clippedBox, exactHoleBoxes[i]))
      let regions: ReturnType<typeof subtractHolesFromPanel>
      try {
        regions = subtractHolesFromPanel(clipped.contour, relevantHoles)
      } catch (error) {
        warnings.push(`板块 ${piece.w}x${piece.h}mm 内孔布尔运算失败：${error instanceof Error ? error.message : '未知几何错误'}`)
        regions = []
      }
      if (regions.length > 1) {
        warnings.push(`内孔把一块 ${piece.w}x${piece.h}mm 板切成 ${regions.length} 个不连通实体，已自动拆为独立板件`)
      }
      for (const region of regions) {
      const xs = region.contour.map(p => p.x)
      const ys = region.contour.map(p => p.y)
      const x = Math.min(...xs), y = Math.min(...ys)
      const w = Math.max(...xs) - x, h = Math.max(...ys) - y
      const panelGrid = { x, y, w, h }
      const panel: SplitPanel = {
        id: '',
        x, y, w, h,
        printRotation: findPrintFitAngle(region.contour, cfg) ?? 0,
        contour: region.contour,
        roundIdx: [],
        slots: generateSlots(region.contour, panelGrid, latticeOrigin, cfg, region.cutouts),
        round_holes: [],
        edge_holes: generateEdgeHoles(
          region.contour, panelGrid, latticeOrigin, cfg, region.cutouts, region.contour,
        ),
        cutouts: region.cutouts,
      }
      outPanels.push(panel)
      }
    }
  }

  outPanels.sort((a, b) => a.y - b.y || a.x - b.x)
  for (let i = 0; i < outPanels.length; i++) outPanels[i].id = `p${i + 1}`

  for (const p of outPanels) {
    p.roundIdx = roundableIndices(p, outPanels, validHoles)
  }
  recommendKnockouts(outPanels, cfg, poly)

  const coveredArea = outPanels.reduce((s, p) => s + Math.abs(polygonArea(panelContour(p))) -
    (p.cutouts ?? []).reduce((hs, h) => hs + Math.abs(polygonArea(h)), 0), 0)
  if (outPanels.length > 0 && coveredArea / inputArea < 0.5) {
    warnings.push(`覆盖率仅 ${(coveredArea / inputArea * 100).toFixed(0)}%，可能有大量边角料`)
  }

  return {
    panels: outPanels,
    warnings,
    config: cfg,
    coveredArea,
    inputArea,
    coverageRatio: coveredArea / inputArea,
  }
}
