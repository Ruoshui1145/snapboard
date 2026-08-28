import polygonClipping, { type Polygon, type Ring } from 'polygon-clipping'
import type { Point2D } from '../types/geometry'

const EPS = 1e-7

export interface PanelMaterialRegion {
  /** 最终实体外环，逆时针；跨板内孔会在这里形成开口/凹边。 */
  contour: Point2D[]
  /** 完整落在本区域内部的孔环。 */
  cutouts: Point2D[][]
}

function clippingResultToRegions(result: ReturnType<typeof polygonClipping.intersection>): PanelMaterialRegion[] {
  const regions: PanelMaterialRegion[] = []
  for (const polygon of result) {
    if (polygon.length === 0) continue
    const contour = fromRing(polygon[0], true)
    if (contour.length < 3 || Math.abs(signedArea(contour)) < 1) continue
    const cutouts = polygon.slice(1)
      .map(ring => fromRing(ring, false))
      .filter(ring => ring.length >= 3 && Math.abs(signedArea(ring)) >= 0.25)
    regions.push({ contour, cutouts })
  }
  return regions
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS
}

function signedArea(points: Point2D[]): number {
  let area2 = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area2 += a.x * b.y - b.x * a.y
  }
  return area2 / 2
}

/** polygon-clipping 输入环显式闭合；内部统一保留 0.001mm 精度，抑制浮点毛刺。 */
function toRing(points: Point2D[]): Ring {
  const ring: Ring = points.map(p => [
    Math.round(p.x * 1000) / 1000,
    Math.round(p.y * 1000) / 1000,
  ])
  if (ring.length > 0) {
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
  }
  return ring
}

function fromRing(ring: Ring, ccw: boolean): Point2D[] {
  const points: Point2D[] = []
  for (const pair of ring) {
    const point = { x: pair[0], y: pair[1] }
    if (points.length === 0 || !samePoint(points[points.length - 1], point)) points.push(point)
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop()
  if (points.length >= 3) {
    const isCCW = signedArea(points) > 0
    if (isCCW !== ccw) points.reverse()
  }
  return points
}

/**
 * 对单块基础板执行精确二维差集。
 * - 完整内孔保留为 cutouts；
 * - 与板边相交的孔被布尔运算并入外环，形成真实缺口；
 * - 若孔把板材切断，返回多个独立材料区域，由分割层分别编号。
 */
export function subtractHolesFromPanel(
  panelContour: Point2D[],
  holes: Point2D[][],
): PanelMaterialRegion[] {
  if (panelContour.length < 3) return []
  const subject: Polygon = [toRing(panelContour)]
  const clips: Polygon[] = holes.filter(h => h.length >= 3).map(h => [toRing(h)])
  const result = clips.length > 0
    ? polygonClipping.difference(subject, ...clips)
    : [subject]

  return clippingResultToRegions(result)
}

/**
 * 用精确矢量相交把规划板块裁回用户原始外轮廓。规划器可以使用 1mm 栅格寻找
 * 接缝，但最终外边绝不能使用栅格台阶代替用户绘制的斜线或小数坐标。
 */
export function intersectPanelWithPolygon(
  panelContour: Point2D[],
  sourceContour: Point2D[],
): PanelMaterialRegion[] {
  if (panelContour.length < 3 || sourceContour.length < 3) return []
  return clippingResultToRegions(polygonClipping.intersection(
    [toRing(panelContour)],
    [toRing(sourceContour)],
  ))
}
