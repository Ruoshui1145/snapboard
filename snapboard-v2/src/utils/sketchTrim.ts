import type { Point2D } from '../types/geometry'

const EPS = 1e-6

export interface StraightEdgeRef {
  contourId: string
  edgeIdx: number
  a: Point2D
  b: Point2D
}

export interface TrimRange {
  t1: number
  t2: number
}

export interface TrimmedPath {
  points: Point2D[]
  /** 原顶点索引 -> 新顶点索引。修剪产生的新端点没有旧索引。 */
  oldVertexMap: Map<number, number>
  /** 原边索引 -> 新边索引。被修剪的目标边不会保留映射。 */
  oldEdgeMap: Map<number, number>
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const lerp = (a: Point2D, b: Point2D, t: number): Point2D => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})
const samePoint = (a: Point2D, b: Point2D, tol = EPS) => Math.hypot(a.x - b.x, a.y - b.y) <= tol

function paramOnLine(a: Point2D, b: Point2D, p: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  return len2 <= EPS ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
}

/**
 * 两条有限直线段的交点参数。端点相交也保留，因为 T 接点同样是修剪边界。
 * 共线重叠交给 collinearOverlapParams 处理。
 */
export function segmentIntersectionParam(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
): number | null {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const cdx = d.x - c.x
  const cdy = d.y - c.y
  const den = abx * cdy - aby * cdx
  if (Math.abs(den) <= EPS) return null
  const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / den
  const u = ((c.x - a.x) * aby - (c.y - a.y) * abx) / den
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return clamp01(t)
}

/** 返回第二条线段在第一条线段参数域内的实际共线重叠区间。 */
export function collinearOverlapParams(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
  distanceTolerance = 1e-3,
): TrimRange | null {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const cdx = d.x - c.x
  const cdy = d.y - c.y
  const len = Math.hypot(abx, aby)
  if (len <= EPS) return null
  const parallelError = Math.abs(abx * cdy - aby * cdx) / len
  const cLineError = Math.abs((c.x - a.x) * aby - (c.y - a.y) * abx) / len
  const dLineError = Math.abs((d.x - a.x) * aby - (d.y - a.y) * abx) / len
  if (parallelError > distanceTolerance || cLineError > distanceTolerance || dLineError > distanceTolerance) return null
  const tc = paramOnLine(a, b, c)
  const td = paramOnLine(a, b, d)
  const t1 = Math.max(0, Math.min(tc, td))
  const t2 = Math.min(1, Math.max(tc, td))
  return t2 - t1 > EPS ? { t1, t2 } : null
}

/**
 * 按当前几何求点击位置应擦除的区间：取点击点两侧最近的交点/接触点。
 * 没有内部边界时返回整条边，符合 Fusion/Onshape 的 Trim 语义。
 */
export function findTrimRangeAtPoint(
  a: Point2D,
  b: Point2D,
  click: Point2D,
  blockers: StraightEdgeRef[],
  extraBreaks: number[] = [],
): TrimRange {
  const cuts = [0, 1, ...extraBreaks.map(clamp01)]
  for (const edge of blockers) {
    const overlap = collinearOverlapParams(a, b, edge.a, edge.b)
    if (overlap) {
      cuts.push(overlap.t1, overlap.t2)
      continue
    }
    const t = segmentIntersectionParam(a, b, edge.a, edge.b)
    if (t !== null) cuts.push(t)
  }
  const sorted = [...cuts]
    .filter(Number.isFinite)
    .sort((x, y) => x - y)
    .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]) > 1e-5)
  const tc = clamp01(paramOnLine(a, b, click))
  let best: TrimRange = { t1: 0, t2: 1 }
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < sorted.length - 1; i++) {
    const t1 = sorted[i]
    const t2 = sorted[i + 1]
    if (t2 - t1 <= 1e-5 || tc < t1 - 1e-5 || tc > t2 + 1e-5) continue
    const distance = Math.abs((t1 + t2) / 2 - tc)
    if (distance < bestDistance) {
      best = { t1, t2 }
      bestDistance = distance
    }
  }
  return best
}

/**
 * 找出与目标擦除段共线重合的其他边，并换算成各自局部参数。
 * 调用方可据此一次性修剪公共边两侧，端点移动后部分重叠同样有效。
 */
export function findCoincidentTrimRanges(
  target: StraightEdgeRef,
  range: TrimRange,
  edges: StraightEdgeRef[],
): Array<StraightEdgeRef & TrimRange> {
  const start = lerp(target.a, target.b, range.t1)
  const end = lerp(target.a, target.b, range.t2)
  const result: Array<StraightEdgeRef & TrimRange> = []
  const seen = new Set<string>()
  for (const edge of edges) {
    if (edge.contourId === target.contourId) continue
    const overlap = collinearOverlapParams(edge.a, edge.b, start, end)
    if (!overlap) continue
    const key = `${edge.contourId}:${edge.edgeIdx}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...edge, ...overlap })
  }
  return result
}

function makePath(
  entries: Array<{ point: Point2D; oldIdx?: number }>,
  oldVertexCount: number,
  removedEdge: number,
  closed: boolean,
): TrimmedPath {
  const points: Point2D[] = []
  const oldVertexMap = new Map<number, number>()
  for (const entry of entries) {
    const previous = points[points.length - 1]
    if (previous && samePoint(previous, entry.point)) {
      if (entry.oldIdx !== undefined) oldVertexMap.set(entry.oldIdx, points.length - 1)
      continue
    }
    points.push({ ...entry.point })
    if (entry.oldIdx !== undefined) oldVertexMap.set(entry.oldIdx, points.length - 1)
  }
  const oldEdgeMap = new Map<number, number>()
  const oldEdgeCount = closed ? oldVertexCount : Math.max(0, oldVertexCount - 1)
  for (let edge = 0; edge < oldEdgeCount; edge++) {
    if (edge === removedEdge) continue
    const from = oldVertexMap.get(edge)
    const to = oldVertexMap.get(closed ? (edge + 1) % oldVertexCount : edge + 1)
    if (from !== undefined && to === from + 1) oldEdgeMap.set(edge, from)
  }
  return { points, oldVertexMap, oldEdgeMap }
}

/** 删除闭合轮廓一条边上的任意区间，返回剩余的单条开放路径。 */
export function trimClosedEdgeRange(points: Point2D[], edgeIdx: number, input: TrimRange): TrimmedPath {
  const n = points.length
  const k = ((edgeIdx % n) + n) % n
  const next = (k + 1) % n
  const t1 = clamp01(Math.min(input.t1, input.t2))
  const t2 = clamp01(Math.max(input.t1, input.t2))
  const a = points[k]
  const b = points[next]
  const start = lerp(a, b, t1)
  const end = lerp(a, b, t2)
  const entries: Array<{ point: Point2D; oldIdx?: number }> = []

  entries.push({ point: end, oldIdx: t2 >= 1 - EPS ? next : undefined })
  if (t2 < 1 - EPS) entries.push({ point: b, oldIdx: next })
  let cursor = (next + 1) % n
  while (cursor !== k) {
    entries.push({ point: points[cursor], oldIdx: cursor })
    cursor = (cursor + 1) % n
  }
  if (t1 > EPS) entries.push({ point: a, oldIdx: k })
  entries.push({ point: start, oldIdx: t1 <= EPS ? k : undefined })
  return makePath(entries, n, k, true)
}

/**
 * 删除开放折线一条边上的任意区间。内部边会产生左右两条独立路径，绝不跨缺口补斜线。
 */
export function trimOpenEdgeRange(points: Point2D[], edgeIdx: number, input: TrimRange): TrimmedPath[] {
  const edgeCount = Math.max(0, points.length - 1)
  if (edgeCount === 0) return []
  const k = Math.max(0, Math.min(edgeCount - 1, edgeIdx))
  const t1 = clamp01(Math.min(input.t1, input.t2))
  const t2 = clamp01(Math.max(input.t1, input.t2))
  const a = points[k]
  const b = points[k + 1]
  const start = lerp(a, b, t1)
  const end = lerp(a, b, t2)

  const left: Array<{ point: Point2D; oldIdx?: number }> = []
  for (let i = 0; i <= k; i++) left.push({ point: points[i], oldIdx: i })
  if (t1 > EPS) left.push({ point: start })

  const right: Array<{ point: Point2D; oldIdx?: number }> = []
  if (t2 < 1 - EPS) right.push({ point: end })
  for (let i = k + 1; i < points.length; i++) right.push({ point: points[i], oldIdx: i })

  return [makePath(left, points.length, k, false), makePath(right, points.length, k, false)]
    .filter(path => path.points.length >= 2)
}
