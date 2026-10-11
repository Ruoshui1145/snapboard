import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { buildSurfaceMarkingPlan, isThroughLatticePanel } from '../../utils/assemblyMarking'
import type { SplitPanel } from '../../types/geometry'
import './AssemblyMarkingPanel.css'

const EMPTY_SPLIT_PANELS: SplitPanel[] = []
export function AssemblyMarkingPanel({ expanded = false, onPreview }: { expanded?: boolean; onPreview?: () => void }) {
  const [open, setOpen] = useState(expanded)
  const marking = useAppStore(s => s.assemblyMarking)
  const texture = useAppStore(s => s.boardTexture)
  const setMarking = useAppStore(s => s.setAssemblyMarking)
  const panels = useAppStore(s => s.splitResult?.panels) ?? EMPTY_SPLIT_PANELS
  const cfg = useAppStore(s => s.splitConfig)
  const name = useAppStore(s => s.project.metadata.name)
  const setUI = useAppStore(s => s.setUI)
  const backChecked = marking.backEngravingEnabled ?? !texture.backEnabled
  const dual = !!texture.enabled && !!texture.backEnabled
  const throughOnly = panels.length > 0 && panels.every(isThroughLatticePanel)
  const plan = useMemo(() => buildSurfaceMarkingPlan(panels, cfg, marking, texture, name), [panels, cfg, marking, texture, name])
  const numbers = (key: 'depth' | 'textHeight' | 'clearance' | 'sideDepth' | 'sideTextHeight', label: string, min: number, max: number, fallback: number) =>
    <label><span>{label}</span><span className="assembly-marking-number"><input key={String(marking[key])} type="text" inputMode="decimal"
      aria-label={label} defaultValue={marking[key] ?? fallback}
      onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.value = String(marking[key] ?? fallback); e.currentTarget.blur() } else if (e.key === 'Enter') e.currentTarget.blur() }}
      onBlur={e => { const raw = e.currentTarget.value.trim(); const n = Number(raw); if (raw && Number.isFinite(n)) setMarking({ [key]: Math.max(min, Math.min(max, n)) }); else e.currentTarget.value = String(marking[key] ?? fallback) }} /><i>mm</i></span></label>
  const preview = () => {
    onPreview?.()
    setUI({ viewMode: '3d', ...(texture.backEnabled ? { textureEditSide: 'back' as const } : {}) })
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('snapboard:set-view-preset', { detail: { preset: 'back' } })), 120)
  }
  return <section className={`assembly-marking-panel${marking.enabled ? ' enabled' : ''}${open ? ' open' : ''}`}>
    <div className="assembly-marking-summary">
      <button type="button" className="assembly-marking-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="assembly-marking-icon">号</span><span><b>装配编号</b><small>板号与拼接标识 · 仅背面装配</small></span><i>{open ? '⌃' : '⌄'}</i>
      </button>
      <label className="assembly-marking-master"><input type="checkbox" checked={marking.enabled} onChange={e => setMarking({ enabled: e.target.checked })} /><span>{marking.enabled ? '已启用' : '已暂停'}</span></label>
    </div>
    {open && <div className="assembly-marking-body">
      <fieldset className="assembly-marking-scope">
        <div className="assembly-marking-section"><strong>背面装配标识</strong>
          <p>背面可用时凹刻 P01 板号与拼接边对应标识；没有可用背面就跳过装配背刻。订单号在制造导出中选择，并只刻在侧面。</p>
          <small>编号规划：背面 {plan.panels.filter(p=>p.numberMark?.surface==='back').length} · 承托层 {plan.panels.filter(p=>p.numberMark?.surface==='pocket').length}</small></div>
        <div className="assembly-marking-options"><label><input type="checkbox" checked={marking.includePanelIds} onChange={e=>setMarking({includePanelIds:e.target.checked})}/>板号 P01</label><label><input type="checkbox" checked={marking.includeOrientation} onChange={e=>setMarking({includeOrientation:e.target.checked})}/>朝向</label></div>
        <details open={expanded}><summary>背刻、侧刻与字形设置</summary>
        <div className="assembly-marking-fields"><label><span>共用品牌字样</span><input key={marking.brand} defaultValue={marking.brand} maxLength={14} aria-label="共用品牌字样"
          onBlur={e => setMarking({ brand: e.target.value.toUpperCase().replace(/[^A-Z0-9._-]/g, '') || 'SNAPBOARD' })} /></label></div>
        <div className="assembly-marking-section">
          <label className="assembly-marking-choice"><input type="checkbox" checked={backChecked && !throughOnly} disabled={throughOnly} onChange={e => setMarking({ backEngravingEnabled: e.target.checked })} /><b>背面凹刻</b><small>{throughOnly ? '无可用背面，跳过装配背刻' : !texture.backEnabled ? '有实体背面时使用' : '需要标识留白区'}</small></label>
          {backChecked && !throughOnly && <>
            {dual && <label className="assembly-marking-choice"><input type="checkbox" checked={!!marking.reserveBackMarking} onChange={e => setMarking({ reserveBackMarking: e.target.checked })} /><span>使用推荐背面标识留白区</span></label>}
            {dual && !marking.reserveBackMarking && <p role="alert" className="assembly-marking-warning">先选择标识留白区，再生成背面凹刻；背图不会直接被刻字覆盖。</p>}
            <div className="assembly-marking-fields">
              {numbers('depth', '背面刻深', .16, .4, .3)}{numbers('textHeight', '背面字高', 4.2, 8, 4.8)}{numbers('clearance', '背面安全净距', 2, 8, 3)}
            </div>
            <div className="assembly-marking-options">{([
              ['includeSeamIds', '拼接配对（短数字）'],
            ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={marking[key]} onChange={e => setMarking({ [key]: e.target.checked })} />{label}</label>)}</div>
            <button type="button" className="assembly-marking-preview" disabled={!panels.length} onClick={preview}>查看背面标识与留白区</button>
          </>}
        </div>
        <div className="assembly-marking-section">
          <strong>侧刻参数</strong>
          <div className="assembly-marking-fields">
            {numbers('sideDepth', '侧边刻深', .12, .4, .24)}{numbers('sideTextHeight', '侧边字高', 2.1, 8, 3.5)}
          </div>
          <p>侧刻需要连续的实体侧壁，现有算法要求板厚至少 4 mm；长度或安全空间不足会停止，不添加背壳。订单侧刻沿用这些字高与刻深；侧面输出完整订单号，板号与拼接标识保留在背面。</p>
          <label className="assembly-marking-choice"><input type="checkbox" checked={marking.sideLogoEnabled} onChange={e => setMarking({ sideLogoEnabled: e.target.checked })} /><b>附加侧边品牌</b><small>品牌与板号独立</small></label>
          {marking.sideLogoEnabled && <p>字高按倒角后的可用侧壁限制，两端避让圆角；字样不会突出拼接边。空间不足用 SB 或跳过。</p>}
        </div>
        </details>
      </fieldset>
      {!expanded && <button type="button" className="assembly-marking-preview" onClick={() => window.dispatchEvent(new CustomEvent('snapboard:open-settings', { detail: { tab: 'marking' } }))}>打开编号与刻字设置</button>}
      <small>{plan.panels.filter(p=>p.numberMark).length} / {panels.length} 块已有编号位置 · {plan.seams.length} 条拼接关系；实际写入结果以导出汇总为准</small>
      {plan.warnings.length > 0 && <p className="assembly-marking-warning">{plan.warnings[0]}</p>}
    </div>}
  </section>
}
