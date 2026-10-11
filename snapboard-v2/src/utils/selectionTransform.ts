import type { ArcEntity, Contour, Point2D } from '../types/geometry'
import { angleOnArc, arcPointAt } from './arc'

export interface SelectionBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
  center: Point2D
}

export interface UniformSelectionTransform {
  center: Point2D
  translateX?: number
  translateY?: number
  scale?: number
  rotation?: number
}

export interface TransformedContourGeometry {
  points: Point2D[]
  patch: Partial<Contour>
}

const finitePoints = (contour: Contour): Point2D[] => {
  const points = contour.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  for (const arc of contour.arcs ?? []) {
    const start = contour.points[arc.p1], end = contour.points[arc.p2]
    if (!start || !end || !Number.isFinite(arc.radius) || arc.radius <= 0) continue
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      if (angleOnArc(angle, arc.center, start, end, arc.sweep)) points.push(arcPointAt(arc.center, arc.radius, angle))
    }
  }
  if (contour.shape === 'circle' && contour.center && contour.radius) {
    points.push(
      { x: contour.center.x - contour.radius, y: contour.center.y },
      { x: contour.center.x + contour.radius, y: contour.center.y },
      { x: contour.center.x, y: contour.center.y - contour.radius },
      { x: contour.center.x, y: contour.center.y + contour.radius },
    )
  }
  const slotWidth = contour.slotParams?.width ?? contour.slotWidth
  if (slotWidth !== undefined && contour.points.length >= 2) {
    const radius = slotWidth / 2
    for (const point of contour.points.slice(0, 2)) {
      points.push(
        { x: point.x - radius, y: point.y - radius },
        { x: point.x + radius, y: point.y + radius },
      )
    }
  }
  return points
}

export function contourSelectionBounds(contour: Contour): SelectionBounds | null {
  const points = finitePoints(contour)
  if (points.length === 0) return null
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  }
}

export function selectionBounds(contours: readonly Contour[]): SelectionBounds | null {
  const values = contours.map(contourSelectionBounds).filter((value): value is SelectionBounds => value !== null)
  if (values.length === 0) return null
  const minX = Math.min(...values.map(value => value.minX))
  const maxX = Math.max(...values.map(value => value.maxX))
  const minY = Math.min(...values.map(value => value.minY))
  const maxY = Math.max(...values.map(value => value.maxY))
  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  }
}

export function contourInsideMarquee(contour: Contour, start: Point2D, end: Point2D): boolean {
  const bounds = contourSelectionBounds(contour)
  if (!bounds) return false
  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)
  return bounds.minX >= minX && bounds.maxX <= maxX && bounds.minY >= minY && bounds.maxY <= maxY
}

export function isBoxTransformSafe(contour: Contour): boolean {
  return !contour.geometryLocked && !contour.construction && !contour.infinite && contour.constraints.length === 0
}

export function transformContourGeometry(
  contour: Contour,
  transform: UniformSelectionTransform,
): TransformedContourGeometry {
  const scale = Math.max(0.02, Math.min(50, transform.scale ?? 1))
  const rotation = transform.rotation ?? 0
  const translateX = transform.translateX ?? 0
  const translateY = transform.translateY ?? 0
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const point = (value: Point2D): Point2D => {
    const x = (value.x - transform.center.x) * scale
    const y = (value.y - transform.center.y) * scale
    return {
      x: transform.center.x + x * cos - y * sin + translateX,
      y: transform.center.y + x * sin + y * cos + translateY,
    }
  }
  const patch: Partial<Contour> = {}
  if (contour.center) patch.center = point(contour.center)
  if (contour.radius !== undefined) patch.radius = contour.radius * scale
  if (contour.arcs) patch.arcs = contour.arcs.map((arc): ArcEntity => ({
    ...arc,
    center: point(arc.center),
    radius: arc.radius * scale,
  }))
  if (contour.slotWidth !== undefined) patch.slotWidth = contour.slotWidth * scale
  if (contour.slotParams) patch.slotParams = {
    length: contour.slotParams.length * scale,
    width: contour.slotParams.width * scale,
  }
  if (contour.rotation !== undefined) patch.rotation = contour.rotation + rotation * 180 / Math.PI
  if (contour.source) patch.source = {
    ...contour.source,
    params: {
      ...contour.source.params,
      selectionScale: Number(contour.source.params?.selectionScale ?? 1) * scale,
      rotation: Number(contour.source.params?.rotation ?? 0) + rotation * 180 / Math.PI,
    },
  }
  return { points: contour.points.map(point), patch }
}
