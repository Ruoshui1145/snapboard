import type { Constraint, Point2D } from '../types/geometry'

interface AnchorableContour {
  points: Point2D[]
  constraints: Constraint[]
  originAnchorIdx?: number
}

/**
 * 找到尺寸求解时应保持不动的顶点。
 * 1. 显式引用草图原点(-3)的尺寸优先；
 * 2. 其次使用实际吸附在 (0,0) 的顶点；
 * 3. 没有基准时保持旧行为，固定顶点 0 以消除整体平移自由度。
 */
export function stableAnchorIndex(c: AnchorableContour): number {
  if (c.originAnchorIdx !== undefined && c.originAnchorIdx >= 0 && c.originAnchorIdx < c.points.length) {
    return c.originAnchorIdx
  }
  for (const cons of c.constraints) {
    if (cons.type !== 'distance') continue
    if (cons.vertexIdx1 === -3 && cons.vertexIdx2 !== undefined && cons.vertexIdx2 >= 0) return cons.vertexIdx2
    if (cons.vertexIdx2 === -3 && cons.vertexIdx1 !== undefined && cons.vertexIdx1 >= 0) return cons.vertexIdx1
  }
  const originIdx = c.points.findIndex(p => Math.hypot(p.x, p.y) <= 0.25)
  return originIdx >= 0 ? originIdx : 0
}

/** 给调用方已有的固定点集合补入稳定锚点。 */
export function withStableAnchor(c: AnchorableContour, fixed: number[]): number[] {
  return Array.from(new Set([...fixed, stableAnchorIndex(c)]))
}
