// ============ 轮廓实体几何工具 (纯 TS, 无 DOM 依赖) ============
// 轮廓边 = 直线段 (缺省) 或圆弧实体 (Contour.arcs)。
// 供 useSketchTool (命中/拖动) 与 SketchViewport2D (渲染/预览) 共用。
import type { ArcEntity, Contour, Point2D } from '../types/geometry'
import { arcDistance, arcMidAngle, arcPointAt } from './arc'

/** 边 i 上的圆弧实体 (i → (i+1)%n); 无则 undefined */
export function edgeArc(c: Contour, i: number): ArcEntity | undefined {
  if (!c.arcs) return undefined
  const n = c.points.length
  const j = (i + 1) % n
  return c.arcs.find(a => a.p1 === i && a.p2 === j)
}

/** 独立圆弧轮廓: 2 点开放 + 恰 1 个弧实体 → 返回该弧; 否则 null */
export function standaloneArc(c: Contour): ArcEntity | null {
  if (c.closed || c.points.length !== 2) return null
  if (c.shape === 'circle' || c.slotWidth !== undefined) return null
  if (!c.arcs || c.arcs.length !== 1) return null
  return c.arcs[0]
}

/** 轮廓边数 (闭合 n>2 → n 条; 否则 n-1 条) */
export function edgeCount(c: Contour): number {
  const n = c.points.length
  if (n < 2) return 0
  return c.closed && n > 2 ? n : n - 1
}

/** 点到线段距离 */
export function ptSegDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** 点到边 i 的距离 (弧边走圆弧距离, 直线边走点线距) */
export function distToEdge(pos: Point2D, c: Contour, i: number): number {
  const n = c.points.length
  const j = (i + 1) % n
  const a = c.points[i], b = c.points[j]
  const arc = edgeArc(c, i)
  if (arc) return arcDistance(pos, arc.center, arc.radius, a, b, arc.sweep)
  return ptSegDist(pos, a, b)
}

/** 边 i 的中点 (弧边取角跨度中点处的点) */
export function edgeMid(c: Contour, i: number): Point2D {
  const n = c.points.length
  const j = (i + 1) % n
  const a = c.points[i], b = c.points[j]
  const arc = edgeArc(c, i)
  if (arc) {
    const midA = arcMidAngle(arc.center, a, b, arc.sweep)
    return arcPointAt(arc.center, arc.radius, midA)
  }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 边的几何中心 (弧 = 圆心, 线 = 中点); 用于标注定位 */
export function edgeAnchor(c: Contour, i: number): Point2D {
  const arc = edgeArc(c, i)
  if (arc) return { ...arc.center }
  return edgeMid(c, i)
}

/**
 * 修剪/重排点序后弧实体索引重映射。
 * remapIdx 返回 undefined 表示该端点在修剪中被移除 → 返回 undefined (弧实体丢弃)。
 */
export function remapArcEntity(arc: ArcEntity, remapIdx: (oldIdx: number) => number | undefined): ArcEntity | undefined {
  const p1 = remapIdx(arc.p1)
  const p2 = remapIdx(arc.p2)
  if (p1 === undefined || p2 === undefined) return undefined
  return { ...arc, p1, p2 }
}

/** 重新拟合弧: 保持通过两端点 (端点在 points 中), 圆心保持在原侧, 半径取原值与弦半长较大者 */
export function refitArcToEndpoints(arc: ArcEntity, points: Point2D[]): ArcEntity {
  const A = points[arc.p1], B = points[arc.p2]
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2
  const dx = B.x - A.x, dy = B.y - A.y
  const chordHalf = Math.hypot(dx, dy) / 2
  const r = Math.max(chordHalf + 0.5, arc.radius)
  const h = Math.sqrt(Math.max(0, r * r - chordHalf * chordHalf))
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len, ny = dx / len
  const side = (arc.center.x - mx) * nx + (arc.center.y - my) * ny
  const s = side >= 0 ? 1 : -1
  return { ...arc, radius: r, center: { x: mx + nx * h * s, y: my + ny * h * s } }
}

/** 顶点移动后重新拟合受影响的弧实体 (保持通过两端点) */
export function updateArcsAfterVertexMove(
  arcs: ArcEntity[] | undefined,
  points: Point2D[],
  movedIdx: number,
): ArcEntity[] | undefined {
  if (!arcs) return undefined
  let changed = false
  const next = arcs.map(a => {
    if (a.p1 !== movedIdx && a.p2 !== movedIdx) return a
    changed = true
    return refitArcToEndpoints(a, points)
  })
  return changed ? next : arcs
}

/** 取轮廓显示圆心 (快捷圆 → center; 独立圆弧 → 弧心) */
export function contourCenter(c: Contour): Point2D | null {
  if (c.center) return c.center
  const arc = standaloneArc(c)
  return arc ? arc.center : null
}
