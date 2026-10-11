import type { SplitPanel } from '../types/geometry'

/**
 * 首轮容量预算（方案 §3.1）。它随打印配置记录在导出报告里，是容量假设而不是物理定律，
 * 也不做成普通用户必须理解的滑块；机器耗时/内存与实物试样决定这里之后怎么调。
 */
export interface ManufacturingBudgetLimits {
  /** 整单格数上限（所有板件采样框合计） */
  totalCells: number
  /** 单个热床格数上限 */
  plateCells: number
  /** 单个热床最长边格数上限 */
  plateEdgeCells: number
}

export const MANUFACTURING_BUDGET_LIMITS: ManufacturingBudgetLimits = {
  totalCells: 2_000_000,
  plateCells: 250_000,
  plateEdgeCells: 512,
}

/** 决定制造间距的那一项；导出报告据此说明精度从何而来。 */
export type ManufacturingBudgetTerm = 'line-width' | 'project-area' | 'plate-area' | 'plate-edge'

export interface ManufacturingBudgetInput {
  /** 参与叠色制造的板件（世界坐标 mm） */
  panels: SplitPanel[]
  /** A_art：合成纹理范围面积 mm²。改为逐板裁切渲染时，传实际纹理瓦片工作面积之和。 */
  artAreaMm2: number
  /** 当前光学层的配置/实测线宽 mm；0.4mm 喷嘴常见 0.42mm，采样比它更密只会产生印不出来的格点。 */
  lineWidthMm: number
  /**
   * 用户显式提高采样精度的倍率（1 = 方案首轮预算）。
   * 叠色图案的杂色斑来自抗锯齿边缘在粗格点上的量化；需要更干净的边界时可以调高，
   * 代价是格数、内存与耗时同比上升。格数上限 ×detail，间距下限 ÷√detail。
   */
  detail?: number
}

export interface ManufacturingBudget {
  /** 全工程统一制造间距 p (mm)：所有板件从同一世界原点取样，跨板颜色与接缝不会因独立取整错位。 */
  pitchMm: number
  /** 制造 PPI = 25.4 / p */
  ppi: number
  governing: ManufacturingBudgetTerm
  /** 四个候选值，供报告与对照 */
  terms: Record<ManufacturingBudgetTerm, number>
  /** A_all：所有板件纹理采样框面积之和 mm² */
  panelAreaMm2: number
  /** A_art：合成纹理范围面积 mm² */
  artAreaMm2: number
  /** 单热床峰值：采样框面积 / 最长边 */
  peakPanelAreaMm2: number
  peakPanelEdgeMm: number
  limits: ManufacturingBudgetLimits
  /** p 之下的实际格数：整单（取 A_all 与 A_art 的较大者，即被约束的那一项） */
  totalCells: number
  /** 最大单板格数 */
  peakPanelCells: number
}

/** 纹理采样框 = 板件轮廓包围盒；无轮廓时退回 (x,y,w,h) 矩形，与 getSplitPanelTextureBounds 同口径。 */
function samplingFrame(panel: SplitPanel): { width: number; height: number } | null {
  if (!panel.contour?.length) return panel.w > 0 && panel.h > 0 ? { width: panel.w, height: panel.h } : null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const point of panel.contour) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y)
  }
  const width = maxX - minX, height = maxY - minY
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * 方案 §3.1 的统一预算：
 * p = max(当前线宽, sqrt(max(A_all, A_art) / 整单格数), max_床 sqrt(A_床 / 每床格数), max_床 最长边 / 每床边格数)
 *
 * ponytail: 热床按“一块板件一床”计。本产品的板件本来就逐板打印，且此处排盘尚未发生；
 * 多块小板共床时会低估该床格数。等排盘提前到取样之前，再把这里换成真实床分组。
 * 返回 null = 没有任何可用的板件采样框，调用方按“无法叠色制造”处理。
 */
export function computeManufacturingBudget(input: ManufacturingBudgetInput): ManufacturingBudget | null {
  const { lineWidthMm, artAreaMm2 } = input
  if (!Number.isFinite(lineWidthMm) || lineWidthMm <= 0) throw new Error('制造线宽必须是正数')
  if (!Number.isFinite(artAreaMm2) || artAreaMm2 <= 0) throw new Error('合成纹理范围面积必须是正数')
  const detail = Math.min(16, Math.max(1, Math.round(input.detail ?? 1)))
  const limits: ManufacturingBudgetLimits = detail === 1 ? MANUFACTURING_BUDGET_LIMITS : {
    totalCells: MANUFACTURING_BUDGET_LIMITS.totalCells * detail,
    plateCells: MANUFACTURING_BUDGET_LIMITS.plateCells * detail,
    plateEdgeCells: MANUFACTURING_BUDGET_LIMITS.plateEdgeCells * Math.sqrt(detail),
  }

  let panelAreaMm2 = 0, peakPanelAreaMm2 = 0, peakPanelEdgeMm = 0
  for (const panel of input.panels) {
    const frame = samplingFrame(panel)
    if (!frame) continue
    const area = frame.width * frame.height
    panelAreaMm2 += area
    peakPanelAreaMm2 = Math.max(peakPanelAreaMm2, area)
    peakPanelEdgeMm = Math.max(peakPanelEdgeMm, frame.width, frame.height)
  }
  if (peakPanelEdgeMm <= 0) return null

  // 顺序即优先级：并列时保留先出现的一项，保证同一工程每次导出报告口径一致。
  const candidates: Array<[ManufacturingBudgetTerm, number]> = [
    ['line-width', lineWidthMm / Math.sqrt(detail)],
    ['project-area', Math.sqrt(Math.max(panelAreaMm2, artAreaMm2) / limits.totalCells)],
    ['plate-area', Math.sqrt(peakPanelAreaMm2 / limits.plateCells)],
    ['plate-edge', peakPanelEdgeMm / limits.plateEdgeCells],
  ]
  const [governing, pitchMm] = candidates.reduce((best, candidate) => candidate[1] > best[1] ? candidate : best)
  const cells = (areaMm2: number) => areaMm2 / (pitchMm * pitchMm)
  return {
    pitchMm,
    ppi: 25.4 / pitchMm,
    governing,
    terms: Object.fromEntries(candidates) as Record<ManufacturingBudgetTerm, number>,
    panelAreaMm2,
    artAreaMm2,
    peakPanelAreaMm2,
    peakPanelEdgeMm,
    limits,
    totalCells: cells(Math.max(panelAreaMm2, artAreaMm2)),
    peakPanelCells: cells(peakPanelAreaMm2),
  }
}
