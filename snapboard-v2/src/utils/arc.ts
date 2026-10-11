// ============ 圆弧几何算法 (纯 TS, 无 DOM 依赖) ============
// 供 useSketchTool (命中/创建) 与 SketchViewport2D (渲染/预览) 共用。
// 约定: 所有角度用 atan2 在世界坐标 (y 向下) 计算, 与 canvas 渲染空间一致;
//       sweep 'ccw' = 角度递增方向 (canvas anticlockwise=false), 'cw' = 角度递减。
import type { Contour, Point2D } from '../types/geometry'

export type Sweep = 'ccw' | 'cw'

const TAU = Math.PI * 2
const GEOMETRY_EPS = 1e-9

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

/** 指定角度是否落在有向圆弧范围内（包含端点）。 */
export function angleOnArc(
  angle: number,
  center: Point2D,
  start: Point2D,
  end: Point2D,
  sweep: Sweep,
  tolerance = 1e-7,
): boolean {
  const span = arcSpan(center, start, end, sweep)
  if (span >= TAU - tolerance) return true
  const startAngle = pointAngle(center, start)
  const delta = sweep === 'cw'
    ? normAngle(startAngle - angle)
    : normAngle(angle - startAngle)
  return delta <= span + tolerance
}

export interface ArcProjection {
  point: Point2D
  distance: number
  kind: 'arc' | 'start' | 'end'
}

export interface ArcParameterRange {
  t1: number
  t2: number
}

/** 圆弧有向参数：起点=0、终点=1；圆弧范围外返回 null。 */
export function arcParameterAtPoint(
  point: Point2D,
  center: Point2D,
  start: Point2D,
  end: Point2D,
  sweep: Sweep,
): number | null {
  const angle = pointAngle(center, point)
  if (!angleOnArc(angle, center, start, end, sweep)) return null
  const span = arcSpan(center, start, end, sweep)
  if (span <= GEOMETRY_EPS) return null
  const startAngle = pointAngle(center, start)
  const delta = sweep === 'cw' ? normAngle(startAngle - angle) : normAngle(angle - startAngle)
  return Math.max(0, Math.min(1, delta / span))
}

/** 由参数取得圆弧点。 */
export function arcPointAtParameter(
  center: Point2D,
  r: number,
  start: Point2D,
  end: Point2D,
  sweep: Sweep,
  parameter: number,
): Point2D {
  const t = Math.max(0, Math.min(1, parameter))
  const startAngle = pointAngle(center, start)
  const span = arcSpan(center, start, end, sweep)
  const angle = sweep === 'cw' ? startAngle - span * t : startAngle + span * t
  return arcPointAt(center, r, angle)
}

/** 根据点击点和交点参数选择实际待删弧段。 */
export function findArcTrimRange(
  click: Point2D,
  center: Point2D,
  start: Point2D,
  end: Point2D,
  sweep: Sweep,
  breaks: number[],
): ArcParameterRange {
  const projected = projectPointToArc(click, center, Math.hypot(start.x - center.x, start.y - center.y), start, end, sweep)
  const clickT = arcParameterAtPoint(projected.point, center, start, end, sweep) ?? 0
  const cuts = [0, 1, ...breaks]
    .filter(Number.isFinite)
    .map(value => Math.max(0, Math.min(1, value)))
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]) > 1e-6)
  for (let index = 0; index < cuts.length - 1; index++) {
    if (clickT >= cuts[index] - 1e-7 && clickT <= cuts[index + 1] + 1e-7) {
      return { t1: cuts[index], t2: cuts[index + 1] }
    }
  }
  return { t1: 0, t2: 1 }
}

/** 判断有限直线在共享点处是否近似与圆弧相切。 */
export function isLineTangentToArcAt(
  lineStart: Point2D,
  lineEnd: Point2D,
  center: Point2D,
  sharedPoint: Point2D,
  toleranceRadians = (5 * Math.PI) / 180,
): boolean {
  const lineX = lineEnd.x - lineStart.x
  const lineY = lineEnd.y - lineStart.y
  const radialX = sharedPoint.x - center.x
  const radialY = sharedPoint.y - center.y
  const denominator = Math.hypot(lineX, lineY) * Math.hypot(radialX, radialY)
  if (denominator <= GEOMETRY_EPS) return false
  const cosine = Math.abs((lineX * radialX + lineY * radialY) / denominator)
  return cosine <= Math.sin(Math.max(0, toleranceRadians))
}

/**
 * 点到有限圆弧的最近投影。径向投影落在扫掠范围外时夹到最近端点，
 * 供垂足吸附、精确命中和后续圆弧尺寸使用。
 */
export function projectPointToArc(
  pos: Point2D,
  center: Point2D,
  r: number,
  start: Point2D,
  end: Point2D,
  sweep: Sweep,
): ArcProjection {
  const radial = Math.hypot(pos.x - center.x, pos.y - center.y)
  if (r > GEOMETRY_EPS && radial > GEOMETRY_EPS) {
    const angle = pointAngle(center, pos)
    if (angleOnArc(angle, center, start, end, sweep)) {
      const point = arcPointAt(center, r, angle)
      return { point, distance: Math.hypot(pos.x - point.x, pos.y - point.y), kind: 'arc' }
    }
  }
  const startDistance = Math.hypot(pos.x - start.x, pos.y - start.y)
  const endDistance = Math.hypot(pos.x - end.x, pos.y - end.y)
  return startDistance <= endDistance
    ? { point: { ...start }, distance: startDistance, kind: 'start' }
    : { point: { ...end }, distance: endDistance, kind: 'end' }
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
      const point = { x: a.x + t * dx, y: a.y + t * dy }
      if (!pts.some(existing => Math.hypot(existing.x - point.x, existing.y - point.y) <= 1e-7)) {
        pts.push(point)
      }
    }
  }
  return pts
}

/** 有限直线段与有限圆弧的交点。 */
export function lineArcIntersections(
  lineStart: Point2D,
  lineEnd: Point2D,
  center: Point2D,
  r: number,
  arcStart: Point2D,
  arcEnd: Point2D,
  sweep: Sweep,
): Point2D[] {
  return circleLineIntersections(center, r, lineStart, lineEnd)
    .filter(point => angleOnArc(pointAngle(center, point), center, arcStart, arcEnd, sweep))
}

/** 两个圆的有限交点；同心重合圆返回空数组，由调用方按重合关系单独处理。 */
export function circleCircleIntersections(
  center1: Point2D,
  radius1: number,
  center2: Point2D,
  radius2: number,
): Point2D[] {
  if (!Number.isFinite(radius1) || !Number.isFinite(radius2) || radius1 <= 0 || radius2 <= 0) return []
  const dx = center2.x - center1.x
  const dy = center2.y - center1.y
  const distance = Math.hypot(dx, dy)
  if (distance <= GEOMETRY_EPS) return []
  if (distance > radius1 + radius2 + GEOMETRY_EPS) return []
  if (distance < Math.abs(radius1 - radius2) - GEOMETRY_EPS) return []

  const along = (radius1 * radius1 - radius2 * radius2 + distance * distance) / (2 * distance)
  const heightSquared = radius1 * radius1 - along * along
  if (heightSquared < -GEOMETRY_EPS) return []
  const base = {
    x: center1.x + (along * dx) / distance,
    y: center1.y + (along * dy) / distance,
  }
  if (heightSquared <= GEOMETRY_EPS) return [base]
  const height = Math.sqrt(heightSquared)
  const offsetX = (-dy * height) / distance
  const offsetY = (dx * height) / distance
  return [
    { x: base.x + offsetX, y: base.y + offsetY },
    { x: base.x - offsetX, y: base.y - offsetY },
  ]
}

/** 两条有限圆弧的交点；先做圆—圆求交，再按两侧扫掠范围过滤。 */
export function arcArcIntersections(
  center1: Point2D,
  radius1: number,
  start1: Point2D,
  end1: Point2D,
  sweep1: Sweep,
  center2: Point2D,
  radius2: number,
  start2: Point2D,
  end2: Point2D,
  sweep2: Sweep,
): Point2D[] {
  return circleCircleIntersections(center1, radius1, center2, radius2)
    .filter(point =>
      angleOnArc(pointAngle(center1, point), center1, start1, end1, sweep1)
      && angleOnArc(pointAngle(center2, point), center2, start2, end2, sweep2))
}

/**
 * 收集一条有限直线与草图中所有整圆/圆弧的交点，并换算为该直线的 [0,1] 参数。
 * 点擦除以这些参数作为分段边界，因此圆弧压到矩形边中部时不会再删掉整条边。
 */
export function collectCurveIntersectionParamsOnLine(
  lineStart: Point2D,
  lineEnd: Point2D,
  contours: Contour[],
): number[] {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= GEOMETRY_EPS) return []
  const points: Point2D[] = []
  for (const contour of contours) {
    if (contour.shape === 'circle' && contour.center && contour.radius) {
      points.push(...circleLineIntersections(contour.center, contour.radius, lineStart, lineEnd))
      continue
    }
    for (const arc of contour.arcs ?? []) {
      points.push(...lineArcIntersections(
        lineStart,
        lineEnd,
        arc.center,
        arc.radius,
        contour.points[arc.p1],
        contour.points[arc.p2],
        arc.sweep,
      ))
    }
  }
  const params = points
    .map(point => ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared)
    .filter(value => value >= -1e-7 && value <= 1 + 1e-7)
    .map(value => Math.max(0, Math.min(1, value)))
    .sort((a, b) => a - b)
  return params.filter((value, index) => index === 0 || Math.abs(value - params[index - 1]) > 1e-6)
}

/** 收集一条有限圆弧与草图中其它直线、整圆和圆弧的交点参数。 */
export function collectArcIntersectionParams(
  center: Point2D,
  r: number,
  start: Point2D,
  end: Point2D,
  sweep: Sweep,
  contours: Contour[],
  selfContourId?: string,
): number[] {
  const points: Point2D[] = []
  for (const contour of contours) {
    if (selfContourId !== undefined && contour.id === selfContourId) continue
    if (contour.shape === 'circle' && contour.center && contour.radius) {
      points.push(...circleCircleIntersections(center, r, contour.center, contour.radius)
        .filter(point => angleOnArc(pointAngle(center, point), center, start, end, sweep)))
      continue
    }
    if (contour.slotWidth !== undefined) continue
    const total = contour.closed && contour.points.length > 2
      ? contour.points.length
      : Math.max(0, contour.points.length - 1)
    for (let edge = 0; edge < total; edge++) {
      const arc = contour.arcs?.find(item => item.p1 === edge && item.p2 === (edge + 1) % contour.points.length)
      if (arc) {
        points.push(...arcArcIntersections(
          center, r, start, end, sweep,
          arc.center, arc.radius, contour.points[arc.p1], contour.points[arc.p2], arc.sweep,
        ))
      } else {
        points.push(...lineArcIntersections(
          contour.points[edge], contour.points[(edge + 1) % contour.points.length],
          center, r, start, end, sweep,
        ))
      }
    }
  }
  const params = points
    .map(point => arcParameterAtPoint(point, center, start, end, sweep))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  return params.filter((value, index) => index === 0 || Math.abs(value - params[index - 1]) > 1e-6)
}

/** 收集一个圆与其它直线、圆弧和整圆轮廓的交点角度（去重）。 */
export function collectCircleIntersectionAngles(
  center: Point2D,
  r: number,
  contours: Contour[],
  selfId?: string,
): number[] {
  const angles: number[] = []
  for (const o of contours) {
    if (selfId !== undefined && o.id === selfId) continue
    if (o.shape === 'circle' && o.center && o.radius) {
      for (const point of circleCircleIntersections(center, r, o.center, o.radius)) {
        angles.push(pointAngle(center, point))
      }
      continue
    }
    // 槽口当前仍使用参数化胶囊命中；待槽口拆成两直线+两圆弧后再统一求交。
    if (o.slotWidth !== undefined) continue
    const n = o.points.length
    if (n < 2) continue
    const total = o.closed && n > 2 ? n : n - 1
    for (let i = 0; i < total; i++) {
      const j = (i + 1) % n
      const arc = o.arcs?.find(item => item.p1 === i && item.p2 === j)
      if (arc) {
        const points = circleCircleIntersections(center, r, arc.center, arc.radius)
          .filter(point => angleOnArc(
            pointAngle(arc.center, point),
            arc.center,
            o.points[arc.p1],
            o.points[arc.p2],
            arc.sweep,
          ))
        for (const point of points) angles.push(pointAngle(center, point))
        continue
      }
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
