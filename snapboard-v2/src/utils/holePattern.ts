// ============ 孔阵列生成 — SKÅDIS 标准规格 (严格按 200×200 工程图) ============
// 竖向长圆孔(胶囊) 5×15 晶体错列阵列 + 副对角线 2 个固定圆孔 + 边界裁剪
import type { Point2D } from '../types/geometry'
import type { HolePatternParams } from '../types/geometry'

export interface HolePatternParamsEx extends HolePatternParams {
  /** A 列胶囊中心 X 零位 mm (相对板左下角, 工程图 10) */
  slotGridX0?: number
  /** A 列胶囊中心 Y 零位 mm (工程图 30) */
  slotGridY0?: number
  /** B 列相对 A 列 X 错位 mm (四板拼接 DXF = 20) */
  slotStaggerX?: number
  /** B 列相对 A 列 Y 错位 mm (工程图 20) */
  slotStaggerY?: number
}

/** SKÅDIS 标准默认参数 (孔型与 200×200 工程图一致: 竖向长圆孔 5.0×15.0, 晶体错列 40×40) */
export const SKADIS_DEFAULTS: HolePatternParamsEx = {
  cornerRadius: 8,
  slotWidth: 5,
  slotLength: 15,
  spacingX: 40,
  spacingY: 40,
  marginX: 10,
  marginY: 10,
  slotGridX0: 10,
  slotGridY0: 30,
  slotStaggerX: 20,          // 四板拼接 DXF: B 列 = 30+40i
  slotStaggerY: 20,
  jointHole: { enabled: true, diameter: 5, offsetX: 10, offsetY: 10 },
}

/** 竖向长圆孔(胶囊) — 一个孔 */
export interface SlotHole {
  row: number
  col: number
  /** 孔心坐标 (mm, 板子局部) */
  x: number
  y: number
  /** 晶体列族: A = 零位 (10,30), B = 错位 (+20, -20) */
  family: 'A' | 'B'
}

/** 固定圆孔（默认 φ5，副对角线） */
export interface JointHole {
  x: number
  y: number
  diameter: number
}

export interface HolePatternResult {
  /** 孔的几何描述 (3D 布尔用) */
  slots: SlotHole[]
  joints: JointHole[]
  /** 轮廓尺寸 */
  width: number
  height: number
  /** A 列族行列数 (B 列族与其一致或差一) */
  rows: number
  cols: number
}

/** 晶体错列阵列参数归一化 (缺省 = 工程图标准) */
function resolveParams(params: HolePatternParamsEx) {
  return {
    halfW: params.slotWidth / 2,
    halfL: params.slotLength / 2,
    pitchX: params.spacingX,                    // 40
    pitchY: params.spacingY,                    // 40 (晶体单列纵向周期)
    x0A: params.slotGridX0 ?? 10,
    y0A: params.slotGridY0 ?? 30,
    dxB: params.slotStaggerX ?? 20,
    dyB: params.slotStaggerY ?? 20,
  }
}

/**
 * 生成整板 (w×h, 左下角为原点) 的晶体错列长圆孔阵列。
 * 同一个函数供 3D 挖孔 / 2D 预览 / 吸附使用, 保证位置永远一致:
 *   A 列族: (x0A + pitchX*i, y0A + pitchY*j)                 → (10, 30) + 40×40
 *   B 列族: (x0A + dxB + pitchX*i, y0A - dyB + pitchY*j)     → (30, 10) + 40×40
 * 仅保留整颗胶囊 (含两端半圆) 完全落在板内的孔。
 */
export function crystalSlots(width: number, height: number, params: HolePatternParamsEx): SlotHole[] {
  const p = resolveParams(params)
  const EPS = 1e-6
  const fit = (x: number, y: number) =>
    x - p.halfW >= -EPS && x + p.halfW <= width + EPS &&
    y - p.halfL >= -EPS && y + p.halfL <= height + EPS

  const slots: SlotHole[] = []
  const families = [
    { dx: 0, dy: 0, family: 'A' as const, rowBase: 0, colBase: 0 },
    { dx: p.dxB, dy: -p.dyB, family: 'B' as const, rowBase: 1, colBase: 1 },
  ]
  for (const f of families) {
    for (let i = 0; ; i++) {
      const cx = p.x0A + f.dx + i * p.pitchX
      if (cx - p.halfW > width + EPS) break
      for (let j = 0; ; j++) {
        const cy = p.y0A + f.dy + j * p.pitchY
        if (cy - p.halfL > height + EPS) break
        if (fit(cx, cy)) {
          slots.push({ row: f.rowBase + 2 * j, col: f.colBase + 2 * i, x: cx, y: cy, family: f.family })
        }
      }
    }
  }
  return slots
}

/**
 * 生成孔阵列
 * @param contourPts 轮廓顶点 (mm, 相对板子左下角)
 * @param params 孔阵列参数
 */
export function generateHolePattern(
  contourPts: Point2D[],
  params: HolePatternParamsEx = SKADIS_DEFAULTS,
): HolePatternResult {
  // 轮廓包围盒 (mm)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of contourPts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const width = maxX - minX
  const height = maxY - minY

  // 晶体错列长圆孔阵列 (bbox 过滤, 与分割引擎同一套规则)
  const all = crystalSlots(width, height, params)
  const slots: SlotHole[] = []
  for (const s of all) {
    if (pointInPolygon({ x: minX + s.x, y: minY + s.y }, contourPts)) {
      slots.push({ ...s, x: minX + s.x, y: minY + s.y })
    }
  }

  // 副对角线固定圆孔（全板仅 2 个：左下 + 右上，默认 φ5，距角 10mm）
  const joints: JointHole[] = []
  if (params.jointHole.enabled) {
    const jd = params.jointHole.diameter
    const corners = [
      { x: minX + params.jointHole.offsetX, y: minY + params.jointHole.offsetY },
      { x: maxX - params.jointHole.offsetX, y: maxY - params.jointHole.offsetY },
    ]
    for (const c of corners) {
      if (pointInPolygon(c, contourPts)) {
        joints.push({ x: c.x, y: c.y, diameter: jd })
      }
    }
  }

  // A 列族计数作为 rows/cols (兼容旧字段)
  const aSlots = all.filter(s => s.family === 'A')
  const rows = aSlots.length > 0 ? Math.floor(aSlots.reduce((m, s) => Math.max(m, s.row), 0) / 2) + 1 : 0
  const cols = aSlots.length > 0 ? Math.floor(aSlots.reduce((m, s) => Math.max(m, s.col), 0) / 2) + 1 : 0

  return { slots, joints, width, height, rows, cols }
}

/** 点在多边形内测试 (射线法) */
export function pointInPolygon(p: Point2D, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
