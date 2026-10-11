import type { ImportBounds, ImportPoint } from './types'

const EPS = 1e-9

export function signedArea(points: ImportPoint[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index++) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum / 2
}

export function boundsOfRings(rings: ImportPoint[][]): ImportBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const ring of rings) {
    for (const point of ring) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

export function distanceSquared(a: ImportPoint, b: ImportPoint): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

export function pointSegmentDistance(point: ImportPoint, start: ImportPoint, end: ImportPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPS) return Math.sqrt(distanceSquared(point, start))
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

export function cleanRing(points: ImportPoint[], tolerance: number): { points: ImportPoint[]; removed: number } {
  const result: ImportPoint[] = []
  const toleranceSquared = tolerance * tolerance
  let removed = 0
  for (const point of points) {
    if (result.length > 0 && distanceSquared(result[result.length - 1], point) <= toleranceSquared) {
      removed++
      continue
    }
    result.push({ x: point.x, y: point.y })
  }
  if (result.length > 1 && distanceSquared(result[0], result[result.length - 1]) <= toleranceSquared) {
    result.pop()
    removed++
  }
  return { points: result, removed }
}

function orientation(a: ImportPoint, b: ImportPoint, c: ImportPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSegment(point: ImportPoint, start: ImportPoint, end: ImportPoint, tolerance: number): boolean {
  return Math.abs(orientation(start, end, point)) <= tolerance
    && point.x >= Math.min(start.x, end.x) - tolerance
    && point.x <= Math.max(start.x, end.x) + tolerance
    && point.y >= Math.min(start.y, end.y) - tolerance
    && point.y <= Math.max(start.y, end.y) + tolerance
}

export function segmentsIntersect(
  a: ImportPoint,
  b: ImportPoint,
  c: ImportPoint,
  d: ImportPoint,
  tolerance = EPS,
): boolean {
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  if (((o1 > tolerance && o2 < -tolerance) || (o1 < -tolerance && o2 > tolerance))
    && ((o3 > tolerance && o4 < -tolerance) || (o3 < -tolerance && o4 > tolerance))) return true
  return (Math.abs(o1) <= tolerance && onSegment(c, a, b, tolerance))
    || (Math.abs(o2) <= tolerance && onSegment(d, a, b, tolerance))
    || (Math.abs(o3) <= tolerance && onSegment(a, c, d, tolerance))
    || (Math.abs(o4) <= tolerance && onSegment(b, c, d, tolerance))
}

export function firstSelfIntersection(points: ImportPoint[], tolerance = EPS): [number, number] | null {
  const count = points.length
  if (count < 4) return null
  const bounds = boundsOfRings([points])
  const divisions = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(count))))
  const cellWidth = Math.max(EPS, bounds.width / divisions)
  const cellHeight = Math.max(EPS, bounds.height / divisions)
  const cells = new Map<number, number[]>()
  for (let first = 0; first < count; first++) {
    const firstNext = (first + 1) % count
    const start = points[first]
    const end = points[firstNext]
    const minCellX = Math.max(0, Math.min(divisions - 1, Math.floor((Math.min(start.x, end.x) - bounds.minX) / cellWidth)))
    const maxCellX = Math.max(0, Math.min(divisions - 1, Math.floor((Math.max(start.x, end.x) - bounds.minX) / cellWidth)))
    const minCellY = Math.max(0, Math.min(divisions - 1, Math.floor((Math.min(start.y, end.y) - bounds.minY) / cellHeight)))
    const maxCellY = Math.max(0, Math.min(divisions - 1, Math.floor((Math.max(start.y, end.y) - bounds.minY) / cellHeight)))
    const candidates = new Set<number>()
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (const candidate of cells.get(cellY * divisions + cellX) ?? []) candidates.add(candidate)
      }
    }
    for (const second of candidates) {
      const secondNext = (second + 1) % count
      if (first === second || firstNext === second || secondNext === first) continue
      if (segmentsIntersect(start, end, points[second], points[secondNext], tolerance)) {
        return [second, first]
      }
    }
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const key = cellY * divisions + cellX
        const cell = cells.get(key)
        if (cell) cell.push(first)
        else cells.set(key, [first])
      }
    }
  }
  return null
}

export function ringsIntersect(a: ImportPoint[], b: ImportPoint[], tolerance = EPS): boolean {
  for (let first = 0; first < a.length; first++) {
    for (let second = 0; second < b.length; second++) {
      if (segmentsIntersect(
        a[first], a[(first + 1) % a.length],
        b[second], b[(second + 1) % b.length],
        tolerance,
      )) return true
    }
  }
  return false
}

export function pointInRing(point: ImportPoint, ring: ImportPoint[], includeBoundary = true): boolean {
  let inside = false
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const a = ring[previous]
    const b = ring[current]
    if (onSegment(point, a, b, EPS)) return includeBoundary
    const crosses = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function simplifyOpen(points: ImportPoint[], tolerance: number): ImportPoint[] {
  if (points.length <= 2) return points.slice()
  let greatestDistance = -1
  let splitIndex = 0
  for (let index = 1; index < points.length - 1; index++) {
    const distance = pointSegmentDistance(points[index], points[0], points[points.length - 1])
    if (distance > greatestDistance) {
      greatestDistance = distance
      splitIndex = index
    }
  }
  if (greatestDistance <= tolerance) return [points[0], points[points.length - 1]]
  const left = simplifyOpen(points.slice(0, splitIndex + 1), tolerance)
  const right = simplifyOpen(points.slice(splitIndex), tolerance)
  return left.slice(0, -1).concat(right)
}

export function simplifyClosedRing(points: ImportPoint[], tolerance: number): ImportPoint[] {
  if (points.length <= 3 || tolerance <= 0) return points.slice()
  let splitIndex = 1
  let farthest = -1
  for (let index = 1; index < points.length; index++) {
    const distance = distanceSquared(points[0], points[index])
    if (distance > farthest) {
      farthest = distance
      splitIndex = index
    }
  }
  const firstHalf = simplifyOpen(points.slice(0, splitIndex + 1), tolerance)
  const secondHalf = simplifyOpen(points.slice(splitIndex).concat(points[0]), tolerance)
  const combined = firstHalf.slice(0, -1).concat(secondHalf.slice(0, -1))
  return cleanRing(combined, Math.max(EPS, tolerance * 1e-6)).points
}

export function chaikinSmooth(points: ImportPoint[], passes: number): ImportPoint[] {
  let current = points.slice()
  for (let pass = 0; pass < passes; pass++) {
    const next: ImportPoint[] = []
    for (let index = 0; index < current.length; index++) {
      const a = current[index]
      const b = current[(index + 1) % current.length]
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      )
    }
    current = next
  }
  return current
}

/**
 * Taubin λ/μ 双步低通平滑：第二个负步抵消普通拉普拉斯平滑的整体收缩。
 * 最后用面积比做一次极小的全局校正，使闭合板型面积保持稳定。
 */
export function taubinSmooth(
  points: ImportPoint[],
  passes: number,
  lambda = 0.45,
  mu = -0.47,
): ImportPoint[] {
  if (points.length < 3 || passes <= 0) return points.slice()
  const originalArea = Math.abs(signedArea(points))
  const step = (source: ImportPoint[], factor: number) => source.map((point, index) => {
    const previous = source[(index + source.length - 1) % source.length]
    const next = source[(index + 1) % source.length]
    const average = { x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 }
    return {
      x: point.x + (average.x - point.x) * factor,
      y: point.y + (average.y - point.y) * factor,
    }
  })
  let current = points.slice()
  for (let pass = 0; pass < passes; pass++) {
    current = step(step(current, lambda), mu)
  }
  const currentArea = Math.abs(signedArea(current))
  if (originalArea <= EPS || currentArea <= EPS) return current
  const scale = Math.sqrt(originalArea / currentArea)
  const center = current.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 })
  center.x /= current.length
  center.y /= current.length
  return current.map(point => ({
    x: center.x + (point.x - center.x) * scale,
    y: center.y + (point.y - center.y) * scale,
  }))
}

function segmentSegmentDistance(a: ImportPoint, b: ImportPoint, c: ImportPoint, d: ImportPoint): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  )
}

export function minimumNonAdjacentEdgeDistance(points: ImportPoint[], stopBelow = 0): number {
  let minimum = Number.POSITIVE_INFINITY
  for (let first = 0; first < points.length; first++) {
    const firstNext = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second++) {
      const secondNext = (second + 1) % points.length
      if (first === second || firstNext === second || secondNext === first) continue
      minimum = Math.min(minimum, segmentSegmentDistance(
        points[first], points[firstNext], points[second], points[secondNext],
      ))
      if (minimum <= stopBelow) return minimum
    }
  }
  return minimum
}
