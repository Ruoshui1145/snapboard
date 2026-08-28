// ============ 等距实体 (轮廓偏移) 算法 — 纯 TS, 无 DOM 依赖 ============
// 供 useSketchTool 等距工具使用。
// 算法: 绕向归一 (signedArea>0) → 每边取外侧法线偏移 → 相邻偏移线求交 → 退化校验。
// 正值外扩 / 负值内缩; 内缩过大导致自相交/退化返回 null。
import type { Point2D } from '../types/geometry'

/** 多边形有向面积 (标准公式, y 向下空间中 >0 时内侧在边右侧) */
export function signedArea(pts: Point2D[]): number {
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** 两线段所在直线求交; 平行返回 null */
function lineIntersection(a1: Point2D, b1: Point2D, a2: Point2D, b2: Point2D): Point2D | null {
  const d1x = b1.x - a1.x, d1y = b1.y - a1.y
  const d2x = b2.x - a2.x, d2y = b2.y - a2.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / den
  return { x: a1.x + t * d1x, y: a1.y + t * d1y }
}

/**
 * 闭合折线等距偏移 (像素单位, 正值外扩 / 负值内缩)
 * 返回偏移后的顶点 (与原轮廓同绕向); 退化/自相交返回 null
 */
export function offsetClosedPolygon(points: Point2D[], dist: number): Point2D[] | null {
  const n = points.length
  if (n < 3 || !Number.isFinite(dist) || dist === 0) return null
  const origArea = signedArea(points)
  if (Math.abs(origArea) < 1e-6) return null
  // 统一为 signedArea > 0 (外侧法线公式基于此约定)
  const ccw = origArea >= 0 ? points : [...points].reverse()

  const out: Point2D[] = []
  for (let i = 0; i < n; i++) {
    const prev = ccw[(i + n - 1) % n]
    const cur = ccw[i]
    const next = ccw[(i + 1) % n]
    const e1 = { x: cur.x - prev.x, y: cur.y - prev.y }
    const e2 = { x: next.x - cur.x, y: next.y - cur.y }
    const l1 = Math.hypot(e1.x, e1.y) || 1
    const l2 = Math.hypot(e2.x, e2.y) || 1
    // 右法线 = 外侧 (signedArea > 0)
    const n1 = { x: e1.y / l1, y: -e1.x / l1 }
    const n2 = { x: e2.y / l2, y: -e2.x / l2 }
    const ip = lineIntersection(
      { x: prev.x + n1.x * dist, y: prev.y + n1.y * dist },
      { x: cur.x + n1.x * dist, y: cur.y + n1.y * dist },
      { x: cur.x + n2.x * dist, y: cur.y + n2.y * dist },
      { x: next.x + n2.x * dist, y: next.y + n2.y * dist },
    )
    // 平行退化 (如相邻边共线): 取相邻原顶点中点兜底
    out.push(ip ?? { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 })
  }

  // 校验: 面积同号且未退化 (内缩过深 → 翻转为负/过小)
  const area = signedArea(out)
  if (!Number.isFinite(area)) return null
  if (area * origArea < 0) return null
  if (Math.abs(area) < Math.max(Math.abs(origArea) * 0.01, 1)) return null
  return out
}
