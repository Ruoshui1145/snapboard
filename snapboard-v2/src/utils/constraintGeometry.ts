import type { Contour, Point2D } from '../types/geometry'

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
