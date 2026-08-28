// ============ 自动吸附算法 — 鼠标位置 → 最近孔位 ============
import type { Point2D } from '../types/geometry'
import { SKADIS_DEFAULTS, crystalSlots, type HolePatternParamsEx } from './holePattern'

/** 孔的 3D 世界坐标 */
export interface HoleWorldPos {
  boardId: string
  row: number
  col: number
  /** 孔心世界坐标 (mm, 板子坐标系) */
  x: number
  y: number
  /** 板子原点世界坐标 (mm) */
  boardX: number
  boardY: number
  boardZ: number
  /** 吸附距离 */
  dist: number
}

/** 单颗孔位 (板子局部 mm) — 与 3D/2D 挖孔同一晶体阵列 */
export interface BoardHole {
  row: number
  col: number
  x: number
  y: number
  family: 'A' | 'B'
}

export interface BoardGeometry {
  boardId: string
  /** 板子原点 (世界 mm) */
  origin: { x: number; y: number; z: number }
  /** 孔阵列参数 */
  holePattern: HolePatternParamsEx
  /** 板子全部孔位 (局部 mm, 晶体错列阵列) */
  holes: BoardHole[]
}

/**
 * 计算鼠标世界位置附近的最近孔位
 * @param mouseWorld 鼠标世界坐标 (mm)
 * @param boards 所有板子的几何信息
 * @param threshold 吸附阈值 (mm)
 */
export function findNearestHole(
  mouseWorld: Point2D,
  boards: BoardGeometry[],
  threshold = 25, // 半个孔距 (吸附半径)
): HoleWorldPos | null {
  let best: HoleWorldPos | null = null

  for (const b of boards) {
    for (const h of b.holes) {
      // 孔心世界坐标 (板子原点 + 局部坐标)
      const hx = b.origin.x + h.x
      const hy = b.origin.y + h.y
      const d = Math.hypot(mouseWorld.x - hx, mouseWorld.y - hy)

      if (d <= threshold && (!best || d < best.dist)) {
        best = {
          boardId: b.boardId,
          row: h.row,
          col: h.col,
          x: hx,
          y: hy,
          boardX: b.origin.x,
          boardY: b.origin.y,
          boardZ: b.origin.z,
          dist: d,
        }
      }
    }
  }

  return best
}

/** 便捷: 从板子尺寸与孔阵列参数算出全部孔位 (供 Viewport3D 使用) */
export function boardHoles(width: number, height: number, holePattern: HolePatternParamsEx): BoardHole[] {
  return crystalSlots(width, height, holePattern)
}

export { SKADIS_DEFAULTS }
