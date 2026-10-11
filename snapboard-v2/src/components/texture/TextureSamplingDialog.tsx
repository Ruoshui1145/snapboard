import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SplitPanel } from '../../types/geometry'
import { samplingPanelKey, type LastTextureSampling, type TextureSamplingOptions } from '../../utils/textureSampling'
import './TextureSamplingDialog.css'

export interface TextureSamplingDialogProps {
  panels: SplitPanel[]
  lastSampling?: LastTextureSampling | null
  onClose(): void
  onExport(options: TextureSamplingOptions): void
  onCancelExport?(): void
  onExportOriginal?(): void
  busy?: boolean
  /** Full board texture, top-down, fitted to the global bounds of panels. */
  previewImage?: string
}

const outline = (panel: SplitPanel) => panel.contour?.length
  ? panel.contour
  : [{ x: panel.x, y: panel.y }, { x: panel.x + panel.w, y: panel.y },
    { x: panel.x + panel.w, y: panel.y + panel.h }, { x: panel.x, y: panel.y + panel.h }]

export function TextureSamplingDialog({ panels, lastSampling, onClose, onExport, onCancelExport, onExportOriginal, busy = false, previewImage }: TextureSamplingDialogProps) {
  const titleId = useId()
  const clipId = useId().replace(/:/g, '')
  const dialog = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(String(lastSampling?.sizeMm ?? 20))
  const [selected, setSelected] = useState(0)
  const restored = panels.map(panel => lastSampling?.locations.find(location =>
    location.panelId === panel.id && location.geometryKey === samplingPanelKey(panel)))
  const restoredCount = restored.filter(Boolean).length
  const [locations, setLocations] = useState(() => panels.map((panel, panelIndex) => ({
    panelIndex,
    x: String(restored[panelIndex]?.x ?? Number((panel.x + panel.w / 2).toFixed(2))),
    y: String(restored[panelIndex]?.y ?? Number((panel.y + panel.h / 2).toFixed(2))),
  })))
  const bounds = useMemo(() => {
    const points = panels.flatMap(outline)
    // Do not extend a non-empty board to the origin: this must match texture bounds.
    const x = points.length ? Math.min(...points.map(p => p.x)) : 0
    const y = points.length ? Math.min(...points.map(p => p.y)) : 0
    const maxX = points.length ? Math.max(...points.map(p => p.x)) : 1
    const maxY = points.length ? Math.max(...points.map(p => p.y)) : 1
    return { x, y, maxY, w: Math.max(1, maxX - x), h: Math.max(1, maxY - y) }
  }, [panels])
  const grossArea = useMemo(() => panels.reduce((sum, panel) => {
    const points = outline(panel)
    return sum + Math.abs(points.reduce((value, p, i) => {
      const next = points[(i + 1) % points.length]
      return value + p.x * next.y - next.x * p.y
    }, 0)) / 2
  }, 0), [panels])
  const sizeMm = Number(size)
  const valid = panels.length > 0 && locations.length === panels.length && size.trim() !== ''
    && Number.isFinite(sizeMm) && sizeMm >= 10 && sizeMm <= 40
    && locations.every(p => p.x.trim() !== '' && p.y.trim() !== '' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
  const sampleSize = Number.isFinite(sizeMm) && sizeMm > 0 ? sizeMm : 20
  const margin = Math.max(bounds.w, bounds.h) * 0.025
  const pathFor = (panel: SplitPanel) => [outline(panel), ...(panel.cutouts ?? [])].map(points =>
    points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${bounds.maxY - p.y}`).join(' ') + ' Z').join(' ')
  const update = (index: number, axis: 'x' | 'y', value: string) => {
    setSelected(index)
    setLocations(current => current.map((point, i) => i === index ? { ...point, [axis]: value } : point))
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => previous?.focus()
  }, [])

  return createPortal(
    <div className="texture-sampling-overlay" onClick={event => event.stopPropagation()}>
      <div className="texture-sampling-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onClose()
          if (event.key !== 'Tab') return
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
          if (!controls?.length) { event.preventDefault(); return }
          const first = controls[0], last = controls[controls.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
            event.preventDefault(); first.focus()
          }
        }}>
        <header className="texture-sampling-header">
          <div><h2 id={titleId}>纹理抽样试印</h2><p>同一 3MF 包含试样盘和完整原板盘，先仅打印试样盘，确认颜色后再打印原板盘。</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭抽样设置">×</button>
        </header>
        <div className="texture-sampling-body">
          <section className="texture-sampling-preview" aria-label="抽样位置预览">
            <p>点击板面定位；可选脸部、下巴等需要检查的区域。也可在右侧输入坐标。</p>
            <svg viewBox={`${bounds.x - margin} ${-margin} ${bounds.w + margin * 2} ${bounds.h + margin * 2}`} role="img" aria-label="所有板材与各自的方形抽样框">
              <defs><clipPath id={clipId}>{panels.map((panel, i) => <path key={i} d={pathFor(panel)} clipRule="evenodd" />)}</clipPath></defs>
              {previewImage && <image href={previewImage} x={bounds.x} y={0} width={bounds.w} height={bounds.h} preserveAspectRatio="none" clipPath={`url(#${clipId})`} />}
              {panels.map((panel, index) => <path key={index} d={pathFor(panel)} fillRule="evenodd"
                fill={previewImage ? 'transparent' : '#e2e8f0'} stroke={selected === index ? '#0e7490' : '#64748b'} strokeWidth={selected === index ? 2 : 1}
                vectorEffect="non-scaling-stroke" style={{ cursor: busy ? 'wait' : 'crosshair' }}
                onClick={event => {
                  if (busy) return
                  const svg = event.currentTarget.ownerSVGElement
                  const matrix = svg?.getScreenCTM()
                  if (!svg || !matrix) return
                  const point = svg.createSVGPoint()
                  point.x = event.clientX; point.y = event.clientY
                  const local = point.matrixTransform(matrix.inverse())
                  setSelected(index)
                  setLocations(current => current.map((p, i) => i === index ? {
                    ...p, x: String(Number(local.x.toFixed(2))), y: String(Number((bounds.maxY - local.y).toFixed(2))),
                  } : p))
                }}><title>{`第 ${index + 1} 块板：点击设置抽样中心`}</title></path>)}
              {locations.map((point, index) => {
                const x = Number(point.x), y = bounds.maxY - Number(point.y)
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null
                return <g key={index} pointerEvents="none">
                  <rect x={x - sampleSize / 2} y={y - sampleSize / 2} width={sampleSize} height={sampleSize}
                    fill="#f59e0b" fillOpacity={0.18} stroke={selected === index ? '#b45309' : '#ef4444'} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <text x={x} y={y} dominantBaseline="central" textAnchor="middle" fontSize={Math.max(bounds.w, bounds.h) / 35}
                    fill="#fff" stroke="#111827" strokeWidth={0.6} paintOrder="stroke">{index + 1}</text>
                </g>
              })}
            </svg>
            {!previewImage && <p>纹理底图尚不可用，当前显示板材轮廓。</p>}
          </section>
          <section className="texture-sampling-controls" aria-label="抽样尺寸与坐标">
            {lastSampling && <div className="texture-sampling-note" role="status">
              上次成功抽样：{lastSampling.exportedAt.slice(0, 19).replace('T', ' ')} · {lastSampling.manufacturingFile}。
              {lastSampling.checkImageFile && <> 核对图：{lastSampling.checkImageFile}。</>}
              已恢复 {restoredCount}/{panels.length} 块板的位置。
              {restoredCount !== panels.length && ' 板件形状或孔位已变化的抽样点未自动沿用，请重新确认。'}
              {restoredCount !== panels.length && <details><summary>查看上次坐标</summary>{lastSampling.locations.map(location =>
                <div key={location.sampleId}>{location.sampleId} · {location.panelId}：X {location.x.toFixed(2)} / Y {location.y.toFixed(2)} mm</div>)}</details>}
            </div>}
            <label className="texture-sampling-size">统一样块边长（mm）<input type="number" min={10} max={40} step={1} value={size} disabled={busy} onChange={e => setSize(e.target.value)} /></label>
            <div className="texture-sampling-presets">{[10, 20, 30].map(mm => <button type="button" key={mm} disabled={busy} aria-pressed={sizeMm === mm} onClick={() => setSize(String(mm))}>{mm} × {mm} mm</button>)}</div>
            <table className="texture-sampling-cost"><caption>每板一个样块的几何面积估计</caption><thead><tr><th>边长</th><th>总面积</th><th>占全部板面</th></tr></thead><tbody>{[10, 20, 30].map(mm => <tr key={mm}><td>{mm} mm</td><td>{(mm * mm * panels.length / 100).toFixed(1)} cm²</td><td>{grossArea ? (mm * mm * panels.length / grossArea * 100).toFixed(1) + '%' : '—'}</td></tr>)}</tbody></table>
            <p className="texture-sampling-note">仅按外轮廓毛面积比较，未扣孔洞。实际耗材、换色废料和机时以切片为准；缩小样块未必等比例省时。</p>
            <div className="texture-sampling-locations">{locations.map((point, index) => <fieldset key={index} className={selected === index ? 'texture-sampling-active' : ''} disabled={busy}>
              <legend>第 {index + 1} 块板 · 抽样中心</legend>
              <label>X（mm）<input type="number" step="0.1" value={point.x} onFocus={() => setSelected(index)} onChange={e => update(index, 'x', e.target.value)} /></label>
              <label>Y（mm）<input type="number" step="0.1" value={point.y} onFocus={() => setSelected(index)} onChange={e => update(index, 'y', e.target.value)} /></label>
            </fieldset>)}</div>
            <p className="texture-sampling-note">坐标为设计全局坐标，Y 向上。试样保留原比例和纹理层，背面增加凸刻编号（S01、S02…），彩色面朝向热床打印；必要时加 0.24mm 薄承托层。完整原板不变，在同一 3MF 后续盘。请选板内连续、背面有足够位置容纳编号的区域。</p>
          </section>
        </div>
        <footer className="texture-sampling-footer">
          <span role="status">{busy ? '正在生成试样＋原板 3MF…' : !valid ? '请填写每块板的有效坐标，边长须为 10–40 mm。' : `共 ${panels.length} 个试样 · ${sizeMm} × ${sizeMm} mm · 附完整原板盘`}</span>
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          {onExportOriginal && <button type="button" onClick={onExportOriginal} disabled={busy}>仅导出原板（不含试样）</button>}
          {busy && onCancelExport && <button type="button" onClick={onCancelExport}>取消生成</button>}
          <button className="texture-sampling-export" type="button" disabled={!valid || busy} onClick={() => onExport({ sizeMm, locations: locations.map(p => ({ panelIndex: p.panelIndex, x: Number(p.x), y: Number(p.y) })) })}>导出试样＋原板 3MF</button>
        </footer>
      </div>
    </div>, document.body,
  )
}
