import type { ArcEntity, Contour, Point2D } from '../types/geometry'

const PARAM_EPS = 1e-6
const TAU = Math.PI * 2

export interface MixedArcTrimRange {
  t1: number
  t2: number
}

/**
 * 一条修剪后仍然存在的开放拓扑组件。
 *
 * oldVertexMap 只记录原轮廓顶点；修剪产生的新圆弧端点没有旧索引。命令层可用它
 * 重映射仍有效的顶点约束，引用被删除弧边的尺寸应由命令层显式丢弃。
 */
export interface MixedArcTrimComponent {
  points: Point2D[]
  closed: false
  arcs: ArcEntity[]
  oldVertexMap: Map<number, number>
  originAnchorIdx?: number
}

/**
 * 闭合混合轮廓圆弧修剪计划。
 *
 * before 是完整深拷贝，可由命令层直接作为撤销快照；components 是删除区间后的
 * 真实开放边界。组件不会以 cutEnd -> cutStart 的隐式直线重新闭合。
 */
export interface ClosedMixedArcTrimPlan {
  before: Contour
  removedArc: ArcEntity
  range: MixedArcTrimRange
  components: [MixedArcTrimComponent]
}

function cloneArc(arc: ArcEntity): ArcEntity {
  return { ...arc, center: { ...arc.center } }
}

function cloneContour(contour: Contour): Contour {
  return {
    ...contour,
    source: contour.source
      ? { ...contour.source, params: contour.source.params ? { ...contour.source.params } : undefined }
      : undefined,
    points: contour.points.map(point => ({ ...point })),
    center: contour.center ? { ...contour.center } : undefined,
    slotParams: contour.slotParams ? { ...contour.slotParams } : undefined,
    arcs: contour.arcs?.map(cloneArc),
    constraints: contour.constraints.map(constraint => ({
      ...constraint,
      labelPos: { ...constraint.labelPos },
    })),
  }
}

function finitePoint(point: Point2D | undefined): point is Point2D {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
}

function normAngle(angle: number): number {
  const normalized = angle % TAU
  return normalized < 0 ? normalized + TAU : normalized
}

/** 与 arc.ts 相同的 y 向下有向圆弧参数约定，保留在纯拓扑模块内以避免运行时耦合。 */
function pointOnArcParameter(
  arc: ArcEntity,
  start: Point2D,
  end: Point2D,
  parameter: number,
): Point2D {
  const startAngle = Math.atan2(start.y - arc.center.y, start.x - arc.center.x)
  const endAngle = Math.atan2(end.y - arc.center.y, end.x - arc.center.x)
  const rawDelta = normAngle(endAngle - startAngle)
  const span = rawDelta <= PARAM_EPS
    ? TAU
    : arc.sweep === 'cw' ? normAngle(startAngle - endAngle) : rawDelta
  const t = Math.max(0, Math.min(1, parameter))
  const angle = arc.sweep === 'cw' ? startAngle - span * t : startAngle + span * t
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  }
}

function normalizeRange(input: MixedArcTrimRange): MixedArcTrimRange | null {
  if (!Number.isFinite(input.t1) || !Number.isFinite(input.t2)) return null
  const t1 = Math.max(0, Math.min(1, Math.min(input.t1, input.t2)))
  const t2 = Math.max(0, Math.min(1, Math.max(input.t1, input.t2)))
  return t2 - t1 > PARAM_EPS ? { t1, t2 } : null
}

/** 为同一源弧拆出的第二条余弧生成确定且不冲突的 id。 */
function residualArcId(sourceId: string, existingIds: Set<string>): string {
  const base = `${sourceId}::trim-tail`
  if (!existingIds.has(base)) return base
  let suffix = 2
  while (existingIds.has(`${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
}

/**
 * 删除闭合混合轮廓上一条圆弧的全部或部分参数区间。
 *
 * 轮廓原顺序为 target.p1 --(圆弧)--> target.p2 --(其余边)--> target.p1。
 * 修剪后统一旋转成开放链：
 *
 *   cutAfter -> target.p2 -> ... -> target.p1 -> cutBefore
 *
 * 其中首尾余弧仅在相应区间非空时存在。因为结果 closed=false，首尾切口之间不会
 * 被轮廓语义补成直弦。
 */
export function planClosedMixedArcTrim(
  contour: Contour,
  arcId: string,
  input: MixedArcTrimRange = { t1: 0, t2: 1 },
): ClosedMixedArcTrimPlan | null {
  const n = contour.points.length
  if (!contour.closed || contour.shape !== undefined || contour.slotWidth !== undefined || n < 3) return null
  const target = contour.arcs?.find(arc => arc.id === arcId)
  if (!target || target.p1 < 0 || target.p1 >= n || target.p2 !== (target.p1 + 1) % n) return null
  if (!finitePoint(target.center) || !Number.isFinite(target.radius) || target.radius <= PARAM_EPS) return null
  const start = contour.points[target.p1]
  const end = contour.points[target.p2]
  if (!finitePoint(start) || !finitePoint(end)) return null
  const range = normalizeRange(input)
  if (!range) return null

  // 删除目标弧后，沿剩余环从弧终点走到弧起点。这一序列包含所有原顶点一次。
  const backboneIndices: number[] = []
  let cursor = target.p2
  for (let count = 0; count < n; count++) {
    backboneIndices.push(cursor)
    if (cursor === target.p1) break
    cursor = (cursor + 1) % n
  }
  if (backboneIndices.length !== n || backboneIndices[backboneIndices.length - 1] !== target.p1) return null

  const keepHead = range.t1 > PARAM_EPS
  const keepTail = range.t2 < 1 - PARAM_EPS
  const points: Point2D[] = []
  if (keepTail) {
    points.push(pointOnArcParameter(target, start, end, range.t2))
  }

  const oldVertexMap = new Map<number, number>()
  for (const oldIndex of backboneIndices) {
    oldVertexMap.set(oldIndex, points.length)
    points.push({ ...contour.points[oldIndex] })
  }

  if (keepHead) {
    points.push(pointOnArcParameter(target, start, end, range.t1))
  }

  const arcs: ArcEntity[] = []
  // 其余圆弧位于 backbone 上，必须仍然映射为开放链中的相邻边；否则拒绝产生损坏拓扑。
  for (const arc of contour.arcs ?? []) {
    if (arc.id === target.id) continue
    const p1 = oldVertexMap.get(arc.p1)
    const p2 = oldVertexMap.get(arc.p2)
    if (p1 === undefined || p2 === undefined || p2 !== p1 + 1) return null
    arcs.push({ ...cloneArc(arc), p1, p2 })
  }

  const existingIds = new Set((contour.arcs ?? []).map(arc => arc.id))
  if (keepTail) {
    // 只有尾余弧时沿用源 id；两侧都保留时，头余弧沿用源 id，尾余弧使用派生 id。
    const id = keepHead ? residualArcId(target.id, existingIds) : target.id
    arcs.push({ ...cloneArc(target), id, p1: 0, p2: oldVertexMap.get(target.p2)! })
  }
  if (keepHead) {
    arcs.push({
      ...cloneArc(target),
      id: target.id,
      p1: oldVertexMap.get(target.p1)!,
      p2: points.length - 1,
    })
  }

  const originAnchorIdx = contour.originAnchorIdx === undefined
    ? undefined
    : oldVertexMap.get(contour.originAnchorIdx)

  return {
    before: cloneContour(contour),
    removedArc: cloneArc(target),
    range,
    components: [{ points, closed: false, arcs, oldVertexMap, originAnchorIdx }],
  }
}
