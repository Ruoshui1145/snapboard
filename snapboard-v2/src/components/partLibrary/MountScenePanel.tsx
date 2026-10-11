import { getAssemblyHostPreset } from '../../assembly/hostCatalog'
import { useAppStore } from '../../store/useAppStore'
import { usePartLibrary } from '../../hooks/usePartLibrary'
import { useAssemblyLibrary } from '../../hooks/useAssemblyLibrary'

const STATUS_LABELS = {
  available: '可用',
  experimental: '实验场景',
  planned: '待补连接器',
} as const

/** 配件库上方的安装宿主选择。场景随工程保存，不会删除其他场景的装配数据。 */
export function MountScenePanel() {
  const scene = useAppStore(state => state.assemblyScene)
  const setAssemblyScene = useAppStore(state => state.setAssemblyScene)
  const setUI = useAppStore(state => state.setUI)
  const { index } = usePartLibrary()
  const assemblyLibrary = useAssemblyLibrary()
  const selectedId = scene.hostPresetId ?? 'snapboard-pegboard-v1'
  const preset = assemblyLibrary.hosts.find(item => item.id === selectedId)
    ?? getAssemblyHostPreset(selectedId)
    ?? assemblyLibrary.hosts[0]
  const compatiblePartCount = (index?.parts ?? []).filter(part =>
    part.mountConnectors?.some(connector => connector.kind === preset.kind)
    || (preset.kind === 'hole-pattern' && typeof part.mount === 'object' && part.mount.anchors.length > 0),
  ).length

  const selectPreset = (nextId: string) => {
    setAssemblyScene({ hostPresetId: nextId })
    setUI({ viewMode: '3d', selectedPartId: null })
  }

  return (
    <section className="mount-scene-panel" aria-label="装配流程第1步：安装到">
      <div className="mount-scene-heading">
        <span className="lib-step-index">1</span>
        <div><b>安装到</b><small>确定零件要连接的宿主</small></div>
        {preset.status !== 'available' && <em className={`status-${preset.status}`}>{STATUS_LABELS[preset.status]}</em>}
      </div>
      <select value={selectedId} onChange={event => selectPreset(event.target.value)} aria-label="选择安装宿主">
        {assemblyLibrary.hosts.map(item => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
      <div className="mount-scene-summary" title={preset.summary}>
        <span className={compatiblePartCount ? 'ready' : ''}>{compatiblePartCount ? `✓ ${compatiblePartCount} 个配件已适配` : '暂无已适配配件'}</span>
        <small>{preset.status === 'available' ? '切换宿主后会自动更新列表' : '可浏览全部零件并补充当前场景标定'}</small>
      </div>
    </section>
  )
}
