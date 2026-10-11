import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

const STORAGE_KEY = 'snapboard-onboarding-dismissed'
const EXPORT_KEY = 'snapboard-onboarding-exported'

interface Props {
  onDismiss(): void
}

/** 首启清单只提示核心路径，不阻断画布，也不做强制功能巡演。 */
export function OnboardingChecklist({ onDismiss }: Props) {
  const project = useAppStore(s => s.project)
  const splitResult = useAppStore(s => s.splitResult)
  const viewMode = useAppStore(s => s.ui.viewMode)
  const placedParts = useAppStore(s => s.placedParts)
  const [exported, setExported] = useState(() => {
    try { return localStorage.getItem(EXPORT_KEY) === '1' } catch { return false }
  })
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const onExport = () => {
      try { localStorage.setItem(EXPORT_KEY, '1') } catch { /* 本地存储不可用时仍更新当前会话 */ }
      setExported(true)
    }
    window.addEventListener('snapboard:export-complete', onExport)
    return () => window.removeEventListener('snapboard:export-complete', onExport)
  }, [])

  const hasClosedContour = project.parts.some(part => part.features.some(feature =>
    feature.type === 'sketch' && feature.contours.some(contour => contour.type === 'outer' && contour.closed)))
  const tasks = useMemo(() => [
    { label: '画一个闭合外轮廓', done: hasClosedContour },
    { label: '执行自动分割', done: Boolean(splitResult?.panels.length) },
    { label: '切换到 3D 视图', done: viewMode === '3d' },
    { label: '拖入一个配件', done: placedParts.length > 0 },
    { label: '导出一个 3MF', done: exported },
  ], [exported, hasClosedContour, placedParts.length, splitResult, viewMode])
  const doneCount = tasks.filter(task => task.done).length

  let dismissed = false
  try { dismissed = localStorage.getItem(STORAGE_KEY) === '1' } catch { /* ignore */ }
  if (dismissed || hidden) return null

  const dismiss = () => {
    setHidden(true)
    onDismiss()
  }

  return (
    <aside className="onboarding-card" aria-label="首次使用清单">
      <div className="onboarding-head">
        <div><strong>开始使用 SnapBoard</strong><small>完成一条从设计到打印的核心路径</small></div>
        <button type="button" onClick={dismiss} aria-label="关闭首次使用清单">×</button>
      </div>
      <div className="onboarding-progress"><i style={{ width: `${doneCount / tasks.length * 100}%` }} /></div>
      <ol>
        {tasks.map((task, index) => <li key={task.label} className={task.done ? 'done' : ''}><span>{task.done ? '✓' : index + 1}</span>{task.label}</li>)}
      </ol>
      <button type="button" className="onboarding-dismiss" onClick={dismiss}>{doneCount === tasks.length ? '完成并关闭' : '稍后再看'}</button>
    </aside>
  )
}
