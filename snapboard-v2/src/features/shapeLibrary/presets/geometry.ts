import type { Point2D, ShapePresetBounds, ShapePresetParams } from './types'

const EPSILON = 1e-9

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

export function samplesFromDetail(detail: number, minimum: number, maximum: number): number {
  return Math.round(minimum + (maximum - minimum) * clamp01(detail))
}

export function interpolate(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export function sampleCubicBezier(
  start: Point2D,
  control1: Point2D,
  control2: Point2D,
  end: Point2D,
  segments: number,
  includeStart = false,
): Point2D[] {
  const points: Point2D[] = []
  const first = includeStart ? 0 : 1
  for (let index = first; index <= segments; index += 1) {
    const t = index / segments
    const u = 1 - t
    points.push({
      x: u * u * u * start.x + 3 * u * u * t * control1.x + 3 * u * t * t * control2.x + t * t * t * end.x,
      y: u * u * u * start.y + 3 * u * u * t * control1.y + 3 * u * t * t * control2.y + t * t * t * end.y,
    })
  }
  return points
}

export function signedArea(points: readonly Point2D[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum / 2
}

export function measureBounds(points: readonly Point2D[]): ShapePresetBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= EPSILON
}

export function cleanClosedPoints(points: readonly Point2D[]): Point2D[] {
  const cleaned: Point2D[] = []
  for (const point of points) {
    if (!cleaned.length || !samePoint(cleaned[cleaned.length - 1], point)) {
      cleaned.push({ x: point.x, y: point.y })
    }
  }
  if (cleaned.length > 1 && samePoint(cleaned[0], cleaned[cleaned.length - 1])) cleaned.pop()
  if (cleaned.length < 3) throw new Error('A shape preset must generate at least three distinct points.')
  return cleaned
}

/** Fits a source outline exactly into a box centred on the sketch origin. */
export function fitOutlineToDimensions(
  source: readonly Point2D[],
  width: number,
  height: number,
  flipX: boolean,
  flipY: boolean,
): { points: Point2D[]; bounds: ShapePresetBounds } {
  const cleaned = cleanClosedPoints(source)
  const sourceBounds = measureBounds(cleaned)
  if (sourceBounds.width <= EPSILON || sourceBounds.height <= EPSILON) {
    throw new Error('A shape preset generated a degenerate outline.')
  }

  const centerX = (sourceBounds.minX + sourceBounds.maxX) / 2
  const centerY = (sourceBounds.minY + sourceBounds.maxY) / 2
  const scaleX = width / sourceBounds.width * (flipX ? -1 : 1)
  const scaleY = height / sourceBounds.height * (flipY ? -1 : 1)
  let points = cleaned.map(point => ({
    x: (point.x - centerX) * scaleX,
    y: (point.y - centerY) * scaleY,
  }))

  // Flips should not change the winding contract consumed by polygon operations.
  if (signedArea(points) < 0) points = points.reverse()
  return { points, bounds: measureBounds(points) }
}

export function resolvePresetParams(
  defaults: Readonly<ShapePresetParams>,
  nativeAspectRatio: number,
  input: Partial<ShapePresetParams> = {},
): ShapePresetParams {
  const merged = { ...defaults, ...input }
  if (!Number.isFinite(merged.width) || merged.width <= 0) {
    throw new RangeError(`Shape preset width must be finite and positive; received ${merged.width}.`)
  }
  if (!Number.isFinite(merged.height) || merged.height <= 0) {
    throw new RangeError(`Shape preset height must be finite and positive; received ${merged.height}.`)
  }
  if (merged.cornerRadius !== undefined && (!Number.isFinite(merged.cornerRadius) || merged.cornerRadius < 0)) throw new RangeError('Corner radius must be finite and non-negative')
  const width = merged.width
  const height = merged.lockAspect ? width / nativeAspectRatio : merged.height
  return {
    width,
    height,
    ...(merged.cornerRadius === undefined ? {} : {cornerRadius: Math.min(merged.cornerRadius, width / 2, height / 2)}),
    lockAspect: Boolean(merged.lockAspect),
    flipX: Boolean(merged.flipX),
    flipY: Boolean(merged.flipY),
    detail: clamp01(Number.isFinite(merged.detail) ? merged.detail : defaults.detail),
    smoothing: clamp01(Number.isFinite(merged.smoothing) ? merged.smoothing : defaults.smoothing),
  }
}
