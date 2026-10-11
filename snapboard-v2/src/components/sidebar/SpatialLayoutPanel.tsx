import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { resolveSpatialManufacturing } from '../../utils/spatialManufacturingPlan'
import { spatialHeightLimit, type SpatialLayoutConfig } from '../../utils/spatialLayout'
import { BAMBU_PRINTER_PRESETS, splitConfigForPrinter } from '../../utils/bambuPrinterPresets'
import './sidebar-fields.css'

function NumberField({ label, value, min, max, onCommit }: {
  label: string; value: number; min: number; max?: number; onCommit(value: number): void
}) {
  const [draft, setDraft] = useState(String(value))
  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() && Number.isFinite(parsed) && parsed >= min && (max === undefined || parsed <= max)) onCommit(parsed)
    // An already aligned value may leave the store unchanged; discard the unsnapped draft too.
    setDraft(String(value))
  }
  return <label>{label}<input type="number" min={min} max={max} step="any" value={draft}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur()
      if (event.key === 'Escape') { setDraft(String(value)); event.currentTarget.blur() }
    }} /></label>
}

export function SpatialManufacturingPanel() {
  const config = useAppStore(state => state.spatialLayout)
  const cfg = useAppStore(state => state.splitConfig)
  const setLayout = useAppStore(state => state.setSpatialLayout)
  const setSplitConfig = useAppStore(state => state.setSplitConfig)
  const setUI = useAppStore(state => state.setUI)
  const previewCount = useAppStore(state => state.spatialPreviewCount)
  const plan = useMemo(() => {
    try { return { result: resolveSpatialManufacturing(config, cfg), error: '' } }
    catch (error) { return { result: null, error: error instanceof Error ? error.message : String(error) } }
  }, [config, cfg])
  const previewKey = JSON.stringify([config, cfg])
  const update = (partial: Partial<SpatialLayoutConfig>) => setLayout(partial)
  return <section className="spatial-layout-panel" aria-label="立体制造方案">
      <h3>制造方案</h3>
      <p>形态在左栏设计，这里决定如何打印与装配。</p>
      <label>连接方式<select value={plan.result?.layout.template === 'cylinder' || config.manufacturingMode === 'auto' ? 'monolithic' : config.manufacturingMode === 'per-face' ? 'bed-split' : config.manufacturingMode}
        onChange={event => update({ manufacturingMode: event.target.value as SpatialLayoutConfig['manufacturingMode'] })}>
        <option value="monolithic">折弯立体打印 · 超限自动切分</option>
        {plan.result?.layout.template !== 'cylinder' && <option value="bed-split">分件＋外置连接件</option>}
      </select></label>
      <label>打印机<select value={cfg.printerPreset || 'bambu-p1s'} onChange={event => {
        const value = event.target.value
        setSplitConfig(value === 'custom' ? { printerPreset: 'custom', bedKeepouts: [] }
          : splitConfigForPrinter(value))
      }}>
        <option value="custom">自定义</option>
        {BAMBU_PRINTER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      </select></label>
      <NumberField key={`edge-bevel-${cfg.manufacturingChamfer}`} label="外缘/孔口倒角 mm"
        value={cfg.manufacturingChamfer} min={0} max={Math.min(cfg.thickness / 3, cfg.slotWidth / 4)}
        onCommit={manufacturingChamfer => setSplitConfig({ manufacturingChamfer })} />
      <label className="spatial-layout-switch"><input type="checkbox" checked={cfg.recommendKnockouts}
        onChange={event => setSplitConfig({ recommendKnockouts: event.target.checked })} />自动打开接缝推荐圆孔</label>
      <NumberField key={`safe-${config.printSafetyMarginMm}`} label="打印空间安全留边 mm"
        value={config.printSafetyMarginMm} min={0} max={25}
        onCommit={printSafetyMarginMm => update({ printSafetyMarginMm })} />
      {plan.result && <p>安全可用空间：{plan.result.printBounds.width.toFixed(1)} × {plan.result.printBounds.height.toFixed(1)} × {Math.max(0, plan.result.printHeight).toFixed(1)} mm</p>}
      {cfg.printerPreset === 'custom' && <div className="spatial-layout-grid">
        <NumberField key={`bw-${cfg.bedW}`} label="热床宽 mm" value={cfg.bedW} min={40} max={2000} onCommit={bedW => setSplitConfig({ bedW })} />
        <NumberField key={`bh-${cfg.bedH}`} label="热床深 mm" value={cfg.bedH} min={40} max={2000} onCommit={bedH => setSplitConfig({ bedH })} />
      </div>}
      {cfg.printerPreset === 'custom' && <NumberField key={`bz-${config.customPrintHeight}`} label="自定义打印高度 mm" value={config.customPrintHeight}
        min={20} max={5000} onCommit={customPrintHeight => update({ customPrintHeight })} />}
      {plan.result?.mode !== 'monolithic' && <><label className="spatial-layout-switch"><input type="checkbox" checked={config.printedAngleConnector}
        onChange={event => update({ printedAngleConnector: event.target.checked })} />临时定角连接件（自绘件完成后替换）</label>
      {config.printedAngleConnector && <NumberField key={`nut-${config.connectorClearanceMm}`} label="M3 螺母嵌槽余量 mm"
        value={config.connectorClearanceMm} min={0.1} max={0.7}
        onCommit={connectorClearanceMm => update({ connectorClearanceMm })} />}
      </>}
      {plan.result?.mode === 'monolithic' && <p>{plan.result.sectionCount > 1
        ? `高度按孔阵分为 ${plan.result.sectionCount} 节，单节不超过 ${spatialHeightLimit(plan.result.printHeight, cfg).toFixed(1)} mm；横向超床时继续切成独立制造件，保留实际折弯形状。`
        : plan.result.needsBedSplit ? '主宽/侧深超出安全床面，将保留折弯形状并自动切成独立立体件。'
        : '当前尺寸可整件打印；超过安全床面或高度时自动切分。'}</p>}
      <p role="status" className={plan.error || plan.result?.error ? 'spatial-layout-error' : 'spatial-layout-status'}>
        {plan.error || plan.result?.error || `当前选择：${{ monolithic: '折弯立体件', 'per-face': '外置连接件', 'bed-split': '外置连接件' }[plan.result!.mode]} · ${plan.result!.layout.faces.length} 个设计面 · ${previewCount?.key === previewKey ? `${previewCount.count} 个独立制造件` : '正在计算件数'}`}
      </p>
      <button type="button" onClick={() => setUI({ viewMode: '3d' })}>查看立体版面</button>
      {previewCount?.key === previewKey && previewCount.count > 1 && <p>预览保持完整装配外形，以颜色区分制造件；导出按实际切分逐件输出，新分件接口的连接件待适配。</p>}
      <p>立体制造暂不映射旧平面配件和图片；原内容保留在平面版面。</p>
  </section>
}

export function SpatialLayoutDesignPanel() {
  const config = useAppStore(state => state.spatialLayout)
  const edgeInset = useAppStore(state => state.splitConfig.jointOffsetX)
  const setLayout = useAppStore(state => state.setSpatialLayout)
  const update = (partial: Partial<SpatialLayoutConfig>) => setLayout(partial)
  return <section className="spatial-layout-panel spatial-design-settings" aria-label="立体形态设计">
    <h3>立体形态</h3>
    <p>先确定各面尺寸与转角；面片列表在下方，可点击聚焦。</p>
    <label>形态<select value={config.template} onChange={event => update({ template: event.target.value as SpatialLayoutConfig['template'] })}>
      <option value="L">L 型</option><option value="U">U 型</option><option value="prism">多边形棱柱（上下无盖）</option>
      <option value="cylinder">圆筒（上下无盖）</option>
    </select></label>
    {config.template === 'prism' && <>
      <div className="spatial-layout-grid">{[3, 4, 6].map(sides => <button key={sides} type="button"
        aria-pressed={config.polygonSides === sides} onClick={() => update({ polygonSides: sides })}>{sides} 边形</button>)}</div>
      <NumberField key={`sides-${config.polygonSides}`} label="多边形边数" value={config.polygonSides} min={3}
        onCommit={polygonSides => { if (Number.isSafeInteger(polygonSides)) update({ polygonSides }) }} />
      <p>三边形沿用主宽/侧深；四边及以上为正多边形。单边过短时使用连续圆筒曲面，避免细碎板条。</p>
    </>}
    <div className="spatial-layout-grid">
      <NumberField key={`w-${config.width}-${config.template}-${config.polygonSides}`}
        label={config.template === 'cylinder' ? '圆筒中线直径 mm' : config.template === 'prism' && config.polygonSides > 3 ? '横向跨度 mm' : '主宽 mm'}
        value={config.width} min={config.template === 'L' ? 25 : 60} max={5000} onCommit={width => update({ width })} />
      {(config.template === 'L' || config.template === 'U' || config.template === 'prism' && config.polygonSides === 3) &&
        <NumberField key={`d-${config.depth}`} label="侧深 mm" value={config.depth} min={config.template === 'L' ? 25 : 60} max={5000} onCommit={depth => update({ depth })} />}
      <NumberField key={`h-${config.height}`} label="高度 mm" value={config.height} min={45} max={5000} onCommit={height => update({ height })} />
      {config.template === 'L' && <NumberField key={`a-${config.angleDegrees}`} label="内夹角 °" value={config.angleDegrees} min={45} max={150}
        onCommit={angleDegrees => update({ angleDegrees })} />}
    </div>
    {config.template !== 'cylinder' && <>
      <label>一体转角处理<select value={config.bendStyle} onChange={event => update({ bendStyle: event.target.value as SpatialLayoutConfig['bendStyle'] })}>
        <option value="round">恒厚圆弧转角</option><option value="chamfer">斜面倒角</option>
      </select></label>
      <NumberField key={`bend-${config.bendSizeMm}`} label={config.bendStyle === 'round' ? '转角内圆角 R mm' : '转角倒角尺寸 mm'}
        value={config.bendSizeMm} min={0} max={80} onCommit={bendSizeMm => update({ bendSizeMm })} />
      {config.template === 'L' && <NumberField key={`hole-inset-${config.cornerHoleInsetMm}`} label="转角到最近孔列 mm"
        value={config.cornerHoleInsetMm} min={5} max={120} onCommit={cornerHoleInsetMm => update({ cornerHoleInsetMm })} />}
      {config.template === 'L' && <p>两侧最近列同步调整：长孔和圆孔同列交替，同类孔保持 40 mm 节距。</p>}
      {config.template === 'L' && <p>自由拼接边距孔心 {edgeInset} mm，与平面板一致；主宽/侧深随孔阵自动修齐，保留设定的转角孔距。</p>}
    </>}
  </section>
}
