// ============ 遮挡模式策略 ============
// 纯策略层：只解释 0~1 的遮挡率，不依赖 React、Three.js 或 store。
// 阈值是产品经验参数，用户测试后的调整集中在本模块。

/** 设计器提供的三种遮挡目标。 */
export type OcclusionMode = 'display' | 'balanced' | 'storage'

/** 按全板遮挡率划分的客观状态，不受当前所选模式影响。 */
export type OcclusionRating = 'display-first' | 'balanced' | 'storage-first' | 'overcrowded'

/** 相对于当前模式目标的达标状态。 */
export type OcclusionPolicyStatus = 'within-target' | 'over-target' | 'replan'

export interface OcclusionModeDefinition {
  id: OcclusionMode
  label: string
  /** 当前模式建议的最大遮挡率，取值 0~1。 */
  maxOcclusionRatio: number
  description: string
}

export interface OcclusionRatingDefinition {
  id: OcclusionRating
  label: string
  hint: string
}

export interface OcclusionPolicyResult {
  mode: OcclusionMode
  modeLabel: string
  /** 已归一化到 0~1 的遮挡率。 */
  ratio: number
  threshold: number
  rating: OcclusionRating
  ratingLabel: string
  status: OcclusionPolicyStatus
  statusLabel: string
  /** 超出当前模式目标的比例；达标时为 0。 */
  excessRatio: number
  hint: string
}

/** 三种模式的最大建议遮挡率：展示 25%、平衡 40%、收纳 55%。 */
export const OCCLUSION_MODE_THRESHOLDS: Readonly<Record<OcclusionMode, number>> = Object.freeze({
  display: 0.25,
  balanced: 0.40,
  storage: 0.55,
})

export const OCCLUSION_MODES: Readonly<Record<OcclusionMode, OcclusionModeDefinition>> = Object.freeze({
  display: Object.freeze({
    id: 'display',
    label: '装饰优先',
    maxOcclusionRatio: OCCLUSION_MODE_THRESHOLDS.display,
    description: '尽量保留纹理、徽标和异形轮廓。',
  }),
  balanced: Object.freeze({
    id: 'balanced',
    label: '平衡模式',
    maxOcclusionRatio: OCCLUSION_MODE_THRESHOLDS.balanced,
    description: '兼顾日常收纳与板面展示。',
  }),
  storage: Object.freeze({
    id: 'storage',
    label: '收纳优先',
    maxOcclusionRatio: OCCLUSION_MODE_THRESHOLDS.storage,
    description: '允许更高配件密度，但仍避免板面过度拥挤。',
  }),
})

export const OCCLUSION_RATINGS: Readonly<Record<OcclusionRating, OcclusionRatingDefinition>> = Object.freeze({
  'display-first': Object.freeze({
    id: 'display-first',
    label: '展示优先',
    hint: '展示面保留充足，适合突出纹理与异形轮廓。',
  }),
  balanced: Object.freeze({
    id: 'balanced',
    label: '平衡状态',
    hint: '遮挡处于平衡区间，继续保护视觉核心区即可。',
  }),
  'storage-first': Object.freeze({
    id: 'storage-first',
    label: '功能优先',
    hint: '布局偏向收纳，建议把大配件集中到侧边或下方。',
  }),
  overcrowded: Object.freeze({
    id: 'overcrowded',
    label: '建议重新布局',
    hint: '配件遮挡过高，建议减少大配件或重新安排布局。',
  }),
})

export const OCCLUSION_STATUS_LABELS: Readonly<Record<OcclusionPolicyStatus, string>> = Object.freeze({
  'within-target': '符合模式目标',
  'over-target': '超出模式目标',
  replan: '建议重新布局',
})

/**
 * 把外部数值收敛到稳定的 0~1 范围。
 * NaN 视为 0；正负无穷分别落到 1 / 0，避免 UI 出现 NaN%。
 */
export function normalizeOcclusionRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0
  if (ratio === Infinity) return 1
  if (ratio === -Infinity) return 0
  return Math.max(0, Math.min(1, ratio))
}

/**
 * 按统一边界评级：
 *   [0,25%) 展示优先；[25%,40%] 平衡；(40%,55%] 功能优先；(55%,100%] 重新布局。
 */
export function rateOcclusion(ratio: number): OcclusionRating {
  const normalized = normalizeOcclusionRatio(ratio)
  if (normalized < OCCLUSION_MODE_THRESHOLDS.display) return 'display-first'
  if (normalized <= OCCLUSION_MODE_THRESHOLDS.balanced) return 'balanced'
  if (normalized <= OCCLUSION_MODE_THRESHOLDS.storage) return 'storage-first'
  return 'overcrowded'
}

/** 返回客观评级对应的中文提示。 */
export function occlusionHint(ratio: number): string {
  return OCCLUSION_RATINGS[rateOcclusion(ratio)].hint
}

/** 判断遮挡率是否满足指定模式的目标上限。 */
export function isWithinOcclusionTarget(ratio: number, mode: OcclusionMode): boolean {
  return normalizeOcclusionRatio(ratio) <= OCCLUSION_MODE_THRESHOLDS[mode]
}

/**
 * 生成 UI 可直接展示的策略结果。
 * 超过 55% 时无论选择哪种模式都进入 replan；否则按所选模式阈值判定是否达标。
 */
export function evaluateOcclusionPolicy(
  ratio: number,
  mode: OcclusionMode = 'balanced',
): OcclusionPolicyResult {
  const normalized = normalizeOcclusionRatio(ratio)
  const threshold = OCCLUSION_MODE_THRESHOLDS[mode]
  const rating = rateOcclusion(normalized)
  const status: OcclusionPolicyStatus = rating === 'overcrowded'
    ? 'replan'
    : normalized <= threshold
      ? 'within-target'
      : 'over-target'

  return {
    mode,
    modeLabel: OCCLUSION_MODES[mode].label,
    ratio: normalized,
    threshold,
    rating,
    ratingLabel: OCCLUSION_RATINGS[rating].label,
    status,
    statusLabel: OCCLUSION_STATUS_LABELS[status],
    excessRatio: Math.max(0, normalized - threshold),
    hint: OCCLUSION_RATINGS[rating].hint,
  }
}
