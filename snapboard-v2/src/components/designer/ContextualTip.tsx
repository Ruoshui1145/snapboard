import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { getAssemblyHostPreset } from '../../assembly/hostCatalog'

const tips = [
  { key: 'empty-canvas', text: '从左侧选择创建方式，完成轮廓后点击“生成板件”。', match: (state: TipState) => state.contours === 0 },
  { key: 'split-ready', text: '在“板材”工作区查看尺寸与孔位，再添加外观或配件。', match: (state: TipState) => state.hasSplit },
  { key: 'enter-3d', text: '切到 3D 后，从配件库把挂钩或托盘拖入板面。', match: (state: TipState) => state.viewMode === '3d' && !state.hasParts && state.hostPresetId === 'snapboard-pegboard-v1' },
  { key: 'part-placed', text: '配件会按孔型、轴向和占孔状态自动吸附。', match: (state: TipState) => state.hasParts },
]

interface TipState { contours: number; hasSplit: boolean; viewMode: '2d' | '3d'; hasParts: boolean; hostPresetId: string }

export function ContextualTip() {
  const project = useAppStore(s => s.project)
  const splitResult = useAppStore(s => s.splitResult)
  const viewMode = useAppStore(s => s.ui.viewMode)
  const hasParts = useAppStore(s => s.placedParts.length > 0)
  const hostPresetId = useAppStore(s => s.assemblyScene.hostPresetId ?? 'snapboard-pegboard-v1')
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const contours = project.parts.flatMap(part => part.features).filter(feature => feature.type === 'sketch')
    .reduce((count, feature) => count + (feature.type === 'sketch' ? feature.contours.length : 0), 0)

  const tip = useMemo(() => {
    const state: TipState = { contours, hasSplit: Boolean(splitResult?.panels.length), viewMode, hasParts, hostPresetId }
    const hostPreset = getAssemblyHostPreset(hostPresetId)
    const candidates = viewMode === '3d' && hostPresetId !== 'snapboard-pegboard-v1' && hostPreset
      ? [{ key: `host-${hostPresetId}`, text: `${hostPreset.label}已载入；拖入零件前请先标定兼容的${hostPreset.kind === 'rail-clip' ? '导轨卡扣' : hostPreset.kind === 't-slot' ? '型材槽连接器' : '墙面底座'}。`, match: () => true }, ...tips]
      : tips
    return candidates.find(candidate => {
      if (candidate.key === dismissedKey || !candidate.match(state)) return false
      try { return localStorage.getItem(`snapboard-tip-${candidate.key}`) !== '1' } catch { return true }
    }) ?? null
  }, [contours, dismissedKey, hasParts, hostPresetId, splitResult, viewMode])

  useEffect(() => {
    if (!tip) return
    try { localStorage.setItem(`snapboard-tip-${tip.key}`, '1') } catch { /* ignore */ }
  }, [tip])

  if (!tip) return null
  return <aside className="designer-context-tip" role="status"><span>💡 {tip.text}</span><button type="button" onClick={() => setDismissedKey(tip.key)} aria-label="关闭提示">×</button></aside>
}
