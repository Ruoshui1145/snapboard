import type { Contour, Point2D } from '../types/geometry'
import { ptSegDist } from './entities'

/**
 * 参数化轮廓在擦除工具下的拓扑意图。
 *
 * 根据图元类型和命中位置确定擦除范围：
 * - 被其它边界切开的圆，edgeIdx >= 0，执行单圆弧修剪；
 * - 没有分段的孤立圆，edgeIdx === -1，才是整圆删除；
 * - 正多边形和槽口由一个参数化特征生成，组成边不作为独立特征编辑，整特征删除；
 * - 普通折线、混合圆弧和独立圆弧交回各自的边/弧修剪流程。
 *
 * 预览、点擦除与快速擦除必须共用此函数，避免“显示整圈、实际删一段”或反向回归。
 */
export type ParametricEraseIntent = 'whole-feature' | 'circle-segment' | 'edge'

export function resolveParametricEraseIntent(
  contour: Contour,
  edgeIdx: number,
): ParametricEraseIntent {
  if (contour.construction) return 'edge'

  if (contour.shape === 'circle') {
    return edgeIdx >= 0 ? 'circle-segment' : 'whole-feature'
  }

  if (!contour.closed) return 'edge'
  if (contour.shape === 'polygon'
      || contour.shape === 'slot'
      || contour.slotWidth !== undefined
      || contour.slotParams !== undefined) {
    return 'whole-feature'
  }

  return 'edge'
}

/** 槽口（胶囊）外边界的命中距离，而不是错误的中心线距离。 */
export function slotBoundaryDistance(contour: Contour, point: Point2D): number | null {
  if (contour.points.length < 2) return null
  const width = contour.slotParams?.width ?? contour.slotWidth
  if (width === undefined || !Number.isFinite(width) || width <= 0) return null
  return Math.abs(ptSegDist(point, contour.points[0], contour.points[1]) - width / 2)
}
