// ============ 轮廓求解状态 — 约束→求解器映射 + 状态判定 ============
// 供 useSketchTool (约束操作后刷新) 与 store (execute/undo/redo 后全量刷新) 共用。
// 判定规则 (SolidWorks 风格状态色): 冲突/冗余/无解 → over(红); 约束数≥2n−2 → fully(黑); 否则 under(蓝)。
import {
  solveSketch, p2pDistance, horizontal, vertical, parallel, perpendicular, equalLength, angle,
  type SolverConstraint,
} from './solver'
import { standaloneArc } from '../utils/entities'
import type { Constraint, Contour, SketchState } from '../types/geometry'

/** 几何约束 → planegcs 构造器 (同轮廓) */
export function geomToSolver(cons: Constraint, n: number, pixelToMM: number): SolverConstraint | null {
  // 被动(参考)尺寸不参与求解 (SolidWorks 风格: 冲突尺寸转被动后仅显示)
  if (!cons.driving) return null
    // 跨轮廓约束暂不参与单轮廓求解器 (由几何平移/参考尺寸处理)
    if (cons.contourId2) return null
  // 两点距离 (智能尺寸点两顶点): 用 vertexIdx1/2, 不依赖 edgeIndex
  if (cons.type === 'distance' && cons.vertexIdx1 !== undefined && cons.vertexIdx2 !== undefined) {
    // -2=轮廓中心，-3=固定草图原点；二者由几何平移逻辑处理，不传给点索引求解器。
    if (cons.vertexIdx1 < 0 || cons.vertexIdx2 < 0 || cons.contourId2 !== undefined) return null
    return p2pDistance(cons.vertexIdx1, cons.vertexIdx2, cons.value / pixelToMM)
  }
  // 半径: 圆/弧直接几何驱动 (与直径一致, 不经 planegcs)
  if (cons.type === 'radius') return null
  const e1 = cons.edgeIndex
  const e2 = cons.edgeIndex2
  if (e1 === undefined) return null
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
  const n = c.points.length
  return c.constraints
    .map(cons => geomToSolver(cons, n, pixelToMM))
    .filter((x): x is SolverConstraint => x !== null)
}

/** 已有约束 (不含 excludeId) → 构造器列表 */
export function existingConstraintsToSolver(c: Contour, pixelToMM: number, excludeId?: string): SolverConstraint[] {
  const n = c.points.length
  return c.constraints
    .filter(cons => cons.id !== excludeId)
    .map(cons => geomToSolver(cons, n, pixelToMM))
    .filter((x): x is SolverConstraint => x !== null)
}

/** 计算单个轮廓的求解状态 (无约束/圆直径/半径 走快速路径, 其余走 planegcs) */
export async function computeContourState(c: Contour, pixelToMM: number): Promise<SketchState> {
  const n = c.points.length
  if (!c.constraints.length) return 'under'
  // 圆: diameter/radius 约束 → 近似完全定义
  if (c.shape === 'circle') {
    return c.constraints.some(x => x.type === 'diameter' || x.type === 'radius') ? 'fully' : 'under'
  }
  // 独立圆弧: radius 约束 → 近似完全定义
  if (standaloneArc(c) !== null) {
    return c.constraints.some(x => x.type === 'radius' || x.type === 'arcLength') ? 'fully' : 'under'
  }
  const result = await solveSketch(
    c.points,
    allConstraintsToSolver(c, pixelToMM),
    { fixedIndices: [0], closed: c.closed },
  )
  if (result.conflict || result.redundant || !result.success) return 'over'
  if (c.constraints.length >= 2 * n - 2) return 'fully'
  return 'under'
}
