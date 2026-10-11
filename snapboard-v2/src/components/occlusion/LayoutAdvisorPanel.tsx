import './LayoutAdvisorPanel.css'

/** 布局建议器输出的最小展示模型；坐标与距离均使用板面毫米坐标。 */
export interface LayoutAdvisorSuggestion {
  id: string
  panelId: string
  targetId: string
  kind: string
  edgeDistance: number
  zoneLabel: string
  score: number
  reasons: readonly string[]
  x: number
  y: number
}

export interface LayoutAdvisorPanelProps {
  suggestions: readonly LayoutAdvisorSuggestion[]
  /** 约束过滤前后的可用候选总数，由建议器提供。 */
  candidateTotal: number
  /** 尚未分板时不应把“无建议”误报为分析结果。 */
  hasSplitResult: boolean
  onFocusSuggestion?: (suggestion: LayoutAdvisorSuggestion) => void
  /** 侧栏默认仅展示最优的 6 条建议。 */
  maxSuggestions?: number
  className?: string
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  slot: '长圆孔',
  round: '圆孔',
  either: '通用孔',
  edge: '边缘安装',
  free: '自由安装',
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  'near-edge': '靠近板件边缘，减少中心遮挡',
  'outside-visual-core': '避开视觉核心区',
  'load-storage-zone': '位于承重收纳区',
  'frequent-use-zone': '位于高频使用区',
  'hole-compatible': '孔型与安装锚点兼容',
  'spacing-clear': '周边安装间距充足',
  'corner-opportunity': '利用异形转角空间',
}

const finite = (value: number): number => Number.isFinite(value) ? value : 0

const formatMillimeters = (value: number): string => {
  const normalized = finite(value)
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(1)} mm`
}

const formatScore = (score: number): string => {
  const normalized = finite(score)
  const percentage = normalized >= 0 && normalized <= 1 ? normalized * 100 : normalized
  return `${Math.round(Math.max(0, Math.min(100, percentage)))} 分`
}

const kindLabel = (kind: string): string => KIND_LABELS[kind.toLowerCase()] ?? kind
const reasonLabel = (reason: string): string => REASON_LABELS[reason] ?? reason

export function LayoutAdvisorPanel({
  suggestions,
  candidateTotal,
  hasSplitResult,
  onFocusSuggestion,
  maxSuggestions = 6,
  className = '',
}: LayoutAdvisorPanelProps) {
  const visibleLimit = Math.max(1, Math.floor(finite(maxSuggestions)))
  const visibleSuggestions = [...suggestions]
    .sort((left, right) => (
      finite(right.score) - finite(left.score)
      || finite(left.edgeDistance) - finite(right.edgeDistance)
      || left.id.localeCompare(right.id)
    ))
    .slice(0, visibleLimit)
  const total = Math.max(0, Math.floor(finite(candidateTotal)), suggestions.length)
  const rootClassName = ['layout-advisor-panel', className].filter(Boolean).join(' ')

  return (
    <section className={rootClassName} aria-label="边缘优先布局建议">
      <header className="layout-advisor-head">
        <span className="layout-advisor-head-icon" aria-hidden="true">⌁</span>
        <span className="layout-advisor-head-copy">
          <strong>边缘优先建议</strong>
          <small>为异形板筛选低遮挡安装位置</small>
        </span>
        <span className="layout-advisor-count">
          <strong>{hasSplitResult ? total : '—'}</strong>
          <small>候选</small>
        </span>
      </header>

      <div className="layout-advisor-safety" role="note">
        <span aria-hidden="true">i</span>
        <p><strong>只给建议，不会移动配件或开孔</strong><small>选择候选只会在 3D 视口中定位预览。</small></p>
      </div>

      {!hasSplitResult ? (
        <div className="layout-advisor-empty" role="status">
          <span aria-hidden="true">◇</span>
          <strong>等待分板结果</strong>
          <small>完成自动分板后，系统会从各板件边缘和异形转角寻找兼容孔位。</small>
        </div>
      ) : visibleSuggestions.length === 0 ? (
        <div className="layout-advisor-empty" role="status">
          <span aria-hidden="true">◎</span>
          <strong>暂无可用建议</strong>
          <small>当前孔型、间距或分区约束下没有合适候选，可调整配件或板面布局后重试。</small>
        </div>
      ) : (
        <>
          <div className="layout-advisor-summary">
            <span>优先显示得分最高且距边更近的位置</span>
            <em>前 {visibleSuggestions.length} / {total}</em>
          </div>

          <ol className="layout-advisor-list">
            {visibleSuggestions.map((suggestion, index) => {
              const reasons = suggestion.reasons.length > 0
                ? suggestion.reasons.slice(0, 3)
                : ['满足边缘距离与孔位约束']
              return (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    disabled={!onFocusSuggestion}
                    aria-label={`定位第 ${index + 1} 条建议，距边 ${formatMillimeters(suggestion.edgeDistance)}`}
                    onClick={() => onFocusSuggestion?.(suggestion)}
                  >
                    <span className="layout-advisor-rank" aria-hidden="true">{index + 1}</span>
                    <span className="layout-advisor-card-body">
                      <span className="layout-advisor-card-title">
                        <strong title={suggestion.targetId}>{suggestion.targetId}</strong>
                        <em>{formatScore(suggestion.score)}</em>
                      </span>
                      <span className="layout-advisor-metrics">
                        <span><small>距边</small><b>{formatMillimeters(suggestion.edgeDistance)}</b></span>
                        <span><small>分区</small><b>{suggestion.zoneLabel || '未划分'}</b></span>
                        <span><small>孔型</small><b>{kindLabel(suggestion.kind)}</b></span>
                      </span>
                      <span className="layout-advisor-reasons">
                        {reasons.map((reason, reasonIndex) => (
                          <i key={`${reason}-${reasonIndex}`}>{reasonLabel(reason)}</i>
                        ))}
                      </span>
                      <span className="layout-advisor-location">
                        <small title={suggestion.panelId}>板件 {suggestion.panelId}</small>
                        <small>X {formatMillimeters(suggestion.x)} · Y {formatMillimeters(suggestion.y)}</small>
                        {onFocusSuggestion && <b>定位 ›</b>}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </section>
  )
}
