// ============ 洞洞板工厂 — 创建默认/演示板 ============
import type { Board } from '../types/geometry'
import { SKADIS_DEFAULTS } from './holePattern'

let _boardCounter = 0

/**
 * 创建标准 SKÅDIS 洞洞板
 * @param widthMm 板宽 mm
 * @param heightMm 板高 mm
 * @param position 世界位置 (mm)
 */
export function createSkadisBoard(
  widthMm: number,
  heightMm: number,
  position: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): Board {
  _boardCounter++
  // 轮廓: 从 (0,0) 到 (w,h) 的矩形 (左下角原点)
  const contour = [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ]

  return {
    id: `board-${_boardCounter}`,
    name: `洞洞板 ${_boardCounter}`,
    contour,
    holePattern: { ...SKADIS_DEFAULTS },
    thickness: 5,
    split: { maxPieceSize: 220, enabled: true, cuts: [] },
    position,
  }
}
