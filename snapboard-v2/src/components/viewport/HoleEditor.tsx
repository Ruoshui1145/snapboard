import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { panelHoleEntries, sameHole, type HoleMode } from '../../utils/holeEditing'
import './hole-editor.css'

export function HoleEditor({ toolbar = false, onOpen }: { toolbar?: boolean; onOpen?: () => void }) {
  const enabled = useAppStore(s => s.holeEditMode), selected = useAppStore(s => s.selectedHole)
  const split = useAppStore(s => s.splitResult), spatial = useAppStore(s => s.spatialLayout)
  const cfg = useAppStore(s => s.splitConfig)
  const spatialCount = useAppStore(s => s.spatialPreviewCount)
  const [error, setError] = useState('')
  useEffect(() => setError(''), [selected])
  if (!split?.panels.length && !spatial.enabled) return null
  if (toolbar) return <button type="button" className={`hole-editor-toggle${enabled ? ' is-active' : ''}`} aria-pressed={enabled}
    onClick={() => { if (!enabled) onOpen?.(); useAppStore.getState().setHoleEditMode(!enabled) }}>
    {enabled ? '完成孔位编辑' : '单孔编辑'}</button>
  if (!enabled) return null
  const panel = selected?.spatialKey ? selected.panel : split?.panels.find(item => item.id === selected?.panel.id && item.x === selected.panel.x && item.y === selected.panel.y)
  const entry = panel && selected ? panelHoleEntries(panel).find(item => sameHole(item.hole, selected.x, selected.y)) : null
  const mode = selected?.spatialKey ? spatial.holeTypeOverrides?.[selected.spatialKey] ?? entry?.mode : entry?.mode
  const updating = Boolean(selected?.spatialKey && spatialCount?.key !== JSON.stringify([spatial, cfg]))
  const change = (next: HoleMode | 'restore') => {
    try { useAppStore.getState().editSelectedHole(next); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '孔位修改失败') }
  }
  return <aside className="hole-editor" aria-label="单孔编辑" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    {enabled && <div className="hole-editor-controls">
      <strong>{selected && entry ? `已选 ${selected.spatialFace ? `面片 ${selected.spatialFace.id.replace('face-', 'F')}` : panel!.id.toUpperCase()} 的孔` : '点击一个长孔、圆孔或虚线孔位'}</strong>
      {selected && entry && <>
        <small>孔心 {selected.x.toFixed(2)}, {selected.y.toFixed(2)} mm</small>
        <div className="hole-editor-modes" role="group" aria-label="选中孔的类型">
          {([['slot', '长孔'], ['round', '圆孔'], ['closed', '关闭']] as const).map(([value, text]) => <button key={value} type="button"
            disabled={updating} aria-pressed={mode === value} className={mode === value ? 'is-active' : ''} onClick={() => change(value)}>{text}</button>)}
          <button type="button" disabled={updating} onClick={() => change('restore')}>恢复原孔</button>
        </div>
        <small>长孔 {cfg.slotWidth} × {cfg.slotLength} mm · 圆孔 Ø{cfg.jointDiameter} mm · 孔心保持不变 · 支持撤销</small>
      </>}
      {updating && <small role="status">正在更新孔位…</small>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </aside>
}
