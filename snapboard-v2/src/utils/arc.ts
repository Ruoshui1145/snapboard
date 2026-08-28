// ============ 圆弧几何算法 (纯 TS, 无 DOM 依赖) ============
// 供 useSketchTool (命中/创建) 与 SketchViewport2D (渲染/预览) 共用。
// 约定: 所有角度用 atan2 在世界坐标 (y 向下) 计算, 与 canvas 渲染空间一致;
//       sweep 'ccw' = 角度递增方向 (canvas anticlockwise=false), 'cw' = 角度递减。
import type { Contour, Point2D } from '../types/geometry'

export type Sweep = 'ccw' | 'cw'

const TAU = Math.PI * 2

/** 归一化角度到 [0, 2π) */
export function normAngle(a: number): number {
  const r = a % TAU
  return r < 0 ? r + TAU : r
}

/** 点相对圆心的极角 (rad) */
export function pointAngle(center: Point2D, p: Point2D): number {
  return Math.atan2(p.y - center.y, p.x - center.x)
}

/** 圆弧上指定角度处的点 */
export function arcPointAt(center: Point2D, r: number, angle: number): Point2D {
  return { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) }
}

/**
 * 三点共圆: 返回圆心 + 半径; 三点共线返回 null
 */
export function circumcenter(p1: Point2D, p2: Point2D, p3: Point2D): { center: Point2D; radius: number } | null {
  const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y))
  if (Math.abs(d) < 1e-9) return null
  const p1s = p1.x * p1.x + p1.y * p1.y
  const p2s = p2.x * p2.x + p2.y * p2.y
  const p3s = p3.x * p3.x + p3.y * p3.y
  const cx = (p1s * (p2.y - p3.y) + p2s * (p3.y - p1.y) + p3s * (p1.y - p2.y)) / d
  const cy = (p1s * (p3.x - p2.x) + p2s * (p1.x - p3.x) + p3s * (p2.x - p1.x)) / d
  const center = { x: cx, y: cy }
  return { center, radius: Math.hypot(p1.x - cx, p1.y - cy) }
}

/** 三点弧的扫掠方向: 从 start 出发, 经过 through 到达 end */
export function sweepThrough(center: Point2D, start: Point2D, end: Point2D, through: Point2D): Sweep {
  const a1 = pointAngle(center, start)
  const a2 = pointAngle(center, end)
  const a3 = pointAngle(center, through)
  return normAngle(a3 - a1) < normAngle(a2 - a1) ? 'ccw' : 'cw'
}

/** 圆弧角跨度 (rad); 起终点重合时视为整圆 */
export function arcSpan(center: Point2D, start: Point2D, end: Point2D, sweep: Sweep): number {
  const a1 = pointAngle(center, start)
  const a2 = pointAngle(center, end)
  if (Math.abs(normAngle(a2 - a1)) < 1e-6) return TAU
  return sweep === 'cw' ? normAngle(a1 - a2) : normAngle(a2 - a1)
}

/**
 * 点到圆弧距离: 在圆弧角度范围内返回 |到圆心距离 - 半径|, 否则 Infinity
 */
export function arcDistance(
  pos: Point2D, center: Point2D, r: number,
  start: Point2D, end: Point2D, sweep: Sweep,
): number {
  const a = pointAngle(center, pos)
  const span = arcSpan(center, start, end, sweep)
  const a1 = pointAngle(center, start)
  const da = sweep === 'cw' ? normAngle(a1 - a) : normAngle(a - a1)
  if (da > span) return Infinity
  return Math.abs(Math.hypot(pos.x - center.x, pos.y - center.y) - r)
}

/** canvas arc 的 anticlockwise 参数 (世界 y 向下: ccw 增角 = canvas false) */
export function canvasArcFlag(sweep: Sweep): boolean {
  return sweep === 'cw'
}

/** 圆弧中点 (角跨度一半处) 的方向角 */
export function arcMidAngle(center: Point2D, start: Point2D, end: Point2D, sweep: Sweep): number {
  const a1 = pointAngle(center, start)
  const span = arcSpan(center, start, end, sweep)
  return sweep === 'cw' ? a1 - span / 2 : a1 + span / 2
}


// ============ 圆与多边形线段交点 / 圆弧段拆分 (修剪工具核心) ============

/** 由圆被多边形切割后得到的一段圆弧 */
export interface CircleArcSegment {
  center: Point2D
  radius: number
  /** 起点极角 (rad, [0, 2π)) */
  startAngle: number
  /** 终点极角 (rad, [0, 2π)) */
  endAngle: number
  start: Point2D
  end: Point2D
  sweep: Sweep
}

/** 直线段与圆的交点 (精确到线段有效范围; 相切/端点也会返回) */
export function circleLineIntersections(
  center: Point2D,
  r: number,
  a: Point2D,
  b: Point2D,
): Point2D[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const A = dx * dx + dy * dy
  if (A < 1e-12) return []
  const fx = a.x - center.x
  const fy = a.y - center.y
  const B = 2 * (fx * dx + fy * dy)
  const C = fx * fx + fy * fy - r * r
  const disc = B * B - 4 * A * C
  if (disc < -1e-9) return []
  const sqrtDisc = Math.sqrt(Math.max(0, disc))
  const t1 = (-B - sqrtDisc) / (2 * A)
  const t2 = (-B + sqrtDisc) / (2 * A)
  const pts: Point2D[] = []
  for (const t of [t1, t2]) {
    if (t >= -1e-9 && t <= 1 + 1e-9) {
      pts.push({ x: a.x + t * dx, y: a.y + t * dy })
    }
  }
  return pts
}

/** 收集一个圆与一组多边形轮廓直线段的交点角度 (去重) */
export function collectCircleIntersectionAngles(
  center: Point2D,
  r: number,
  contours: Contour[],
  selfId?: string,
): number[] {
  const angles: number[] = []
  for (const o of contours) {
    if (selfId !== undefined && o.id === selfId) continue
    // 圆/槽口本身不是“多边形线段”；跳过槽口，圆由各自逻辑处理
    if (o.shape === 'circle' || o.slotWidth !== undefined) continue
    const n = o.points.length
    if (n < 2) continue
    const total = o.closed && n > 2 ? n : n - 1
    for (let i = 0; i < total; i++) {
      const j = (i + 1) % n
      // 只计算直线段；圆弧边暂不参与圆切割
      if (o.arcs?.some(a => a.p1 === i && a.p2 === j)) continue
      const pts = circleLineIntersections(center, r, o.points[i], o.points[j])
      for (const p of pts) angles.push(pointAngle(center, p))
    }
  }
  // 归一化 + 去重
  const uniq: number[] = []
  for (const raw of angles) {
    const a = normAngle(raw)
    if (!uniq.some(u => Math.abs(normAngle(u - a)) < 1e-6 || Math.abs(normAngle(u - a) - TAU) < 1e-6)) {
      uniq.push(a)
    }
  }
  return uniq.sort((a, b) => a - b)
}

/** 按角度序列把整圆拆成若干段圆弧；少于 2 个不同交点时不拆分 */
export function splitCircleIntoArcSegments(
  center: Point2D,
  r: number,
  angles: number[],
): CircleArcSegment[] {
  const cleaned: number[] = []
  for (const raw of angles) {
    const a = normAngle(raw)
    if (!cleaned.some(u => Math.abs(u - a) < 1e-6)) cleaned.push(a)
  }
  cleaned.sort((a, b) => a - b)
  if (cleaned.length < 2) return []
  const segs: CircleArcSegment[] = []
  for (let i = 0; i < cleaned.length; i++) {
    const a1 = cleaned[i]
    const a2 = cleaned[(i + 1) % cleaned.length]
    segs.push({
      center: { ...center },
      radius: r,
      startAngle: a1,
      endAngle: a2,
      start: arcPointAt(center, r, a1),
      end: arcPointAt(center, r, a2),
      sweep: 'ccw',
    })
  }
  return segs
}

/**
 * 获取圆的虚拟圆弧段；若圆没有被任何多边形线段切割（交点少于 2），返回 null。
 * contours 应传入该圆所在草图的全部轮廓，用于计算相交。
 */
export function getCircleArcSegments(
  c: Contour,
  contours: Contour[],
): CircleArcSegment[] | null {
  if (c.shape !== 'circle' || !c.center || !c.radius) return null
  const angles = collectCircleIntersectionAngles(c.center, c.radius, contours, c.id)
  if (angles.length < 2) return null
  return splitCircleIntoArcSegments(c.center, c.radius, angles)
}

/** 点到虚拟圆弧段的距离 */
export function circleSegmentDistance(pos: Point2D, seg: CircleArcSegment): number {
  return arcDistance(pos, seg.center, seg.radius, seg.start, seg.end, seg.sweep)
}
