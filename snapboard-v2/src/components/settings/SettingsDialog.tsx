import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  fetchResourceManagementSummary,
  formatResourceBytes,
  formatResourceDate,
  importAssemblyHostBundle,
  type ResourceManagementSummary,
} from '../../utils/resourceManagement'
import './SettingsDialog.css'
import { PartResourcePackImport } from '../partLibrary/PartResourcePackImport'
import { FarmCalibrationDialog } from '../texture/FarmCalibrationDialog'
import { useI18n } from '../../i18n/I18nProvider'
import { useFileDrop } from '../../hooks/useFileDrop'
import { AssemblyMarkingPanel } from '../assemblyMarking/AssemblyMarkingPanel'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  initialTab?: SettingsTab
  reduceTransparency: boolean
  onTransparencyChange: (reduce: boolean) => void
  onResetLayout: () => void
}

export type SettingsTab = 'appearance' | 'layout' | 'calibration' | 'marking' | 'overview' | 'parts' | 'assembly' | 'projects' | 'storage'

const TAB_DEFINITIONS: Array<{ id: SettingsTab; icon: string; label: string; hint: string }> = [
  { id: 'appearance', icon: '◐', label: '外观与语言', hint: '即时生效' },
  { id: 'layout', icon: '▧', label: '布局', hint: '工作台位置' },
  { id: 'calibration', icon: '◉', label: '校色管理', hint: '系统档案' },
  { id: 'marking', icon: '号', label: '编号与刻字', hint: '侧刻、背刻与订单' },
  { id: 'overview', icon: '⌁', label: '资源概览', hint: '健康状态' },
  { id: 'parts', icon: '✣', label: '配件库', hint: '配件与资源包' },
  { id: 'assembly', icon: '⌘', label: '装配宿主', hint: '场景包与验证' },
  { id: 'projects', icon: '▤', label: '项目', hint: '本地工程文件' },
  { id: 'storage', icon: '◫', label: '受控目录', hint: '文件职责与边界' },
]

const KIND_LABELS: Record<string, string> = {
  'hole-pattern': '孔阵安装',
  'rail-clip': '导轨卡扣',
  't-slot': 'T 型槽',
  'surface-pad': '墙面底座',
  unknown: '未识别',
}

const STATUS_LABELS: Record<string, string> = {
  available: '可用',
  experimental: '实验性',
  planned: '规划中',
  unknown: '未识别',
}

const plural = (count: number, unit: string) => `${count} ${unit}`

export function SettingsDialog({ open, onClose, initialTab = 'appearance', reduceTransparency, onTransparencyChange, onResetLayout }: SettingsDialogProps) {
  const { locale, setLocale } = useI18n()
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [farmOpen, setFarmOpen] = useState(false)
  const [summary, setSummary] = useState<ResourceManagementSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importingPack, setImportingPack] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const packInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const resourceTab = !['appearance', 'layout', 'calibration', 'marking'].includes(activeTab)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      setSummary(await fetchResourceManagementSummary(signal))
    } catch (reason) {
      if ((reason as DOMException).name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  const importHostPack = async (file?: File) => {
    if (!file || importingPack) return
    setImportingPack(true)
    setImportStatus('')
    try {
      const result = await importAssemblyHostBundle(file)
      setImportStatus(`已导入 ${result.packageId} · ${result.hostCount} 个宿主`)
      await refresh()
    } catch (reason) {
      setImportStatus(`导入失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setImportingPack(false)
      if (packInputRef.current) packInputRef.current.value = ''
    }
  }

  const hostPackDrop = useFileDrop(async files => {
    if (files.length !== 1) { setImportStatus('宿主数据包一次只接收一个文件'); return }
    await importHostPack(files[0])
  }, importingPack, { accept: '.json,.sbhostpack,application/json', onError: setImportStatus })

  useEffect(() => {
    if (!open) return
    setActiveTab(initialTab)
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, initialTab])

  useEffect(() => {
    if (!open || !resourceTab) return
    const controller = new AbortController()
    const frame = requestAnimationFrame(() => {
      void refresh(controller.signal)
    })
    return () => {
      cancelAnimationFrame(frame)
      controller.abort()
    }
  }, [open, refresh, resourceTab])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !farmOpen) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open, farmOpen])

  if (!open) return null

  const overview = summary?.overview
  const renderAppearance = () => <div className="settings-view">
    <div className="settings-section-heading"><h3>外观与语言</h3></div>
    <section className="settings-card settings-preference-card"><label>界面语言<select value={locale} onChange={event=>setLocale(event.target.value as typeof locale)}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label></section>
    <section className="settings-card settings-preference-card"><label><input type="checkbox" role="switch" checked={!reduceTransparency} onChange={event=>onTransparencyChange(!event.target.checked)}/>启用半透明效果</label><p>浮动菜单和栏头使用柔和透光；关闭后改用实色背景。更改立即生效。</p></section>
  </div>
  const renderLayout = () => <div className="settings-view">
    <div className="settings-section-heading"><h3>布局</h3></div>
    <section className="settings-card settings-preference-card"><strong>工作台栏宽与展开状态</strong><p>重置后恢复适合当前窗口的默认栏宽；不会更改项目内容。</p><button type="button" onClick={onResetLayout}>恢复默认布局</button></section>
  </div>
  const renderCalibration = () => <div className="settings-view">
    <div className="settings-section-heading"><h3>校色管理</h3></div>
    <section className="settings-card settings-preference-card"><strong>农场校色档案</strong><p>创建、照片提取与导入档案属于系统资源管理。导入不会自动替换当前工程所用档案；请回到纹理工作室明确选用。</p><button type="button" onClick={()=>setFarmOpen(true)}>管理校色档案</button></section>
  </div>
  const renderMarking = () => <div className="settings-view settings-marking-view">
    <div className="settings-section-heading"><div><h3>编号与刻字</h3><p className="settings-marking-intro">这里设置字高、刻深与背面装配标识；订单号在制造导出中选择。</p></div></div>
    <AssemblyMarkingPanel expanded onPreview={onClose} />
  </div>
  const renderOverview = () => (
    <div className="settings-view settings-overview-view">
      <div className="settings-section-heading">
        <div>
          <span className="settings-eyebrow">LOCAL RESOURCE CONSOLE</span>
          <h3>本地资源一览</h3>
        </div>
        <span className={`settings-health ${overview?.issueCount ? 'has-issues' : 'is-healthy'}`}>
          <i />{overview ? (overview.issueCount ? `${overview.issueCount} 项待检查` : '索引状态正常') : '等待检查'}
        </span>
      </div>

      <div className="settings-metric-grid">
        <article className="settings-metric is-cyan"><span>配件</span><strong>{overview?.partCount ?? '—'}</strong><small>{plural(overview?.partPackageCount ?? 0, '个资源包')}</small></article>
        <article className="settings-metric is-violet"><span>装配宿主</span><strong>{overview?.assemblyHostCount ?? '—'}</strong><small>{plural(overview?.assemblyPackageCount ?? 0, '个场景包')}</small></article>
        <article className="settings-metric is-amber"><span>已保存项目</span><strong>{overview?.projectCount ?? '—'}</strong><small>{plural(overview?.manufacturingExportCount ?? 0, '个制造文件')}</small></article>
        <article className="settings-metric is-mint"><span>受控数据</span><strong>{overview ? formatResourceBytes(overview.managedBytes) : '—'}</strong><small>源资源与本地项目</small></article>
      </div>

      <section className="settings-card settings-health-card">
        <div className="settings-card-title"><span className="settings-card-icon">✓</span><div><strong>维护边界清晰</strong><small>源资源、运行时索引和项目文件分开管理</small></div></div>
        <div className="settings-flow-row" aria-label="资源生成流程">
          <span>源资源包</span><b>→</b><span>同步校验</span><b>→</b><span>网页运行时索引</span>
        </div>
        <p>此面板只做统计与健康检查，不会删除、移动或覆盖任何文件。资源变更继续由专用导入和同步流程完成。</p>
      </section>

      <section className="settings-card settings-quick-status">
        <div className="settings-card-title"><span className="settings-card-icon">◎</span><div><strong>最近索引</strong><small>用于判断页面看到的资源是否已经同步</small></div></div>
        <dl>
          <div><dt>配件库</dt><dd>{formatResourceDate(summary?.partLibrary.generatedAt ?? '')}</dd></div>
          <div><dt>装配宿主</dt><dd>{formatResourceDate(summary?.assemblyLibrary.generatedAt ?? '')}</dd></div>
          <div><dt>本次检查</dt><dd>{formatResourceDate(summary?.generatedAt ?? '')}</dd></div>
        </dl>
      </section>
    </div>
  )

  const renderParts = () => {
    const library = summary?.partLibrary
    const total = Math.max(1, library?.partCount ?? 0)
    return (
      <div className="settings-view">
        <div className="settings-section-heading"><div><span className="settings-eyebrow">PART LIBRARY</span><h3>配件库统计</h3></div><span className="settings-index-time">索引 {formatResourceDate(library?.generatedAt ?? '')}</span></div>
        <PartResourcePackImport onImported={() => void refresh()} />
        <div className="settings-inline-stats">
          <span><strong>{library?.partCount ?? '—'}</strong> 个配件</span>
          <span><strong>{library?.calibratedCount ?? '—'}</strong> 已标定</span>
          <span><strong>{library?.pendingCalibrationCount ?? '—'}</strong> 待标定</span>
          <span><strong>{library?.connectorCount ?? '—'}</strong> 个多场景连接器</span>
        </div>
        <section className="settings-card">
          <div className="settings-card-title"><span className="settings-card-icon">◒</span><div><strong>分类分布</strong><small>根据当前网页运行时索引统计</small></div></div>
          <div className="settings-bar-list">
            {library?.categories.length ? library.categories.map(category => (
              <div className="settings-bar-row" key={category.id}>
                <span>{category.label}</span><div><i style={{ width: `${Math.max(3, category.count / total * 100)}%` }} /></div><strong>{category.count}</strong>
              </div>
            )) : <div className="settings-empty">索引中还没有配件分类数据。</div>}
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-title"><span className="settings-card-icon">▦</span><div><strong>导入资源包</strong><small>{library?.packageCount ?? 0} 个包 · 按配件数量排序</small></div></div>
          <div className="settings-table" role="table" aria-label="配件资源包">
            {library?.packages.length ? library.packages.map(pack => (
              <div className="settings-table-row" role="row" key={pack.id}>
                <div><strong data-i18n-ignore="true">{pack.name}</strong><small>{pack.id} · v{pack.version}</small></div>
                <span>{pack.author}</span><b>{pack.partCount} 件</b>
              </div>
            )) : <div className="settings-empty">没有读取到配件资源包。</div>}
          </div>
        </section>
        {!!library?.issues.length && <section className="settings-card settings-issue-card"><div className="settings-card-title"><span className="settings-card-icon">!</span><div><strong>配件索引提示</strong><small>同步时发现的非阻断问题</small></div></div><ul>{library.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></section>}
      </div>
    )
  }

  const renderAssembly = () => {
    const library = summary?.assemblyLibrary
    const issues = library?.validationErrors ?? []
    return (
      <div className="settings-view">
        <div className="settings-section-heading"><div><span className="settings-eyebrow">ASSEMBLY HOST PACKS</span><h3>装配场景与宿主包</h3></div><span className={`settings-health ${issues.length ? 'has-issues' : 'is-healthy'}`}><i />{issues.length ? `${issues.length} 项验证问题` : '验证通过'}</span></div>
        <div className="settings-inline-stats">
          <span><strong>{library?.hostCount ?? '—'}</strong> 个宿主</span>
          <span><strong>{library?.packageCount ?? '—'}</strong> 个场景包</span>
          {library?.statuses.map(status => <span key={status.id}><strong>{status.count}</strong> {STATUS_LABELS[status.id] ?? status.id}</span>)}
        </div>
        <section className="settings-card settings-pack-import-card" {...hostPackDrop.dropProps}>
          <div className="settings-card-title"><span className="settings-card-icon">＋</span><div><strong>导入装配宿主包</strong><small>自包含 JSON bundle · 写入“装配资源包/90-用户导入”并自动校验索引</small></div></div>
          <input ref={packInputRef} type="file" accept=".json,.sbhostpack,application/json" onChange={event => void importHostPack(event.target.files?.[0])} />
          <div><button type="button" className="file-drop-prompt" onClick={() => packInputRef.current?.click()} disabled={importingPack}><span className="file-drop-plus" aria-hidden="true">＋</span>{importingPack ? '正在校验…' : '点击或拖入宿主数据包'}</button><span>{importStatus || '同 ID、宿主 ID 或 compatibilityKey 已存在时会拒绝覆盖。'}</span></div>
        </section>
        <section className="settings-card">
          <div className="settings-card-title"><span className="settings-card-icon">⌘</span><div><strong>连接器覆盖</strong><small>每个宿主只能使用明确兼容键自动匹配</small></div></div>
          <div className="settings-chip-grid">
            {library?.kinds.length ? library.kinds.map(kind => <div key={kind.id}><span>{KIND_LABELS[kind.id] ?? kind.id}</span><strong>{kind.count}</strong></div>) : <div className="settings-empty">尚未生成装配宿主索引。</div>}
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-title"><span className="settings-card-icon">▦</span><div><strong>宿主资源包</strong><small>版本和宿主数量来自 assemblyLibrary 索引</small></div></div>
          <div className="settings-table">
            {library?.packages.length ? library.packages.map(pack => <div className="settings-table-row" key={pack.id}><div><strong data-i18n-ignore="true">{pack.name}</strong><small>{pack.id}</small></div><span>v{pack.version}</span><b>{pack.hostCount} 宿主</b></div>) : <div className="settings-empty">没有读取到装配宿主包。</div>}
          </div>
        </section>
        <section className={`settings-card ${issues.length ? 'settings-issue-card' : 'settings-success-card'}`}>
          <div className="settings-card-title"><span className="settings-card-icon">{issues.length ? '!' : '✓'}</span><div><strong>包结构验证</strong><small>检查 ID、兼容键、连接器类型、所属包和装配流程</small></div></div>
          {issues.length ? <ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p>当前索引没有发现结构错误。几何承载能力仍应以厂家数据和实物测试为准。</p>}
        </section>
      </div>
    )
  }

  const renderProjects = () => {
    const projects = summary?.projects
    const totalProjectBytes = projects?.files.reduce((total, file) => total + file.sizeBytes, 0) ?? 0
    return (
      <div className="settings-view">
        <div className="settings-section-heading"><div><span className="settings-eyebrow">PROJECT LIBRARY</span><h3>已保存项目</h3></div><span className="settings-index-time">共 {formatResourceBytes(totalProjectBytes)}</span></div>
        <section className="settings-card">
          <div className="settings-card-title"><span className="settings-card-icon">▤</span><div><strong>SnapBoard 工程</strong><small>项目内默认库 · 这里只读，不改变当前打开的工程</small></div></div>
          <div className="settings-file-list">
            {projects?.files.length ? projects.files.map(file => <div key={file.name}><span className="settings-file-symbol">S</span><div><strong data-i18n-ignore="true">{file.name}</strong><small>更新于 {formatResourceDate(file.updatedAt)}</small></div><b>{formatResourceBytes(file.sizeBytes)}</b></div>) : <div className="settings-empty">“已保存项目”中还没有 .snapboard 工程。</div>}
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-title"><span className="settings-card-icon">⬡</span><div><strong>制造导出</strong><small>由 3MF 导出流程写入“已保存项目/制造导出”</small></div></div>
          <div className="settings-file-list is-compact">
            {projects?.manufacturingExports.length ? projects.manufacturingExports.map(file => <div key={file.name}><span className="settings-file-symbol is-manufacturing">3</span><div><strong data-i18n-ignore="true">{file.name}</strong></div><b>{formatResourceBytes(file.sizeBytes)}</b></div>) : <div className="settings-empty">尚未在默认项目库中生成制造文件。</div>}
          </div>
        </section>
      </div>
    )
  }

  const renderStorage = () => (
    <div className="settings-view">
      <div className="settings-section-heading"><div><span className="settings-eyebrow">CONTROLLED STORAGE</span><h3>受控目录与文件职责</h3></div><span className="settings-readonly-badge">只读审计</span></div>
      <section className="settings-boundary-note"><strong>为什么不提供任意路径操作？</strong><p>资源管理 API 只认识下面五个项目内目录，且不会跟随符号链接。这样可以避免误删工程外文件，也能让源数据与生成索引的职责长期保持清晰。</p></section>
      <div className="settings-directory-list">
        {summary?.directories.map(directory => <article key={directory.id}>
          <span className={`settings-directory-status ${directory.exists ? 'exists' : 'missing'}`} aria-label={directory.exists ? '目录存在' : '目录缺失'} />
          <div className="settings-directory-main"><div><strong>{directory.label}</strong><code>{directory.relativePath.replaceAll('\\', '/')}</code></div><p>{directory.purpose}</p><small>{directory.access}</small></div>
          <div className="settings-directory-count"><strong>{formatResourceBytes(directory.sizeBytes)}</strong><span>{directory.fileCount} 文件 · {directory.directoryCount} 目录</span></div>
        </article>)}
      </div>
      <section className="settings-card settings-policy-card"><div className="settings-card-title"><span className="settings-card-icon">⌾</span><div><strong>当前安全策略</strong><small>{summary?.policy.note ?? '等待读取策略'}</small></div></div><div className="settings-policy-grid"><span><i className="is-off" />任意路径访问：关闭</span><span><i className="is-off" />删除/移动：关闭</span><span><i className="is-on" />目录统计：启用</span><span><i className="is-on" />索引验证：启用</span></div></section>
    </div>
  )

  const content = activeTab === 'appearance' ? renderAppearance()
    : activeTab === 'layout' ? renderLayout()
      : activeTab === 'calibration' ? renderCalibration()
        : activeTab === 'marking' ? renderMarking()
        : activeTab === 'overview' ? renderOverview()
    : activeTab === 'parts' ? renderParts()
      : activeTab === 'assembly' ? renderAssembly()
        : activeTab === 'projects' ? renderProjects()
          : renderStorage()

  return (
    <><div className="settings-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={loading}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="settings-dialog-header">
          <div className="settings-brand-mark" aria-hidden="true">⚙</div>
          <div><h2 id={titleId}>设置</h2><p id={descriptionId}>外观、布局、校色、编号刻字与资源管理</p></div>
          <div className="settings-header-actions">
            {resourceTab&&<button type="button" className="settings-refresh" onClick={() => void refresh()} disabled={loading}><span className={loading ? 'is-spinning' : ''}>↻</span>{loading ? '检查中' : '刷新检查'}</button>}
            <button ref={closeButtonRef} type="button" className="settings-close" onClick={onClose} aria-label="关闭设置中心">×</button>
          </div>
        </header>

        <div className="settings-dialog-body">
          <nav className="settings-nav" role="tablist" aria-label="设置分类">
            {TAB_DEFINITIONS.map(tab => <Fragment key={tab.id}>{tab.id === 'overview' && <span className="settings-nav-group" role="presentation">资源管理</span>}<button type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)}><span>{tab.icon}</span><div><strong>{tab.label}</strong><small>{tab.hint}</small></div>{tab.id === 'assembly' && !!summary?.assemblyLibrary.validationErrors.length && <b>{summary.assemblyLibrary.validationErrors.length}</b>}</button></Fragment>)}
            <div className="settings-nav-foot"><span>LOCAL</span><small>仅管理当前项目目录</small></div>
          </nav>
          <main className="settings-content" role="tabpanel">
            {resourceTab&&error ? <div className="settings-error"><strong>无法完成资源检查</strong><p>{error}</p><button type="button" onClick={() => void refresh()}>重新检查</button></div> : content}
            {resourceTab&&loading && !summary && <div className="settings-loading"><i /><strong>正在扫描受控目录…</strong><span>不会读取项目外的任何路径</span></div>}
          </main>
        </div>

        <footer className="settings-dialog-footer">
          <span><i className={resourceTab&&summary?.overview.issueCount ? 'has-issues' : ''} />{resourceTab ? summary ? `检查完成 · ${formatResourceDate(summary.generatedAt)}` : '等待本地资源检查' : '偏好即时生效'}</span>
          <p>{resourceTab?'文件增删请继续使用配件导入、资源包同步或项目文件操作。':activeTab === 'marking' ? '刻字设置随当前工程保存，真实结果以制造导出汇总为准。' : '当前工程的制造参数请在对应工作区调整。'}</p>
        </footer>
      </section>
    </div>{farmOpen&&<FarmCalibrationDialog onClose={()=>setFarmOpen(false)}/>}</>
  )
}

export default SettingsDialog
