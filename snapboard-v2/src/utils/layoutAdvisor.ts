// 配件布局建议器
//
// 这一层只给已经存在的正面装配孔排序：
//   - 不修改分割结果；
//   - 不改变候选圆孔 knocked 状态；
//   - 不依赖 React / Three.js / store。
//
// x / y 沿用 splitPanelTargets 的装配局部坐标（X 以装配中心为 0，Y 以
// 装配底边为 0），可以直接用于 3D 标记。globalX / globalY 仅供诊断和
// 工程数据展示。

import type { SplitConfig, SplitPanel } from '../types/geometry'
import {
  splitAssemblyFrame,
  splitPanelTargets,
  type AssemblyTarget,
} from './assemblySnap.js'
import {
  boardZoneLayout,
  ZONE_LABELS,
  type BoardZoneId,
} from './occlusionModel.js'
import type { OcclusionMode } from './occlusionPolicy.js'

export type LayoutAdvisorMode = OcclusionMode

export interface LayoutAdvisorOptions {
  /** 已被现有配件占用的装配目标；这些目标不会出现在建议中。 */
  occupiedTargetIds?: Iterable<string>
  /** 最多返回多少条建议；缺省返回全部合法候选。 */
  limit?: number
  /** 与遮挡预览一致的装饰 / 平衡 / 收纳模式。 */
  mode?: LayoutAdvisorMode
}

export interface LayoutSuggestion {
  rank: number
  targetId: string
  panelId: string
  kind: AssemblyTarget['kind']
  /** 装配局部坐标，可直接供 Viewport3D 使用。 */
  x: number
  y: number
  z: number
  axis?: [number, number]
  /** 原始设计全局坐标，仅供诊断。 */
  globalX: number
  globalY: number
  zoneId: BoardZoneId
  zoneLabel: string
  /** 到所属板件真实 contour 的最短线段距离（mm）。 */
  edgeDistanceMm: number
  /** 0~1；越接近所属板件轮廓越接近 1。 */
  edgeProximity: number
  /** 仅视觉核心区大于 0；越大表示当前模式越倾向保护核心。 */
  visualCorePenalty: number
  /** 综合得分，越大越优先。 */
  score: number
  /** UI 可直接展示的稳定中文解释。 */
  reason: string
}

interface ModeWeights {
  visualCorePenalty: number
  loadStorageBonus: number
  frequentUseBonus: number
}

/**
 * 平衡模式的核心惩罚略大于 edgeProximity 的完整取值范围，因而只要还有
 * 非核心候选，视觉核心就不会提前进入建议。收纳模式放宽这一保护，但不会
 * 完全取消它；装饰模式则进一步加强保护。
 */
const MODE_WEIGHTS: Readonly<Record<LayoutAdvisorMode, ModeWeights>> = Object.freeze({
  display: Object.freeze({
    visualCorePenalty: 1.50,
    loadStorageBonus: 0.12,
    frequentUseBonus: 0.04,
  }),
  balanced: Object.freeze({
    visualCorePenalty: 1.05,
    loadStorageBonus: 0.10,
    frequentUseBonus: 0.03,
  }),
  storage: Object.freeze({
    visualCorePenalty: 0.25,
    loadStorageBonus: 0.14,
    frequentUseBonus: 0.06,
  }),
})

const MODE_LABELS: Readonly<Record<LayoutAdvisorMode, string>> = Object.freeze({
  display: '装饰优先',
  balanced: '平衡模式',
  storage: '收纳优先',
})

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback

const lexicalCompare = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

const panelContour = (panel: SplitPanel): Array<{ x: number; y: number }> =>
  panel.contour && panel.contour.length >= 3
    ? panel.contour
    : [
      { x: panel.x, y: panel.y },
      { x: panel.x + panel.w, y: panel.y },
      { x: panel.x + panel.w, y: panel.y + panel.h },
      { x: panel.x, y: panel.y + panel.h },
    ]

const pointSegmentDistance = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 1e-12) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 到 panel.contour（旧工程无 contour 时为矩形轮廓）的最短距离。 */
export function distanceToPanelContour(panel: SplitPanel, x: number, y: number): number {
  const contour = panelContour(panel)
  let closest = Infinity
  for (let index = 0; index < contour.length; index++) {
    const a = contour[index]
    const b = contour[(index + 1) % contour.length]
    closest = Math.min(closest, pointSegmentDistance(x, y, a.x, a.y, b.x, b.y))
  }
  return finite(closest, 0)
}

const resolveMode = (mode: LayoutAdvisorMode | undefined): LayoutAdvisorMode =>
  mode && Object.hasOwn(MODE_WEIGHTS, mode) ? mode : 'balanced'

const zoneForY = (
  y: number,
  layout: ReturnType<typeof boardZoneLayout>,
): BoardZoneId => {
  if (!layout.zones.length || layout.bounds.height <= 1e-9) return 'frequent-use'
  const normalized = Math.max(0, Math.min(1, (y - layout.bounds.minY) / layout.bounds.height))
  for (const zone of layout.zones) {
    if (normalized <= zone.to + 1e-9) return zone.id
  }
  return layout.zones[layout.zones.length - 1]?.id ?? 'frequent-use'
}

const zoneBonus = (zoneId: BoardZoneId, weights: ModeWeights): number => {
  if (zoneId === 'load-storage') return weights.loadStorageBonus
  if (zoneId === 'frequent-use') return weights.frequentUseBonus
  return 0
}

const suggestionReason = (
  zoneId: BoardZoneId,
  edgeDistanceMm: number,
  edgeMargin: number,
  mode: LayoutAdvisorMode,
): string => {
  const distance = edgeDistanceMm.toFixed(1)
  const edgeCopy = edgeDistanceMm <= Math.max(0, finite(edgeMargin)) + 1e-9
    ? `距所属板件真实轮廓 ${distance} mm，属于边缘优先孔位`
    : `距所属板件真实轮廓 ${distance} mm，已按边缘距离排序`

  if (zoneId === 'load-storage') {
    return `位于承重收纳区，优先承接功能配件；${edgeCopy}。`
  }
  if (zoneId === 'frequent-use') {
    return `位于高频使用区，兼顾取用与板面秩序；${edgeCopy}。`
  }
  return `位于视觉核心区，${MODE_LABELS[mode]}下已施加保护惩罚；${edgeCopy}。`
}

/**
 * 对正面合法装配目标生成确定性建议。
 *
 * splitPanelTargets 将尚未打通的板内候选圆孔标为 covered，建议器排除
 * 这些孔位，保持 knocked 状态不变。长圆孔
 * 与已经贯通的 round / round-edge 孔可以正常参与排序。
 */
export function adviseLayoutTargets(
  panels: SplitPanel[],
  cfg: SplitConfig,
  options: LayoutAdvisorOptions = {},
): LayoutSuggestion[] {
  if (!panels.length) return []

  const occupied = new Set(options.occupiedTargetIds ?? [])
  const mode = resolveMode(options.mode)
  const weights = MODE_WEIGHTS[mode]
  const frame = splitAssemblyFrame(panels)
  const layout = boardZoneLayout(panels)
  const panelById = new Map(panels.map(panel => [panel.id, panel]))
  const seenTargets = new Set<string>()
  const suggestions: Omit<LayoutSuggestion, 'rank'>[] = []
  // 全部候选共用同一量纲，保证同一区域内的排序严格等价于绝对轮廓距离
  // 升序；不能按各 panel 尺寸分别归一化，否则大板上更远的孔可能反超
  // 小板上更靠边的孔。
  const edgeScale = Math.max(1, Math.hypot(layout.bounds.width, layout.bounds.height) / 2)

  for (const target of splitPanelTargets(panels, cfg, 'front')) {
    // covered 只会出现在尚未 knocked 的候选 round-edge 孔。这里显式判断
    // kind，可防止未来给其他目标增加 covered 语义时被意外推荐。
    if (target.kind === 'round' && target.covered) continue
    if (target.kind !== 'slot' && target.kind !== 'round') continue
    if (occupied.has(target.id) || seenTargets.has(target.id)) continue

    const panel = panelById.get(target.panelId)
    if (!panel) continue
    seenTargets.add(target.id)

    const globalX = target.x + frame.centerX
    const globalY = target.y + frame.minY
    const edgeDistanceMm = distanceToPanelContour(panel, globalX, globalY)
    const edgeProximity = Math.max(0, Math.min(1, 1 - edgeDistanceMm / edgeScale))
    const zoneId = zoneForY(target.y, layout)
    const visualCorePenalty = zoneId === 'visual-core' ? weights.visualCorePenalty : 0
    const score = edgeProximity + zoneBonus(zoneId, weights) - visualCorePenalty

    suggestions.push({
      targetId: target.id,
      panelId: target.panelId,
      kind: target.kind,
      x: target.x,
      y: target.y,
      z: target.z,
      axis: target.axis,
      globalX,
      globalY,
      zoneId,
      zoneLabel: ZONE_LABELS[zoneId],
      edgeDistanceMm,
      edgeProximity,
      visualCorePenalty,
      score,
      reason: suggestionReason(zoneId, edgeDistanceMm, cfg.edgeMargin, mode),
    })
  }

  suggestions.sort((a, b) => {
    const scoreDelta = b.score - a.score
    if (Math.abs(scoreDelta) > 1e-12) return scoreDelta
    const panelOrder = lexicalCompare(a.panelId, b.panelId)
    return panelOrder || lexicalCompare(a.targetId, b.targetId)
  })

  const rawLimit = options.limit
  const limit = rawLimit === undefined
    ? suggestions.length
    : Number.isFinite(rawLimit)
      ? Math.max(0, Math.floor(rawLimit))
      : rawLimit === Infinity
        ? suggestions.length
        : 0

  return suggestions.slice(0, limit).map((suggestion, index) => ({
    ...suggestion,
    rank: index + 1,
  }))
}
