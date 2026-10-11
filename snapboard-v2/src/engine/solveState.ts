// ============ 轮廓求解状态 — 约束→求解器映射 + 状态判定 ============
// 供 useSketchTool (约束操作后刷新) 与 store (execute/undo/redo 后全量刷新) 共用。
// 判定规则 (SolidWorks 风格状态色): 冲突/冗余/无解 → over(红); 约束数≥2n−2 → fully(黑); 否则 under(蓝)。
import {
  solveSketch, p2pDistance, horizontal, vertical, parallel, perpendicular, equalLength, angle,
  circleRadius, circleDiameter, arcRadius, arcDiameter, arcLength,
  type SolverConstraint,
} from './solver'
import { standaloneArc } from '../utils/entities'
import type { Constraint, Contour, SketchState } from '../types/geometry'

/** 几何约束 → planegcs 构造器 (同轮廓) */
export function geomToSolver(cons: Constraint, contour: Contour, pixelToMM: number): SolverConstraint | null {
  // 被动(参考)尺寸不参与求解 (SolidWorks 风格: 冲突尺寸转被动后仅显示)
  if (!cons.driving) return null
    // 跨轮廓约束暂不参与单轮廓求解器 (由几何平移/参考尺寸处理)
    if (cons.contourId2) return null
  // 两点距离 (智能尺寸点两顶点): 用 vertexIdx1/2, 不依赖 edgeIndex
  if (cons.type === 'distance' && cons.vertexIdx1 !== undefined && cons.vertexIdx2 !== undefined) {
    // -2=轮廓中心，-3=固定草图原点；二者由几何平移逻辑处理，不传给点索引求解器。
    if (cons.vertexIdx1 < 0 || cons.vertexIdx2 < 0
      || cons.vertexIdx1 >= contour.points.length || cons.vertexIdx2 >= contour.points.length
      || cons.contourId2 !== undefined) return null
    return p2pDistance(cons.vertexIdx1, cons.vertexIdx2, cons.value / pixelToMM)
  }
  // 多段共线边的逻辑总长：edgeIndex 保留命中/高亮入口，真正驱动端点由 vertexIdx1/2 指定。
  if (cons.type === 'length' && cons.vertexIdx1 !== undefined && cons.vertexIdx2 !== undefined) {
    if (cons.vertexIdx1 < 0 || cons.vertexIdx2 < 0
      || cons.vertexIdx1 >= contour.points.length || cons.vertexIdx2 >= contour.points.length) return null
    return p2pDistance(cons.vertexIdx1, cons.vertexIdx2, cons.value / pixelToMM)
  }
  const n = contour.points.length
  const targetArc = cons.edgeIndex !== undefined
    ? contour.arcs?.find(arc => arc.p1 === cons.edgeIndex)
    : standaloneArc(contour) ?? (contour.arcs?.length === 1 ? contour.arcs[0] : undefined)
  if (cons.type === 'radius') {
    if (contour.shape === 'circle') return circleRadius(cons.value / pixelToMM)
    if (targetArc) return arcRadius(targetArc.id, cons.value / pixelToMM)
    return null
  }
  if (cons.type === 'diameter') {
    if (contour.shape === 'circle') return circleDiameter(cons.value / pixelToMM)
    if (targetArc) return arcDiameter(targetArc.id, cons.value / pixelToMM)
    return null
  }
  if (cons.type === 'arcLength') {
    if (targetArc) return arcLength(targetArc.id, cons.value / pixelToMM)
    return null
  }
  const e1 = cons.edgeIndex
  const e2 = cons.edgeIndex2
  if (e1 === undefined || e1 < 0 || e1 >= n || (!contour.closed && e1 >= n - 1)) return null
  if (contour.arcs?.some(arc => arc.p1 === e1)) return null
  if (e2 !== undefined && (e2 < 0 || e2 >= n || (!contour.closed && e2 >= n - 1)
    || contour.arcs?.some(arc => arc.p1 === e2))) return null
  const a = e1, b = (e1 + 1) % n
  switch (cons.type) {
    case 'horizontal': return horizontal(a, b)
    case 'vertical': return vertical(a, b)
    case 'parallel':
      if (e2 === undefined) return null
      return parallel(a, b, e2, (e2 + 1) % n)
    case 'perpendicular':
      if (e2 === undefined) return null
      return perpendicular(a, b, e2, (e2 + 1) % n)
    case 'equal':
      if (e2 === undefined) return null
      return equalLength(a, b, e2, (e2 + 1) % n)
    case 'length':
      return p2pDistance(a, b, cons.value / pixelToMM)
    case 'angle':
      if (e2 === undefined || cons.value === undefined) return null
      return angle(a, b, e2, (e2 + 1) % n, cons.value)
    default:
      return null
  }
}

/** 轮廓全部约束 → 构造器列表 (状态检查/重建求解用) */
export function allConstraintsToSolver(c: Contour, pixelToMM: number): SolverConstraint[] {
  return c.constraints
    .map(cons => geomToSolver(cons, c, pixelToMM))
    .filter((x): x is SolverConstraint => x !== null)
}

/** 已有约束 (不含 excludeId) → 构造器列表 */
export function existingConstraintsToSolver(c: Contour, pixelToMM: number, excludeId?: string): SolverConstraint[] {
  return c.constraints
    .filter(cons => cons.id !== excludeId)
    .map(cons => geomToSolver(cons, c, pixelToMM))
    .filter((x): x is SolverConstraint => x !== null)
}

/** 计算单个轮廓的求解状态；圆/弧与折线统一走 Planegcs。 */
export async function computeContourState(c: Contour, pixelToMM: number): Promise<SketchState> {
  const n = c.points.length
  if (!c.constraints.length) return 'under'
  const arc = standaloneArc(c)
  const result = await solveSketch(
    c.points,
    allConstraintsToSolver(c, pixelToMM),
    {
      fixedIndices: c.shape === 'circle' || arc ? [] : [0],
      closed: c.closed,
      ...(c.shape === 'circle' && c.center && c.radius ? { circle: { center: c.center, radius: c.radius } } : {}),
      ...((c.arcs?.length ?? 0) > 0 ? { arcs: c.arcs } : {}),
      // 状态颜色必须只由持久化约束决定，不能把交互期的弧半径稳定器算作自由度。
      stabilizeArcs: false,
    },
  )
  if (result.conflict || result.redundant || !result.success) return 'over'
  if (c.shape === 'circle') {
    return c.constraints.some(item => item.driving && (item.type === 'diameter' || item.type === 'radius')) ? 'fully' : 'under'
  }
  if (arc) {
    const hasRadius = c.constraints.some(item => item.driving && (item.type === 'radius' || item.type === 'diameter'))
    // arcAngle 目前只有数据类型，尚未映射 Planegcs；不能据此误报“完全定义”。
    const hasSpan = c.constraints.some(item => item.driving && item.type === 'arcLength')
    return hasRadius && hasSpan ? 'fully' : 'under'
  }
  if (result.degreesOfFreedom !== undefined) return result.degreesOfFreedom === 0 ? 'fully' : 'under'
  const activeSolverConstraintCount = allConstraintsToSolver(c, pixelToMM).length
  if (activeSolverConstraintCount >= 2 * n - 2) return 'fully'
  return 'under'
}
