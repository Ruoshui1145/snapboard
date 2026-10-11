/**
 * 整单纹理范围：与 src/utils/boardTexture.ts 的 getSplitPanelTextureBounds 同口径
 * （有轮廓取轮廓点，否则退回 (x,y,w,h) 矩形），供原生配方网格按整单范围取样。
 * 原生配方网格尺寸校验要求 (width-1)*pitch 与这个范围一致，口径必须完全对齐。
 */
export function textureFrame(panels) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const panel of panels) {
    const points = panel.contour?.length ? panel.contour : [
      { x: panel.x, y: panel.y }, { x: panel.x + panel.w, y: panel.y + panel.h },
    ]
    for (const point of points) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y)
    }
  }
  if (!Number.isFinite(minX)) throw new Error('板件没有可用的纹理范围')
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}
