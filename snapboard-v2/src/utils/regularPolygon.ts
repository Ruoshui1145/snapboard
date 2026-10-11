import type { Constraint, Contour, Point2D } from '../types/geometry'

const EPS = 1e-9

export interface RegularPolygonResize {
  center: Point2D
  points: Point2D[]
  /** The stored reference radius: circumradius in inscribed mode, apothem in circumscribed mode. */
  radius: number
  circumradius: number
  scale: number
}

function finitePoint(point: Point2D | undefined): point is Point2D {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
}

export function isRegularPolygonContour(contour: Contour): boolean {
  return contour.shape === 'polygon'
    && finitePoint(contour.center)
    && contour.points.length >= 3
    && Number.isFinite(contour.radius)
    && (contour.radius ?? 0) > EPS
}

/**
 * The point array is the source of truth for orientation. `rotation` is rounded for the
 * property panel, so rebuilding from it would introduce a small turn on every edit.
 */
export function regularPolygonStartAngle(contour: Contour): number {
  if (!contour.center || !finitePoint(contour.points[0])) return 0
  return Math.atan2(
    contour.points[0].y - contour.center.y,
    contour.points[0].x - contour.center.x,
  )
}

export function regularPolygonPoints(
  contour: Contour,
  referenceRadius: number,
): Point2D[] | null {
  if (!isRegularPolygonContour(contour) || !Number.isFinite(referenceRadius) || referenceRadius <= EPS) return null
  const center = contour.center!
  const sides = contour.points.length
  const circumradius = contour.polygonCircumscribed
    ? referenceRadius / Math.cos(Math.PI / sides)
    : referenceRadius
  const start = regularPolygonStartAngle(contour)
  return Array.from({ length: sides }, (_, index) => {
    const angle = start + (Math.PI * 2 * index) / sides
    return {
      x: center.x + circumradius * Math.cos(angle),
      y: center.y + circumradius * Math.sin(angle),
    }
  })
}

export function resizeRegularPolygon(
  contour: Contour,
  referenceRadius: number,
): RegularPolygonResize | null {
  const points = regularPolygonPoints(contour, referenceRadius)
  if (!points || !contour.center || !contour.radius) return null
  return {
    center: { ...contour.center },
    points,
    radius: referenceRadius,
    circumradius: contour.polygonCircumscribed
      ? referenceRadius / Math.cos(Math.PI / contour.points.length)
      : referenceRadius,
    scale: referenceRadius / contour.radius,
  }
}

export function polygonReferenceRadiusForSide(contour: Contour, sideLength: number): number | null {
  if (!isRegularPolygonContour(contour) || !Number.isFinite(sideLength) || sideLength <= EPS) return null
  const sides = contour.points.length
  const circumradius = sideLength / (2 * Math.sin(Math.PI / sides))
  return contour.polygonCircumscribed
    ? circumradius * Math.cos(Math.PI / sides)
    : circumradius
}

function lineGap(points: Point2D[], edge1: number, edge2: number): number {
  const count = points.length
  const a = points[((edge1 % count) + count) % count]
  const b = points[(((edge1 + 1) % count) + count) % count]
  const p = points[((edge2 % count) + count) % count]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length <= EPS) return 0
  return Math.abs(((p.x - a.x) * -dy + (p.y - a.y) * dx) / length)
}

export function polygonReferenceRadiusForParallelGap(
  contour: Contour,
  edge1: number,
  edge2: number,
  gap: number,
): number | null {
  if (!isRegularPolygonContour(contour) || !Number.isFinite(gap) || gap <= EPS) return null
  const unit = regularPolygonPoints(contour, 1)
  if (!unit) return null
  const unitGap = lineGap(unit, edge1, edge2)
  return unitGap > EPS ? gap / unitGap : null
}

export function polygonReferenceRadiusForVertexDistance(
  contour: Contour,
  vertex1: number,
  vertex2: number,
  distance: number,
): number | null {
  if (!isRegularPolygonContour(contour) || !Number.isFinite(distance) || distance <= EPS) return null
  const unit = regularPolygonPoints(contour, 1)
  if (!unit) return null
  const resolve = (index: number): Point2D | null => {
    if (index === -2) return contour.center ? { ...contour.center } : null
    return unit[index] ?? null
  }
  const a = resolve(vertex1)
  const b = resolve(vertex2)
  if (!a || !b) return null
  const unitDistance = Math.hypot(b.x - a.x, b.y - a.y)
  return unitDistance > EPS ? distance / unitDistance : null
}

export function polygonReferenceRadiusForCenterEdgeDistance(
  contour: Contour,
  edge: number,
  distance: number,
): number | null {
  if (!isRegularPolygonContour(contour) || !Number.isFinite(distance) || distance <= EPS) return null
  const unit = regularPolygonPoints(contour, 1)
  if (!unit || !contour.center) return null
  const index = ((edge % unit.length) + unit.length) % unit.length
  const unitDistance = pointLineDistance(
    contour.center,
    unit[index],
    unit[(index + 1) % unit.length],
  )
  return unitDistance > EPS ? distance / unitDistance : null
}

function constraintValue(
  constraint: Constraint,
  resized: RegularPolygonResize,
  pixelToMM: number,
): { value: number; label: string } | null {
  const points = resized.points
  const count = points.length
  if (constraint.type === 'radius' && constraint.edgeIndex === undefined) {
    const value = resized.radius * pixelToMM
    return { value, label: `R ${value.toFixed(1)} mm` }
  }
  if (constraint.type === 'diameter' && constraint.edgeIndex === undefined) {
    const value = resized.radius * 2 * pixelToMM
    return { value, label: `直径 ${value.toFixed(1)} mm` }
  }
  if (constraint.type === 'length' && constraint.edgeIndex !== undefined) {
    const a = points[((constraint.edgeIndex % count) + count) % count]
    const b = points[(constraint.edgeIndex + 1 + count) % count]
    const value = Math.hypot(b.x - a.x, b.y - a.y) * pixelToMM
    const dx = Math.abs(b.x - a.x)
    const dy = Math.abs(b.y - a.y)
    const prefix = dx > dy * 2 ? '宽' : dy > dx * 2 ? '高' : '长度'
    return { value, label: `${prefix} ${value.toFixed(1)} mm` }
  }
  if (constraint.type === 'distance' && !constraint.contourId2) {
    if (constraint.edgeIndex !== undefined && constraint.edgeIndex2 !== undefined) {
      const value = lineGap(points, constraint.edgeIndex, constraint.edgeIndex2) * pixelToMM
      return { value, label: `间距 ${value.toFixed(1)} mm` }
    }
    if (constraint.vertexIdx1 !== undefined && constraint.vertexIdx2 !== undefined
        && constraint.vertexIdx1 !== -3 && constraint.vertexIdx2 !== -3) {
      const resolve = (index: number): Point2D | null => index === -2
        ? resized.center
        : points[index] ?? null
      const a = resolve(constraint.vertexIdx1)
      const b = resolve(constraint.vertexIdx2)
      if (!a || !b) return null
      const value = Math.hypot(b.x - a.x, b.y - a.y) * pixelToMM
      const centerDistance = constraint.vertexIdx1 === -2 || constraint.vertexIdx2 === -2
      return { value, label: `${centerDistance ? '中心距' : '距离'} ${value.toFixed(1)} mm` }
    }
    if (constraint.edgeIndex !== undefined && constraint.vertexIdx1 === -2) {
      const edge = ((constraint.edgeIndex % count) + count) % count
      const a = points[edge]
      const b = points[(edge + 1) % count]
      const value = pointLineDistance(resized.center, a, b) * pixelToMM
      return { value, label: `内切距 ${value.toFixed(1)} mm` }
    }
  }
  return null
}

function pointLineDistance(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  return length <= EPS
    ? Math.hypot(point.x - a.x, point.y - a.y)
    : Math.abs(((point.x - a.x) * dy - (point.y - a.y) * dx) / length)
}

/**
 * Refresh dimensions that describe this regular polygon itself. Cross-contour placement
 * dimensions are deliberately excluded: resizing a hole must not rewrite its offset from
 * the outer board.
 */
export function regularPolygonConstraintPatch(
  constraint: Constraint,
  resized: RegularPolygonResize,
  pixelToMM: number,
): Partial<Constraint> | null {
  const measured = constraintValue(constraint, resized, pixelToMM)
  if (!measured) return null
  const center = resized.center
  const oldLabel = constraint.labelPos
  const labelPos = finitePoint(oldLabel)
    ? {
        x: center.x + (oldLabel.x - center.x) * resized.scale,
        y: center.y + (oldLabel.y - center.y) * resized.scale,
      }
    : oldLabel
  return { ...measured, ...(labelPos ? { labelPos } : {}) }
}

export function regularPolygonInvariantError(contour: Contour, points: Point2D[]): number {
  if (!contour.center || points.length < 3) return Number.POSITIVE_INFINITY
  const radii = points.map(point => Math.hypot(point.x - contour.center!.x, point.y - contour.center!.y))
  const sides = points.map((point, index) => {
    const next = points[(index + 1) % points.length]
    return Math.hypot(next.x - point.x, next.y - point.y)
  })
  return Math.max(
    Math.max(...radii) - Math.min(...radii),
    Math.max(...sides) - Math.min(...sides),
  )
}
