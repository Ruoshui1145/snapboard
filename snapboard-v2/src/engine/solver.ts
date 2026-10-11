// ============ planegcs 约束求解器封装 (FreeCAD 引擎 WASM 版) ============
// 所有 2D 草图几何约束和尺寸驱动都通过此模块求解
//
// planegcs primitive 约定 (见 node_modules/@salusoft89/planegcs/dist/planegcs_dist/constraints.d.ts):
// - 点:  { id: 'p0', type: 'point', x, y, fixed }
// - 线:  { id: 'l0-1', type: 'line', p1_id: 'p0', p2_id: 'p1' }  ← 必须先显式声明, 约束才能引用
// - 约束字段: horizontal_l/vertical_l 用 l_id; parallel/perpendicular/equal_length 用 l1_id/l2_id
//
// ★ 并发保护: WASM GcsSystem 是单例, 多次求解共用同一底层状态 (clear_data 全局清空),
//   并行调用会互相污染。所有 solveSketch 通过模块级 Promise 队列串行执行。
import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs'
import wasm_url from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import type { ArcEntity, Point2D } from '../types/geometry'
import { arcArcIntersections, arcParameterAtPoint, lineArcIntersections } from '../utils/arc'

// ---- 单例: WASM 模块只初始化一次 ----
let _gcs: GcsWrapper | null = null
let _initPromise: Promise<GcsWrapper> | null = null

export async function getSolver(): Promise<GcsWrapper> {
  if (_gcs) return _gcs
  if (!_initPromise) {
    _initPromise = (async () => {
      const mod = await init_planegcs_module({ locateFile: () => wasm_url })
      _gcs = new GcsWrapper(new mod.GcsSystem())
      return _gcs
    })()
  }
  return _initPromise
}

// ---- 串行求解队列: 保证同一时刻只有一次 solve 在操作 WASM 单例 ----
let _solveQueue: Promise<unknown> = Promise.resolve()

// ---- 约束类型 (与 planegcs primitives 对应) ----

export interface SolverConstraint {
  type: string
  [key: string]: unknown
}

export interface SolveResult {
  success: boolean
  points: Point2D[]
  circle?: { center: Point2D; radius: number }
  arcs?: Record<string, { center: Point2D; radius: number; startAngle: number; endAngle: number }>
  message?: string
  /** 是否存在冲突约束 (过约束冲突) */
  conflict?: boolean
  /** 是否存在冗余约束 */
  redundant?: boolean
  /** 求解器报告的剩余自由度；状态判定应优先使用它，而不是简单数约束条数。 */
  degreesOfFreedom?: number
}

export interface SolveOpts {
  /** 固定点索引 (默认 [0]: 固定第一点消除平移自由度) */
  fixedIndices?: number[]
  /** 轮廓是否闭合: 决定自动生成 n 条 (闭合) 还是 n-1 条 (开放) 边线 (默认 true) */
  closed?: boolean
  /** 圆实体；points 保留旧四象限采样点，仅用于回写兼容。 */
  circle?: { center: Point2D; radius: number }
  /** 混合轮廓或独立圆弧。圆心使用编译期虚拟点，不改 Contour.points 索引。 */
  arcs?: ArcEntity[]
  /**
   * 非圆弧尺寸编辑时临时保持已有弧半径，避免点已移动而 Contour.arcs 半径未回写。
   * 状态检查会关闭它，确保临时稳定器不计入“完全定义”。默认 true。
   */
  stabilizeArcs?: boolean
}

/** 边线 id: 点 a → 点 b 组成的线 (索引自动排序保证稳定) */
export const lineId = (a: number, b: number) => `l${Math.min(a, b)}-${Math.max(a, b)}`
export const circlePrimitiveId = 'circle_0'
export const circleCenterPointId = 'circle_center_0'
export const arcPrimitiveId = (arcId: string) => `arc_${arcId}`
export const arcCenterPointId = (arcId: string) => `arc_center_${arcId}`

const directedArcAngles = (arc: ArcEntity, points: Point2D[]): [number, number] => {
  const start = points[arc.p1]
  const end = points[arc.p2]
  let a0 = Math.atan2(start.y - arc.center.y, start.x - arc.center.x)
  let a1 = Math.atan2(end.y - arc.center.y, end.x - arc.center.x)
  if (arc.sweep === 'ccw') {
    while (a1 <= a0) a1 += Math.PI * 2
  } else {
    while (a1 >= a0) a1 -= Math.PI * 2
  }
  return [a0, a1]
}

interface SolvedArcGeometry {
  source: ArcEntity
  center: Point2D
  radius: number
}

const pointNear = (a: Point2D, b: Point2D, tolerance = 0.2) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= tolerance

/** 两条有限直线是否在允许的公共拓扑端点之外相交/重叠。 */
function linePairConflicts(
  a1: Point2D,
  b1: Point2D,
  a2: Point2D,
  b2: Point2D,
  allowedTouches: Point2D[],
): boolean {
  const d1x = b1.x - a1.x, d1y = b1.y - a1.y
  const d2x = b2.x - a2.x, d2y = b2.y - a2.y
  const den = d1x * d2y - d1y * d2x
  const cross = (a2.x - a1.x) * d1y - (a2.y - a1.y) * d1x
  if (Math.abs(den) <= 1e-9) {
    if (Math.abs(cross) > 1e-7) return false
    const useX = Math.abs(d1x) >= Math.abs(d1y)
    const values1 = useX ? [a1.x, b1.x] : [a1.y, b1.y]
    const values2 = useX ? [a2.x, b2.x] : [a2.y, b2.y]
    const lo = Math.max(Math.min(...values1), Math.min(...values2))
    const hi = Math.min(Math.max(...values1), Math.max(...values2))
    if (hi < lo - 1e-7) return false
    if (hi - lo > 0.2) return true
    const point = useX
      ? { x: (lo + hi) / 2, y: Math.abs(d1x) > 1e-9 ? a1.y + (((lo + hi) / 2 - a1.x) / d1x) * d1y : a1.y }
      : { x: Math.abs(d1y) > 1e-9 ? a1.x + (((lo + hi) / 2 - a1.y) / d1y) * d1x : a1.x, y: (lo + hi) / 2 }
    return !allowedTouches.some(allowed => pointNear(point, allowed))
  }
  const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / den
  const u = ((a2.x - a1.x) * d1y - (a2.y - a1.y) * d1x) / den
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return false
  const point = { x: a1.x + t * d1x, y: a1.y + t * d1y }
  return !allowedTouches.some(allowed => pointNear(point, allowed))
}

/**
 * 求解后按拓扑边逐对精确求交，检查直线和圆弧构成的边界是否合法。
 * 圆弧与直线、圆弧与圆弧的相交也参与检查。
 */
function isValidSolvedGeometry(
  points: Point2D[],
  closed: boolean,
  arcs: SolvedArcGeometry[],
): boolean {
  const n = points.length
  if (n < 2 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false
  const edgeCount = closed && n > 2 ? n : n - 1
  const arcByEdge = new Map<number, SolvedArcGeometry>()
  for (const arc of arcs) {
    const expectedEnd = (arc.source.p1 + 1) % n
    if (arc.source.p1 < 0 || arc.source.p1 >= edgeCount || arc.source.p2 !== expectedEnd || arcByEdge.has(arc.source.p1)) {
      return false
    }
    const start = points[arc.source.p1]
    const end = points[arc.source.p2]
    const startRadius = Math.hypot(start.x - arc.center.x, start.y - arc.center.y)
    const endRadius = Math.hypot(end.x - arc.center.x, end.y - arc.center.y)
    const radiusTolerance = Math.max(0.25, arc.radius * 1e-3)
    if (!Number.isFinite(arc.radius) || arc.radius <= 1e-6
      || Math.abs(startRadius - arc.radius) > radiusTolerance
      || Math.abs(endRadius - arc.radius) > radiusTolerance) return false
    arcByEdge.set(arc.source.p1, arc)
  }

  for (let edge = 0; edge < edgeCount; edge++) {
    if (arcByEdge.has(edge)) continue
    if (Math.hypot(
      points[(edge + 1) % n].x - points[edge].x,
      points[(edge + 1) % n].y - points[edge].y,
    ) < 1) return false
  }

  const endpoints = (edge: number) => [edge, (edge + 1) % n]
  for (let first = 0; first < edgeCount; first++) {
    for (let second = first + 1; second < edgeCount; second++) {
      const shared = endpoints(first)
        .filter(index => endpoints(second).includes(index))
        .map(index => points[index])
      if (!closed && first === 0 && second === edgeCount - 1 && pointNear(points[0], points[n - 1])) {
        shared.push(points[0])
      }
      const firstArc = arcByEdge.get(first)
      const secondArc = arcByEdge.get(second)
      let intersections: Point2D[] = []
      if (!firstArc && !secondArc) {
        if (linePairConflicts(
          points[first], points[(first + 1) % n],
          points[second], points[(second + 1) % n],
          shared,
        )) return false
        continue
      }
      if (firstArc && secondArc) {
        const sameCircle = pointNear(firstArc.center, secondArc.center, 1e-5)
          && Math.abs(firstArc.radius - secondArc.radius) <= 1e-5
        if (sameCircle) {
          const candidates = [
            points[firstArc.source.p1], points[firstArc.source.p2],
            points[secondArc.source.p1], points[secondArc.source.p2],
          ]
          for (const candidate of candidates) {
            const onFirst = arcParameterAtPoint(candidate, firstArc.center,
              points[firstArc.source.p1], points[firstArc.source.p2], firstArc.source.sweep)
            const onSecond = arcParameterAtPoint(candidate, secondArc.center,
              points[secondArc.source.p1], points[secondArc.source.p2], secondArc.source.sweep)
            if (onFirst !== null && onSecond !== null && !shared.some(point => pointNear(point, candidate))) return false
          }
          continue
        }
        intersections = arcArcIntersections(
          firstArc.center, firstArc.radius,
          points[firstArc.source.p1], points[firstArc.source.p2], firstArc.source.sweep,
          secondArc.center, secondArc.radius,
          points[secondArc.source.p1], points[secondArc.source.p2], secondArc.source.sweep,
        )
      } else {
        const arc = firstArc ?? secondArc!
        const lineEdge = firstArc ? second : first
        intersections = lineArcIntersections(
          points[lineEdge], points[(lineEdge + 1) % n],
          arc.center, arc.radius,
          points[arc.source.p1], points[arc.source.p2], arc.source.sweep,
        )
      }
      if (intersections.some(point => !shared.some(allowed => pointNear(point, allowed)))) return false
    }
  }
  return true
}

const numericField = (constraint: SolverConstraint, key: string): number | null =>
  typeof constraint[key] === 'number' && Number.isFinite(constraint[key])
    ? constraint[key] as number
    : null

const pointIndexFromId = (value: unknown): number | null => {
  const match = typeof value === 'string' ? /^p(\d+)$/.exec(value) : null
  return match ? Number(match[1]) : null
}

const lineIndicesFromId = (value: unknown): [number, number] | null => {
  const match = typeof value === 'string' ? /^l(\d+)-(\d+)$/.exec(value) : null
  return match ? [Number(match[1]), Number(match[2])] : null
}

/**
 * PlaneGCS 某些“所有相关参数均 fixed”的矛盾尺寸不会上报 conflict，只会保留旧值。
 * 提交几何前复核主要数值约束，避免界面把未生效尺寸写入工程。
 */
function firstUnsatisfiedConstraint(
  constraints: SolverConstraint[],
  points: Point2D[],
  circle: SolveResult['circle'],
  arcs: NonNullable<SolveResult['arcs']>,
): string | null {
  const distanceTolerance = (target: number) => Math.max(0.2, Math.abs(target) * 1e-4)
  const point = (id: unknown) => {
    const index = pointIndexFromId(id)
    return index === null ? null : points[index] ?? null
  }
  const line = (id: unknown) => {
    const indices = lineIndicesFromId(id)
    return indices ? [points[indices[0]], points[indices[1]]] as const : null
  }
  const arc = (id: unknown) => Object.entries(arcs)
    .find(([arcId]) => arcPrimitiveId(arcId) === id)?.[1] ?? null

  for (const constraint of constraints) {
    let satisfied = true
    if (constraint.type === 'p2p_distance') {
      const a = point(constraint.p1_id), b = point(constraint.p2_id)
      const target = numericField(constraint, 'distance')
      if (a && b && target !== null) satisfied = Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - target) <= distanceTolerance(target)
    } else if (constraint.type === 'p2p_coincident') {
      const a = point(constraint.p1_id), b = point(constraint.p2_id)
      if (a && b) satisfied = pointNear(a, b)
    } else if (constraint.type === 'horizontal_l' || constraint.type === 'vertical_l') {
      const segment = line(constraint.l_id)
      if (segment) satisfied = constraint.type === 'horizontal_l'
        ? Math.abs(segment[1].y - segment[0].y) <= 0.2
        : Math.abs(segment[1].x - segment[0].x) <= 0.2
    } else if (constraint.type === 'parallel' || constraint.type === 'perpendicular_ll' || constraint.type === 'equal_length') {
      const first = line(constraint.l1_id), second = line(constraint.l2_id)
      if (first && second) {
        const v1 = { x: first[1].x - first[0].x, y: first[1].y - first[0].y }
        const v2 = { x: second[1].x - second[0].x, y: second[1].y - second[0].y }
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y)
        if (l1 <= 1e-9 || l2 <= 1e-9) satisfied = false
        else if (constraint.type === 'parallel') satisfied = Math.abs(v1.x * v2.y - v1.y * v2.x) / (l1 * l2) <= 1e-3
        else if (constraint.type === 'perpendicular_ll') satisfied = Math.abs(v1.x * v2.x + v1.y * v2.y) / (l1 * l2) <= 1e-3
        else satisfied = Math.abs(l1 - l2) <= distanceTolerance(Math.max(l1, l2))
      }
    } else if (constraint.type === 'l2l_angle_ll') {
      const first = line(constraint.l1_id), second = line(constraint.l2_id)
      const target = numericField(constraint, 'angle')
      if (first && second && target !== null) {
        const v1 = { x: first[1].x - first[0].x, y: first[1].y - first[0].y }
        const v2 = { x: second[1].x - second[0].x, y: second[1].y - second[0].y }
        const denominator = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)
        const actual = denominator <= 1e-9 ? Number.NaN : Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / denominator)))
        satisfied = Number.isFinite(actual) && Math.abs(actual - Math.abs(target)) <= Math.PI / 1800
      }
    } else if (constraint.type === 'circle_radius' || constraint.type === 'circle_diameter') {
      const target = numericField(constraint, constraint.type === 'circle_radius' ? 'radius' : 'diameter')
      if (circle && target !== null) {
        const actual = constraint.type === 'circle_radius' ? circle.radius : circle.radius * 2
        satisfied = Math.abs(actual - target) <= distanceTolerance(target)
      }
    } else if (constraint.type === 'arc_radius' || constraint.type === 'arc_diameter' || constraint.type === 'arc_length') {
      const solvedArc = arc(constraint.a_id)
      const field = constraint.type === 'arc_radius' ? 'radius' : constraint.type === 'arc_diameter' ? 'diameter' : 'dist'
      const target = numericField(constraint, field)
      if (solvedArc && target !== null) {
        const actual = constraint.type === 'arc_radius'
          ? solvedArc.radius
          : constraint.type === 'arc_diameter'
            ? solvedArc.radius * 2
            : solvedArc.radius * Math.abs(solvedArc.endAngle - solvedArc.startAngle)
        satisfied = Math.abs(actual - target) <= distanceTolerance(target)
      }
    }
    if (!satisfied) return String(constraint.id ?? constraint.type)
  }
  return null
}



/**
 * 求解 2D 草图约束系统 (串行队列保护, 见文件头说明)
 *
 * 自动构建: 所有点 + 轮廓边线 (line) + 约束 primitives
 *
 * @param points 顶点初始位置 (px)
 * @param constraints 约束列表 (planegcs primitives)
 * @param opts 求解选项
 * @returns 求解后的顶点位置
 */
export function solveSketch(
  points: Point2D[],
  constraints: SolverConstraint[],
  opts?: SolveOpts,
): Promise<SolveResult> {
  const run = async (): Promise<SolveResult> => {
    try {
      const gcs = await getSolver()
      const fixed = opts?.fixedIndices ?? [0]
      const closed = opts?.closed ?? true
      const n = points.length
      const circle = opts?.circle
      const arcs = opts?.arcs ?? []
      const curvedEdges = new Set(arcs.map(arc => arc.p1))
      const edgeCount = circle ? 0 : closed && n > 2 ? n : Math.max(0, n - 1)
      const arcTopologyValid = arcs.every((arc, index) =>
        Number.isInteger(arc.p1)
        && Number.isInteger(arc.p2)
        && arc.p1 >= 0
        && arc.p1 < edgeCount
        && arc.p2 === (arc.p1 + 1) % n
        && arcs.findIndex(other => other.p1 === arc.p1) === index)
      if (!arcTopologyValid) {
        return { success: false, points, message: 'invalid or ambiguous arc topology' }
      }
      const topologyLineIds = new Set(Array.from({ length: edgeCount }, (_, edge) => edge)
        .filter(edge => !curvedEdges.has(edge))
        .map(edge => lineId(edge, (edge + 1) % n)))
      const arcCenterCanMove = (arcId: string) => {
        const primitiveId = arcPrimitiveId(arcId)
        return constraints.some(constraint =>
          constraint.type === 'tangent_la'
            ? constraint.a_id === primitiveId && topologyLineIds.has(String(constraint.l_id))
            : constraint.type === 'tangent_ca'
              ? constraint.a_id === primitiveId
            : constraint.type === 'tangent_aa'
              && (constraint.a1_id === primitiveId || constraint.a2_id === primitiveId))
      }

      // 重要: 单例 GcsSystem 的 push 会去重累积 (push_point 有 id 判重),
      // 每次求解前必须清空, 否则旧点/约束残留导致结果错误
      gcs.clear_data()

      // 提高迭代次数: 默认 100 次对 equal_length 等非线性约束收敛不足 (实测需要 ~2000)
      gcs.set_max_iterations(2000)

      // 构建 primitives: 点 + 边线 + 约束
      const primitives: Array<Record<string, unknown>> = []
      for (let i = 0; i < n; i++) {
        primitives.push({
          id: `p${i}`,
          type: 'point',
          x: points[i].x,
          y: points[i].y,
          fixed: fixed.includes(i),
        })
      }
      if (circle) {
        primitives.push({
          id: circleCenterPointId,
          type: 'point',
          x: circle.center.x,
          y: circle.center.y,
          fixed: true,
        })
        primitives.push({
          id: circlePrimitiveId,
          type: 'circle',
          c_id: circleCenterPointId,
          radius: circle.radius,
        })
      }
      for (const arc of arcs) {
        const [startAngle, endAngle] = directedArcAngles(arc, points)
        primitives.push({
          id: arcCenterPointId(arc.id),
          type: 'point',
          x: arc.center.x,
          y: arc.center.y,
          // 普通点距/边长编辑不会回写虚拟圆心，因此默认必须固定。只有本次求解
          // 明确带有引用该弧的相切约束时才允许移动（圆角改半径的语义）。
          fixed: !arcCenterCanMove(arc.id),
        })
        primitives.push({
          id: arcPrimitiveId(arc.id),
          type: 'arc',
          c_id: arcCenterPointId(arc.id),
          start_id: `p${arc.p1}`,
          end_id: `p${arc.p2}`,
          start_angle: startAngle,
          end_angle: endAngle,
          radius: arc.radius,
        })
      }
      // 闭合 n=2 (槽口胶囊两点定中心线) 只生成 1 条边:
      // 否则 i=0→j=1 与 i=1→j=0 生成同 id 线 primitive (lineId 排序后均为 l0-1), 导致重复
      for (let i = 0; i < edgeCount; i++) {
        if (curvedEdges.has(i)) continue
        const j = (i + 1) % n
        // planegcs 要求: 线的 p1_id 必须低于 p2_id
        primitives.push({
          id: lineId(i, j), type: 'line',
          p1_id: `p${Math.min(i, j)}`, p2_id: `p${Math.max(i, j)}`,
        })
      }
      // arc_rules 把圆弧参数与起终点绑定；没有它，角度/半径和端点是两组无关变量。
      for (const arc of arcs) {
        primitives.push({ id: `arc_rules_${arc.id}`, type: 'arc_rules', a_id: arcPrimitiveId(arc.id) })
      }
        // 过滤引用不存在边线的约束（开放轮廓被误当成闭合轮廓时传入的“最后一条闭合边”约束）
        const validLineIds = new Set(primitives.filter(p => p.type === 'line').map(p => String(p.id)))
        const validConstraints = constraints.filter(c => {
          const l = c.l_id as string | undefined
          const l1 = c.l1_id as string | undefined
          const l2 = c.l2_id as string | undefined
          if (l !== undefined && !validLineIds.has(l)) return false
          if (l1 !== undefined && !validLineIds.has(l1)) return false
          if (l2 !== undefined && !validLineIds.has(l2)) return false
          return true
        })
        // 自动锁正交：对当前几何中接近水平/垂直的边，补充 H/V 约束。
        // 这样即使调用方没有显式加 H/V，L 形开放折线等正交轮廓也不会被拉成梯形。
        const autoOrtho: SolverConstraint[] = []
        for (let i = 0; i < edgeCount; i++) {
          if (curvedEdges.has(i)) continue
          const j = (i + 1) % n
          const a = points[i], b = points[j]
          const dx = Math.abs(b.x - a.x)
          const dy = Math.abs(b.y - a.y)
          const maxAxis = Math.max(dx, dy)
          const minAxis = Math.min(dx, dy)
          // 只继承已经精确水平/垂直的边，不能把约8.5°以内的斜线猜成正交边。
          if (maxAxis < 1e-6 || minAxis > 1e-7) continue
          const isH = dx >= dy
          const type = isH ? 'horizontal_l' : 'vertical_l'
          const id = isH ? `h_${i}_${j}` : `v_${i}_${j}`
          const lid = lineId(i, j)
          const duplicated = validConstraints.some(c =>
            (c.type === type && c.l_id === lid) || c.id === id)
          if (!duplicated) autoOrtho.push({ type, id, l_id: lid })
        }
        primitives.push(...autoOrtho as Array<Record<string, unknown>>)
        // 点距、边长和角度编辑只回写 Contour.points，不会回写 arcs。若让弧半径
        // 随欠约束求解漂移，就会得到“端点已变、弧参数仍旧”的损坏工程。除非调用方
        // 明确提供半径/直径驱动，否则用临时约束保持当前半径；状态检查可关闭它。
        if (opts?.stabilizeArcs !== false) {
          for (const arc of arcs) {
            const primitiveId = arcPrimitiveId(arc.id)
            const hasRadialDrive = validConstraints.some(constraint =>
              (constraint.type === 'arc_radius' || constraint.type === 'arc_diameter')
              && constraint.a_id === primitiveId)
            if (!hasRadialDrive) {
              primitives.push({
                ...arcRadius(arc.id, arc.radius),
                id: `stabilize_arc_radius_${arc.id}`,
                temporary: true,
              })
            }
          }
        }
      primitives.push(...validConstraints as Array<Record<string, unknown>>)

      gcs.push_primitives_and_params(primitives as never)
      gcs.solve()
      gcs.apply_solution()

      const solved = gcs.sketch_index.get_primitives() as Array<{
        id: string
        type: string
        x?: number
        y?: number
        radius?: number
        start_angle?: number
        end_angle?: number
      }>

      // 保留求解器双精度；显示格式化不能反向改变几何或固定点。
      let rawResult = points.map((_, i) => {
        const p = solved.find(s => s.id === `p${i}`)
        const rx = p?.x ?? points[i].x
        const ry = p?.y ?? points[i].y
        return { x: rx, y: ry }
      })
      let solvedCircle: SolveResult['circle']
      if (circle) {
        const centerPrimitive = solved.find(item => item.id === circleCenterPointId)
        const circlePrimitive = solved.find(item => item.id === circlePrimitiveId)
        const center = {
          x: centerPrimitive?.x ?? circle.center.x,
          y: centerPrimitive?.y ?? circle.center.y,
        }
        const radius = Math.abs(circlePrimitive?.radius ?? circle.radius)
        solvedCircle = { center, radius }
        rawResult = points.map((point, index) => {
          const angle = Math.hypot(point.x - circle.center.x, point.y - circle.center.y) > 1e-6
            ? Math.atan2(point.y - circle.center.y, point.x - circle.center.x)
            : index * Math.PI / 2
          return {
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
          }
        })
      }
      const solvedArcs: NonNullable<SolveResult['arcs']> = {}
      for (const arc of arcs) {
        const centerPrimitive = solved.find(item => item.id === arcCenterPointId(arc.id))
        const arcPrimitive = solved.find(item => item.id === arcPrimitiveId(arc.id))
        solvedArcs[arc.id] = {
          center: {
            x: centerPrimitive?.x ?? arc.center.x,
            y: centerPrimitive?.y ?? arc.center.y,
          },
          radius: Math.abs(arcPrimitive?.radius ?? arc.radius),
          startAngle: arcPrimitive?.start_angle ?? directedArcAngles(arc, points)[0],
          endAngle: arcPrimitive?.end_angle ?? directedArcAngles(arc, points)[1],
        }
      }
      const result = rawResult
      const hasInvalidSolvedArc = Object.values(solvedArcs).some(arc => {
        const span = Math.abs(arc.endAngle - arc.startAngle)
        return arc.radius <= 1e-6 || span <= 1e-6 || span >= Math.PI * 2 - 1e-6
      })
      const solvedArcGeometry: SolvedArcGeometry[] = arcs.map(arc => ({
        source: arc,
        center: solvedArcs[arc.id]?.center ?? arc.center,
        radius: solvedArcs[arc.id]?.radius ?? arc.radius,
      }))
      const solverConflict = gcs.has_gcs_conflicting_constraints()
      const solverRedundant = gcs.has_gcs_redundant_constraints()
      const unsatisfiedConstraint = firstUnsatisfiedConstraint(
        validConstraints,
        result,
        solvedCircle,
        solvedArcs,
      )

        if ((solvedCircle && (!Number.isFinite(solvedCircle.radius) || solvedCircle.radius <= 1e-6
            || !Number.isFinite(solvedCircle.center.x) || !Number.isFinite(solvedCircle.center.y)))
          || hasInvalidSolvedArc
          || (!solvedCircle && !isValidSolvedGeometry(result, closed, solvedArcGeometry))) {
          return {
            success: false,
            points,
            message: 'solved geometry is degenerate, exceeds a single arc turn, or self-intersecting',
          }
        }
      if (solverConflict || unsatisfiedConstraint) {
        return {
          success: false,
          points,
          message: unsatisfiedConstraint
            ? `solver did not satisfy constraint ${unsatisfiedConstraint}`
            : 'constraints conflict',
          conflict: true,
          redundant: solverRedundant,
          degreesOfFreedom: Math.max(0, gcs.gcs.dof()),
        }
      }
      return {
        success: true,
        points: result,
        ...(solvedCircle ? { circle: solvedCircle } : {}),
        ...(arcs.length ? { arcs: solvedArcs } : {}),
        conflict: false,
        redundant: solverRedundant,
        degreesOfFreedom: Math.max(0, gcs.gcs.dof()),
      }
    } catch (err) {
      console.error('Solver failed:', err)
      return { success: false, points, message: String(err) }
    }
  }

  // 串行队列: 上一次求解 (无论成败) 完成后再执行本次
  const p = _solveQueue.then(run, run)
  _solveQueue = p.then(() => undefined, () => undefined)
  return p
}

// ---- 常用约束构造器 (均基于点索引, 引用 solver 自动生成的边线) ----

/** 水平约束 */
export const horizontal = (a: number, b: number) => ({ type: 'horizontal_l', id: `h_${a}_${b}`, l_id: lineId(a, b) })

/** 垂直约束 */
export const vertical = (a: number, b: number) => ({ type: 'vertical_l', id: `v_${a}_${b}`, l_id: lineId(a, b) })

/** 两点距离 (尺寸驱动) */
export const p2pDistance = (p1: number, p2: number, dist: number) => ({
  type: 'p2p_distance',
  id: `d_${p1}_${p2}`,
  p1_id: `p${p1}`,
  p2_id: `p${p2}`,
  distance: dist,
})

/** 共线/重合 */
export const coincident = (p1: number, p2: number) => ({
  type: 'p2p_coincident',
  id: `c_${p1}_${p2}`,
  p1_id: `p${p1}`,
  p2_id: `p${p2}`,
})

/** 平行 */
export const parallel = (a1: number, b1: number, a2: number, b2: number) => ({
  type: 'parallel',
  id: `par_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
})

/** 垂直 */
export const perpendicular = (a1: number, b1: number, a2: number, b2: number) => ({
  type: 'perpendicular_ll',
  id: `perp_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
})

/** 相等长度 */
export const equalLength = (a1: number, b1: number, a2: number, b2: number) => ({
  type: 'equal_length',
  id: `eq_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
})

/** 角度 (度数) */
export const angle = (a1: number, b1: number, a2: number, b2: number, deg: number) => ({
  type: 'l2l_angle_ll',
  id: `ang_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
  angle: (deg * Math.PI) / 180,
})

/** 圆/弧尺寸约束；id 与 build primitives 的稳定命名保持一致。 */
export const circleRadius = (radius: number) => ({
  type: 'circle_radius', id: 'circle_radius_0', c_id: circlePrimitiveId, radius,
})

export const circleDiameter = (diameter: number) => ({
  type: 'circle_diameter', id: 'circle_diameter_0', c_id: circlePrimitiveId, diameter,
})

export const arcRadius = (arcId: string, radius: number) => ({
  type: 'arc_radius', id: `arc_radius_${arcId}`, a_id: arcPrimitiveId(arcId), radius,
})

export const arcDiameter = (arcId: string, diameter: number) => ({
  type: 'arc_diameter', id: `arc_diameter_${arcId}`, a_id: arcPrimitiveId(arcId), diameter,
})

export const arcLength = (arcId: string, dist: number) => ({
  type: 'arc_length', id: `arc_length_${arcId}`, a_id: arcPrimitiveId(arcId), dist,
})

/** 直线与圆弧相切；两者共享端点时会形成稳定圆角。 */
export const tangentLineArc = (lineA: number, lineB: number, arcId: string) => ({
  type: 'tangent_la',
  id: `tangent_${lineId(lineA, lineB)}_${arcPrimitiveId(arcId)}`,
  l_id: lineId(lineA, lineB),
  a_id: arcPrimitiveId(arcId),
  temporary: true,
})
