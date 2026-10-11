import type { Contour, Point2D } from '../types/geometry'

const CENTER_EPSILON = 1e-9

/**
 * 智能尺寸使用的“轮廓中心”。
 *
 * `Contour.center` 只存在于参数化圆/多边形，旧工程里的槽口和普通闭合内孔
 * 没有该字段。定位尺寸不能因此退化成第一个顶点，所以这里统一补齐：
 * - 参数实体：使用其真实参数中心；
 * - 独立圆弧：使用弧心；
 * - 槽口：使用中心线中点；
 * - 普通闭合轮廓：使用面积重心（退化时回退顶点平均值）。
 */
export function contourDimensionCenter(contour: Contour): Point2D | null {
  if (contour.center && Number.isFinite(contour.center.x) && Number.isFinite(contour.center.y)) {
    return { ...contour.center }
  }

  if (!contour.closed && contour.points.length === 2 && contour.arcs?.length === 1) {
    const arc = contour.arcs[0]
    if (Number.isFinite(arc.center.x) && Number.isFinite(arc.center.y)) return { ...arc.center }
  }

  if (contour.slotWidth !== undefined && contour.points.length >= 2) {
    return {
      x: (contour.points[0].x + contour.points[1].x) / 2,
      y: (contour.points[0].y + contour.points[1].y) / 2,
    }
  }

  if (!contour.closed || contour.points.length < 3) return null
  let twiceArea = 0
  let weightedX = 0
  let weightedY = 0
  for (let index = 0; index < contour.points.length; index++) {
    const point = contour.points[index]
    const next = contour.points[(index + 1) % contour.points.length]
    const cross = point.x * next.y - next.x * point.y
    twiceArea += cross
    weightedX += (point.x + next.x) * cross
    weightedY += (point.y + next.y) * cross
  }
  if (Math.abs(twiceArea) > CENTER_EPSILON) {
    return {
      x: weightedX / (3 * twiceArea),
      y: weightedY / (3 * twiceArea),
    }
  }

  const sum = contour.points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  )
  return { x: sum.x / contour.points.length, y: sum.y / contour.points.length }
}

export interface CenterToLineTranslation {
  points: Point2D[]
  patch: Partial<Contour>
  centerBefore: Point2D
  centerAfter: Point2D
  foot: Point2D
  dx: number
  dy: number
  distance: number
}

/**
 * 将完整轮廓平移到距指定基准直线 `targetDistance` 的位置。
 * 保留原来位于基准线哪一侧，且只做法向平移；因此孔的半径、边长、旋转、
 * 弧心和内部尺寸都不会改变。
 */
export function translateContourCenterToLineDistance(
  contour: Contour,
  lineStart: Point2D,
  lineEnd: Point2D,
  targetDistance: number,
): CenterToLineTranslation | null {
  const center = contourDimensionCenter(contour)
  const lineX = lineEnd.x - lineStart.x
  const lineY = lineEnd.y - lineStart.y
  const lineLength = Math.hypot(lineX, lineY)
  if (!center || lineLength <= CENTER_EPSILON || !Number.isFinite(targetDistance) || targetDistance < 0) {
    return null
  }

  const unitX = lineX / lineLength
  const unitY = lineY / lineLength
  const normalX = -unitY
  const normalY = unitX
  const signedDistance = (center.x - lineStart.x) * normalX + (center.y - lineStart.y) * normalY
  const side = signedDistance < 0 ? -1 : 1
  const delta = targetDistance * side - signedDistance
  const dx = normalX * delta
  const dy = normalY * delta
  const translated = translateContourGeometry(contour, dx, dy)
  const projection = (center.x - lineStart.x) * unitX + (center.y - lineStart.y) * unitY
  return {
    ...translated,
    centerBefore: center,
    centerAfter: { x: center.x + dx, y: center.y + dy },
    foot: { x: lineStart.x + projection * unitX, y: lineStart.y + projection * unitY },
    dx,
    dy,
    distance: targetDistance,
  }
}

/**
 * 平移一个完整草图实体，并同步圆心、弧心和实体自身的尺寸标签。
 * 跨轮廓位置约束必须使用整体平移，不能只拉动内孔的一条边。
 */
export function translateContourGeometry(
  contour: Contour,
  dx: number,
  dy: number,
): { points: Point2D[]; patch: Partial<Contour> } {
  const move = (point: Point2D): Point2D => ({ x: point.x + dx, y: point.y + dy })
  const patch: Partial<Contour> = {
    constraints: contour.constraints.map(constraint => ({
      ...constraint,
      labelPos: move(constraint.labelPos),
    })),
  }
  if (contour.center) patch.center = move(contour.center)
  if (contour.arcs) {
    patch.arcs = contour.arcs.map(arc => ({ ...arc, center: move(arc.center) }))
  }
  return { points: contour.points.map(move), patch }
}
