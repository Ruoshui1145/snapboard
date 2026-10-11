import { useMemo, type CSSProperties } from 'react'
import type { OcclusionReport } from '../../utils/occlusionModel'
import { evaluateOcclusionPolicy, OCCLUSION_MODE_THRESHOLDS, type OcclusionMode } from '../../utils/occlusionPolicy'
import './OcclusionPreviewPanel.css'

export type OcclusionPreviewMode = OcclusionMode

/**
 * 可选的外部热力图。values 按自下而上、从左到右排列，数值越大表示配件越密集。
 * 未提供时，组件会直接使用 OcclusionReport.grid.coverage。
 */
export interface OcclusionHeatmapData {
  cols: number
  rows: number
  values: ArrayLike<number>
  /** 0 表示板外或孔洞；省略时所有格子都视为有效板面。 */
  material?: ArrayLike<number>
  /** 归一化上限；省略时从 values 中自动查找最大值。 */
  maxValue?: number
}

export interface OcclusionPreviewPanelProps {
  report: OcclusionReport | null
  mode: OcclusionPreviewMode
  onModeChange: (mode: OcclusionPreviewMode) => void
  overlayEnabled: boolean
  onOverlayEnabledChange: (enabled: boolean) => void
  /** 更精细的纹理可见度 0~1；省略时以板面保留率估算。 */
  textureVisibilityRatio?: number | null
  /** 更精细或由 GPU 生成的密度图；省略时使用报告栅格。 */
  heatmap?: OcclusionHeatmapData | null
  className?: string
}

interface HeatmapCell {
  x: number
  y: number
  density: number
  material: boolean
}

interface SampledHeatmap {
  cols: number
  rows: number
  cells: HeatmapCell[]
}

const MODES: Array<{
  id: OcclusionPreviewMode
  label: string
  shortHint: string
  target: string
}> = [
  { id: 'display', label: '展示', shortHint: '保留视觉中心', target: `≤ ${Math.round(OCCLUSION_MODE_THRESHOLDS.display * 100)}%` },
  { id: 'balanced', label: '平衡', shortHint: '展示与收纳兼顾', target: `≤ ${Math.round(OCCLUSION_MODE_THRESHOLDS.balanced * 100)}%` },
  { id: 'storage', label: '收纳', shortHint: '提高功能密度', target: `≤ ${Math.round(OCCLUSION_MODE_THRESHOLDS.storage * 100)}%` },
]

const clampRatio = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const percent = (value: number, digits = 0): string => `${(clampRatio(value) * 100).toFixed(digits)}%`

const reportHeatmap = (report: OcclusionReport | null): OcclusionHeatmapData | null => {
  if (!report || report.grid.cols <= 0 || report.grid.rows <= 0) return null
  return {
    cols: report.grid.cols,
    rows: report.grid.rows,
    values: report.grid.coverage,
    material: report.grid.material,
  }
}

/** 将最多 24 万格的分析栅格压缩成适合侧栏预览的少量 SVG 方格。 */
const sampleHeatmap = (source: OcclusionHeatmapData | null): SampledHeatmap | null => {
  if (!source || source.cols <= 0 || source.rows <= 0) return null
  const sourceCols = Math.floor(source.cols)
  const sourceRows = Math.floor(source.rows)
  if (sourceCols <= 0 || sourceRows <= 0) return null

  const cols = Math.min(24, sourceCols)
  const rows = Math.min(15, sourceRows)
  const rawCells: Array<HeatmapCell & { raw: number }> = []
  let sampledMax = 0

  for (let row = 0; row < rows; row++) {
    const sourceY0 = Math.floor(row * sourceRows / rows)
    const sourceY1 = Math.max(sourceY0 + 1, Math.ceil((row + 1) * sourceRows / rows))
    for (let col = 0; col < cols; col++) {
      const sourceX0 = Math.floor(col * sourceCols / cols)
      const sourceX1 = Math.max(sourceX0 + 1, Math.ceil((col + 1) * sourceCols / cols))
      let material = false
      let raw = 0
      for (let sourceY = sourceY0; sourceY < Math.min(sourceY1, sourceRows); sourceY++) {
        for (let sourceX = sourceX0; sourceX < Math.min(sourceX1, sourceCols); sourceX++) {
          const index = sourceY * sourceCols + sourceX
          if ((source.material?.[index] ?? 1) <= 0) continue
          material = true
          const value = Number(source.values[index] ?? 0)
          if (Number.isFinite(value)) raw = Math.max(raw, value)
        }
      }
      sampledMax = Math.max(sampledMax, raw)
      // 分析栅格以底边为第 0 行，SVG 则以顶边为第 0 行。
      rawCells.push({ x: col, y: rows - row - 1, density: 0, material, raw })
    }
  }

  const maxValue = source.maxValue && source.maxValue > 0 ? source.maxValue : sampledMax
  return {
    cols,
    rows,
    cells: rawCells.map(({ raw, ...cell }) => ({
      ...cell,
      density: maxValue > 0 ? clampRatio(raw / maxValue) : 0,
    })),
  }
}

const densityColor = (density: number): string => {
  if (density <= 0) return 'rgba(73, 91, 122, .56)'
  const hue = density <= 0.5
    ? 174 - density * 252
    : 48 - (density - 0.5) * 96
  return `hsla(${hue}, 82%, 61%, ${0.64 + density * 0.3})`
}

export function OcclusionPreviewPanel({
  report,
  mode,
  onModeChange,
  overlayEnabled,
  onOverlayEnabledChange,
  textureVisibilityRatio,
  heatmap,
  className = '',
}: OcclusionPreviewPanelProps) {
  const sampledHeatmap = useMemo(
    () => sampleHeatmap(heatmap ?? reportHeatmap(report)),
    [heatmap, report],
  )
  const ratio = clampRatio(report?.occlusionRatio ?? 0)
  const visibleRatio = clampRatio(report?.visibleExposureRatio ?? 0)
  const resolvedTextureVisibility = clampRatio(textureVisibilityRatio ?? report?.textureVisibleRatio ?? report?.visibleExposureRatio ?? 0)
  const policy = evaluateOcclusionPolicy(ratio, mode)
  const band = report ? {
    label: policy.ratingLabel,
    tone: policy.rating === 'overcrowded' ? 'danger'
      : policy.rating === 'storage-first' ? 'storage'
        : policy.rating === 'display-first' ? 'display'
          : 'balanced',
  } : { label: '等待分析', tone: 'empty' }
  const activeMode = MODES.find(item => item.id === mode) ?? MODES[1]
  const rootClassName = ['occlusion-preview-panel', className].filter(Boolean).join(' ')
  const ringStyle = {
    '--occlusion-value': percent(ratio, 1),
    '--occlusion-color': band.tone === 'danger' ? '#ff7180' : band.tone === 'storage' ? '#f2b45f' : '#59dec9',
  } as CSSProperties

  return (
    <section className={rootClassName} aria-label="遮挡预览">
      <header className="occlusion-head">
        <span className="occlusion-head-icon" aria-hidden="true">◫</span>
        <span className="occlusion-head-copy">
          <strong>遮挡预览</strong>
          <small>板面、配件与纹理的组合评估</small>
        </span>
        <button
          className={`occlusion-overlay-switch${overlayEnabled ? ' is-on' : ''}`}
          type="button"
          role="switch"
          aria-checked={overlayEnabled}
          onClick={() => onOverlayEnabledChange(!overlayEnabled)}
        >
          <span aria-hidden="true" />
          视口热力层
        </button>
      </header>

      <div className="occlusion-mode-group" role="group" aria-label="布局目标模式">
        {MODES.map(item => (
          <button
            key={item.id}
            className={item.id === mode ? 'is-active' : ''}
            type="button"
            aria-pressed={item.id === mode}
            onClick={() => onModeChange(item.id)}
          >
            <strong>{item.label}</strong>
            <small>{item.target}</small>
          </button>
        ))}
      </div>

      {!report ? (
        <div className="occlusion-empty" role="status">
          <span aria-hidden="true">◎</span>
          <strong>等待装配数据</strong>
          <small>完成分板并放置配件后，这里会显示遮挡率与密度分布。</small>
        </div>
      ) : (
        <>
          <div className="occlusion-overview">
            <div className="occlusion-ring" style={ringStyle} aria-label={`总遮挡率 ${percent(ratio, 1)}`}>
              <span><strong>{percent(ratio, 1)}</strong><small>总遮挡率</small></span>
            </div>
            <div className="occlusion-overview-copy">
              <span className={`occlusion-band is-${band.tone}`}>{band.label}</span>
              <strong>{policy.statusLabel}</strong>
              <small>{activeMode.label}模式 · {policy.hint} · 目标 {activeMode.target}</small>
            </div>
          </div>

          <div className="occlusion-mini-metrics">
            <article>
              <span>可见面保留率</span>
              <strong>{percent(visibleRatio, 1)}</strong>
              <i><b style={{ width: percent(visibleRatio, 1) }} /></i>
            </article>
            <article>
              <span>纹理可见度</span>
              <strong>{percent(resolvedTextureVisibility, 1)}</strong>
              <i><b style={{ width: percent(resolvedTextureVisibility, 1) }} /></i>
              {textureVisibilityRatio == null && <small>按板面曝光估算</small>}
            </article>
          </div>

          <section className="occlusion-section" aria-labelledby="occlusion-zone-title">
            <div className="occlusion-section-title">
              <span><strong id="occlusion-zone-title">三区遮挡</strong><small>占比 / 区内配件</small></span>
              <em>{report.footprints.length - report.backPartCount} 件正面配件</em>
            </div>
            <div className="occlusion-zone-list">
              {[...report.zones].reverse().map(zone => (
                <article key={zone.id}>
                  <span className={`occlusion-zone-dot is-${zone.id}`} aria-hidden="true" />
                  <span className="occlusion-zone-copy">
                    <b>{zone.label}</b>
                    <i><u style={{ width: percent(zone.ratio, 1) }} /></i>
                  </span>
                  <span className="occlusion-zone-value">
                    <strong>{percent(zone.ratio, 1)}</strong>
                    <small>{zone.partCount} 件</small>
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="occlusion-section" aria-labelledby="occlusion-heatmap-title">
            <div className="occlusion-section-title">
              <span><strong id="occlusion-heatmap-title">配件密度热力图</strong><small>重叠数量经降采样显示</small></span>
              <em>{Number.isInteger(report.cellSize) ? report.cellSize : report.cellSize.toFixed(1)} mm 栅格</em>
            </div>
            {sampledHeatmap ? (
              <div className={`occlusion-heatmap${overlayEnabled ? ' is-linked' : ''}`}>
                <svg
                  viewBox={`0 0 ${sampledHeatmap.cols} ${sampledHeatmap.rows}`}
                  role="img"
                  aria-label="板面配件密度分布，冷色较疏，暖色较密"
                  preserveAspectRatio="none"
                >
                  {sampledHeatmap.cells.filter(cell => cell.material).map(cell => (
                    <rect
                      key={`${cell.x}-${cell.y}`}
                      x={cell.x + 0.04}
                      y={cell.y + 0.04}
                      width={0.92}
                      height={0.92}
                      rx={0.08}
                      fill={densityColor(cell.density)}
                    />
                  ))}
                </svg>
                <div className="occlusion-heatmap-legend" aria-hidden="true">
                  <span>疏</span><i /><span>密</span>
                </div>
              </div>
            ) : (
              <div className="occlusion-heatmap-missing">当前报告没有可显示的栅格</div>
            )}
          </section>

          {report.unknownFootprintCount > 0 && (
            <div className="occlusion-warning" role="note">
              <span aria-hidden="true">!</span>
              <p><strong>{report.unknownFootprintCount} 件配件缺少尺寸</strong><small>当前遮挡率未包含这些配件，结果可能偏低。</small></p>
            </div>
          )}

          {report.backPartCount > 0 && (
            <p className="occlusion-footnote">背面配件 {report.backPartCount} 件，不计入正面纹理遮挡。</p>
          )}
        </>
      )}
    </section>
  )
}
