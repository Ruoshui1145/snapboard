import type { Point2D } from '../types/geometry'
import type { TrimmedPath } from './sketchTrim'

const EPS = 1e-6

export interface EdgeTrimRange {
  edgeIdx: number
  t1: number
  t2: number
}

/** 一条输出边来自哪条旧边的哪段参数域。部分旧边可能对应多条输出边。 */
export interface KeptEdgeFragment {
  sourceEdgeIdx: number
  sourceT1: number
  sourceT2: number
  newEdgeIdx: number
}

export interface MultiTrimPath extends TrimmedPath {
  closed: boolean
  fragments: KeptEdgeFragment[]
}

/**
 * 一次多区间修剪的完整、可缓存拓扑计划。
 * 命令层只需另外保存 Contour 的非几何字段，即可原子写入 after，并用 before 撤销。
 */
export interface MultiTrimPlan {
  before: { points: Point2D[]; closed: boolean }
  removed: EdgeTrimRange[]
  after: MultiTrimPath[]
  changed: boolean
}

interface SourceFragment {
  edgeIdx: number
  t1: number
  t2: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const close = (a: number, b: number) => Math.abs(a - b) <= EPS
const samePoint = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y) <= EPS
const clonePoint = (point: Point2D): Point2D => ({ ...point })
const lerp = (a: Point2D, b: Point2D, t: number): Point2D => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/** 同一旧边上的擦除区间排序、截断并求并集，保证后续只处理互不重叠的区间。 */
export function normalizeMultiTrimRanges(
  edgeCount: number,
  ranges: EdgeTrimRange[],
): EdgeTrimRange[] {
  if (edgeCount <= 0) return []
  const grouped = new Map<number, Array<{ t1: number; t2: number }>>()
  for (const range of ranges) {
    if (!Number.isInteger(range.edgeIdx) || range.edgeIdx < 0 || range.edgeIdx >= edgeCount) continue
    if (!Number.isFinite(range.t1) || !Number.isFinite(range.t2)) continue
    const t1 = clamp01(Math.min(range.t1, range.t2))
    const t2 = clamp01(Math.max(range.t1, range.t2))
    if (t2 - t1 <= EPS) continue
    const entries = grouped.get(range.edgeIdx) ?? []
    entries.push({ t1, t2 })
    grouped.set(range.edgeIdx, entries)
  }

  const normalized: EdgeTrimRange[] = []
  for (const edgeIdx of [...grouped.keys()].sort((a, b) => a - b)) {
    const entries = grouped.get(edgeIdx)!.sort((a, b) => a.t1 - b.t1 || a.t2 - b.t2)
    let current = { ...entries[0] }
    for (let index = 1; index < entries.length; index++) {
      const next = entries[index]
      if (next.t1 <= current.t2 + EPS) current.t2 = Math.max(current.t2, next.t2)
      else {
        normalized.push({ edgeIdx, ...current })
        current = { ...next }
      }
    }
    normalized.push({ edgeIdx, ...current })
  }
  return normalized
}

function keptFragments(edgeCount: number, removed: EdgeTrimRange[]): SourceFragment[] {
  const byEdge = new Map<number, EdgeTrimRange[]>()
  for (const range of removed) {
    const entries = byEdge.get(range.edgeIdx) ?? []
    entries.push(range)
    byEdge.set(range.edgeIdx, entries)
  }
  const result: SourceFragment[] = []
  for (let edgeIdx = 0; edgeIdx < edgeCount; edgeIdx++) {
    let cursor = 0
    for (const range of byEdge.get(edgeIdx) ?? []) {
      if (range.t1 - cursor > EPS) result.push({ edgeIdx, t1: cursor, t2: range.t1 })
      cursor = Math.max(cursor, range.t2)
    }
    if (1 - cursor > EPS) result.push({ edgeIdx, t1: cursor, t2: 1 })
  }
  return result
}

function fragmentsConnect(
  left: SourceFragment,
  right: SourceFragment,
  edgeCount: number,
  closed: boolean,
): boolean {
  if (left.edgeIdx === right.edgeIdx) return close(left.t2, right.t1)
  const successor = left.edgeIdx + 1
  const expected = closed ? successor % edgeCount : successor
  return right.edgeIdx === expected && close(left.t2, 1) && close(right.t1, 0)
}

function groupFragments(fragments: SourceFragment[], edgeCount: number, closed: boolean): SourceFragment[][] {
  if (fragments.length === 0) return []
  const breaks: number[] = []
  for (let index = 0; index < fragments.length - 1; index++) {
    if (!fragmentsConnect(fragments[index], fragments[index + 1], edgeCount, closed)) breaks.push(index)
  }
  const wraps = closed && fragmentsConnect(fragments[fragments.length - 1], fragments[0], edgeCount, true)
  if (closed && breaks.length === 0 && wraps) return [fragments]

  // Closed contours may start in the middle of a retained component. Rotate to the
  // first fragment after a real gap so a component is never split at edge 0.
  let ordered = fragments
  if (closed && wraps && breaks.length > 0) {
    const start = breaks[0] + 1
    ordered = [...fragments.slice(start), ...fragments.slice(0, start)]
  }
  const groups: SourceFragment[][] = [[ordered[0]]]
  for (let index = 1; index < ordered.length; index++) {
    const current = groups[groups.length - 1]
    if (fragmentsConnect(current[current.length - 1], ordered[index], edgeCount, closed)) current.push(ordered[index])
    else groups.push([ordered[index]])
  }
  return groups
}

function buildPath(
  source: Point2D[],
  fragments: SourceFragment[],
  sourceClosed: boolean,
  edgeCount: number,
): MultiTrimPath {
  const points: Point2D[] = []
  const oldVertexMap = new Map<number, number>()
  const kept: KeptEdgeFragment[] = []
  const pointOnFragment = (fragment: SourceFragment, t: number) => {
    const a = source[fragment.edgeIdx]
    const b = source[sourceClosed ? (fragment.edgeIdx + 1) % source.length : fragment.edgeIdx + 1]
    return lerp(a, b, t)
  }
  const oldVertexAt = (fragment: SourceFragment, atEnd: boolean): number | undefined => {
    const t = atEnd ? fragment.t2 : fragment.t1
    if (atEnd && close(t, 1)) return sourceClosed ? (fragment.edgeIdx + 1) % source.length : fragment.edgeIdx + 1
    if (!atEnd && close(t, 0)) return fragment.edgeIdx
    return undefined
  }
  const append = (point: Point2D, oldVertex?: number): number => {
    const previous = points[points.length - 1]
    let index = points.length - 1
    if (!previous || !samePoint(previous, point)) {
      points.push(clonePoint(point))
      index = points.length - 1
    }
    if (oldVertex !== undefined && !oldVertexMap.has(oldVertex)) oldVertexMap.set(oldVertex, index)
    return index
  }

  for (const fragment of fragments) {
    const from = append(pointOnFragment(fragment, fragment.t1), oldVertexAt(fragment, false))
    append(pointOnFragment(fragment, fragment.t2), oldVertexAt(fragment, true))
    kept.push({
      sourceEdgeIdx: fragment.edgeIdx,
      sourceT1: fragment.t1,
      sourceT2: fragment.t2,
      newEdgeIdx: from,
    })
  }

  const closes = sourceClosed && fragments.length === edgeCount &&
    fragmentsConnect(fragments[fragments.length - 1], fragments[0], edgeCount, true)
  if (closes && points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop()

  const oldEdgeMap = new Map<number, number>()
  for (const fragment of kept) {
    if (close(fragment.sourceT1, 0) && close(fragment.sourceT2, 1)) {
      oldEdgeMap.set(fragment.sourceEdgeIdx, fragment.newEdgeIdx)
    }
  }
  return { points, oldVertexMap, oldEdgeMap, closed: closes, fragments: kept }
}

/**
 * 同时删除一条折线/闭合多边形上的任意多个区间，返回所有保留连通分量。
 * 所有区间先求并集，再一次性计算拓扑，避免连续执行单边命令后索引漂移或只保留第一段。
 */
export function planMultiTrim(
  points: Point2D[],
  closed: boolean,
  ranges: EdgeTrimRange[],
): MultiTrimPlan {
  const source = points.map(clonePoint)
  const edgeCount = closed ? source.length : Math.max(0, source.length - 1)
  const removed = normalizeMultiTrimRanges(edgeCount, ranges)
  const fragments = keptFragments(edgeCount, removed)
  const groups = groupFragments(fragments, edgeCount, closed)
  const after = groups
    .map(group => buildPath(source, group, closed, edgeCount))
    .filter(path => path.points.length >= 2 && path.fragments.length > 0)
  return {
    before: { points: source.map(clonePoint), closed },
    removed: removed.map(range => ({ ...range })),
    after,
    changed: removed.length > 0,
  }
}

/** 返回独立副本，供命令 undo 使用，避免 after 的现场修改污染 before。 */
export function restoreMultiTrimSource(plan: MultiTrimPlan): { points: Point2D[]; closed: boolean } {
  return { points: plan.before.points.map(clonePoint), closed: plan.before.closed }
}
