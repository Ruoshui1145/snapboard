// ============ 配件库面板 — 分类浏览 + 拖出 + 排序 + 批量操作 ============
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {createPortal} from 'react-dom'
import { usePartLibrary } from '../../hooks/usePartLibrary'
import { textPrompt } from '../../utils/textPrompt'
import {
  PART_CATEGORY_FOLDER, PART_CATEGORY_OPTIONS,
  mountNeedsCalibration,
  type PartCategory, type PartDefinition,
} from '../../partLibrary/types'
import { PartImportDialog, PartRenameDialog } from '../partLibrary/PartImportDialog'
import { PartResourcePackImport } from '../partLibrary/PartResourcePackImport'
import { PartModelThumbnail } from '../partLibrary/PartModelThumbnail'
import { PartMountCalibrator } from '../partLibrary/PartMountCalibrator'
import { PartPreviewDialog } from '../partLibrary/PartPreviewDialog'
import { dimensionsLabel } from '../../utils/modelInspection'
import { useAppStore } from '../../store/useAppStore'
import { useAssemblyLibrary } from '../../hooks/useAssemblyLibrary'
import { useFileDrop } from '../../hooks/useFileDrop'

interface Props {
  /** 配件被拖出时的回调 (startDrag) */
  onDragPart?: (def: PartDefinition, e: React.DragEvent) => void
  onDragEnd?: () => void
  /** 不渲染自己的标题 (由右侧栏折叠卡片头部承担) */
  headerless?: boolean
  splitLayout?: boolean
}

type SortMode = 'default' | 'name' | 'category' | 'format' | 'status' | 'occlusion'
type OcclusionFilter = 'all' | 'low' | 'unknown'
type LibraryScope = 'compatible' | 'all'
type PartCompatibility = 'ready' | 'needs-calibration' | 'incompatible'

const LOW_OCCLUSION_THRESHOLD = 0.35
const hasKnownFootprint = (part: PartDefinition) => Array.isArray(part.model.dimensionsMm)
  && part.model.dimensionsMm.length === 3
  && part.model.dimensionsMm.every(value => Number.isFinite(value) && value > 0)
const isLowOcclusionPart = (part: PartDefinition) => hasKnownFootprint(part)
  && (part.occlusion?.voidRatio ?? 0) >= LOW_OCCLUSION_THRESHOLD
const occlusionSortScore = (part: PartDefinition) => hasKnownFootprint(part)
  ? 1 - (part.occlusion?.voidRatio ?? 0)
  : Number.POSITIVE_INFINITY

const compatibilityForPart = (part: PartDefinition, hostKind: string): PartCompatibility => {
  if (hostKind === 'hole-pattern') {
    if (typeof part.mount !== 'object' || part.mount.anchors.length === 0) return 'incompatible'
    return mountNeedsCalibration(part) ? 'needs-calibration' : 'ready'
  }
  const connector = part.mountConnectors?.find(item => item.kind === hostKind)
  return connector ? 'ready' : 'incompatible'
}

const compatibilityLabel = (state: PartCompatibility, hostLabel: string, hostKind: string) => {
  if (state === 'ready') return '可直接装配'
  if (state === 'needs-calibration') return '需要完成装配标定'
  if (hostKind === 'hole-pattern') return '缺少当前板孔的装配锚点，暂不能放置'
  return `缺少${hostLabel.includes('导轨') ? '导轨卡扣' : hostLabel.includes('型材') || hostKind === 't-slot' ? '型材槽连接器' : '墙面底座'}标定，暂不能放置`
}

export function PartLibraryPanel({ onDragPart, onDragEnd, headerless, splitLayout = false }: Props) {
  const [packImportOpen,setPackImportOpen] = useState(false)
  const packDialogRef = useRef<HTMLDialogElement>(null)
  useEffect(()=>{if(packImportOpen)packDialogRef.current?.showModal();else packDialogRef.current?.close()},[packImportOpen])
  const [gridHost,setGridHost] = useState<HTMLElement|null>(null)
  useEffect(()=>{setGridHost(splitLayout?document.getElementById('workbench-part-grid'):null)},[splitLayout])
  const { index, loading, error, activeCategory, setActiveCategory } = usePartLibrary()
  const [categoryFilter, setCategoryFilter] = useState<PartCategory | 'all'>('all')
  const assemblyHostPresetId = useAppStore(state => state.assemblyScene.hostPresetId ?? 'snapboard-pegboard-v1')
  const assemblyLibrary = useAssemblyLibrary()
  const [activeSubcategory, setActiveSubcategory] = useState('')
  const [calibrating, setCalibrating] = useState<PartDefinition | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [renaming, setRenaming] = useState<PartDefinition | null>(null)
  const [previewing, setPreviewing] = useState<PartDefinition | null>(null)
  const [importError, setImportError] = useState('')
  // 排序：模式 + 方向 + 资源序号（写回 part.json.sortOrder）
  const [sortMode, setSortMode] = useState<SortMode>('default')
  const [sortAsc, setSortAsc] = useState(true)
  const [occlusionFilter, setOcclusionFilter] = useState<OcclusionFilter>('all')
  const [scope, setScope] = useState<LibraryScope>('compatible')
  const [order, setOrder] = useState<string[]>([])
  const [reorderId, setReorderId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null)
  const [partActionsId, setPartActionsId] = useState<string | null>(null)
  // 批量 (文件管理式): 复选 + 底部动作条
  const [batchMode, setBatchMode] = useState(false)
  const [reorderMode, setReorderMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  // 细分文件夹不一定包含零件，因此不能只从 index.parts 推导；单独读取目录清单。
  const [folderCatalog, setFolderCatalog] = useState<Record<string, string[]>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const hostPreset = assemblyLibrary.hosts.find(host => host.id === assemblyHostPresetId)
    ?? assemblyLibrary.hosts[0]
  const hostKind = hostPreset?.kind ?? 'hole-pattern'

  const loadFolderCatalog = useCallback(async (category: string) => {
    try {
      const response = await fetch(`/api/part-library/group?category=${encodeURIComponent(category)}`, { cache: 'no-store' })
      const result = await response.json().catch(() => ({})) as { groups?: unknown; error?: string }
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      const groups = Array.isArray(result.groups) ? result.groups.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
      setFolderCatalog(prev => ({ ...prev, [category]: [...new Set(groups)].sort((a, b) => a.localeCompare(b, 'zh-CN')) }))
    } catch (cause) {
      setImportError(`读取细分文件夹失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }, [])

  useEffect(() => {
    void loadFolderCatalog(activeCategory)
  }, [activeCategory, loadFolderCatalog])

  useEffect(() => {
    if (!index) return
    setOrder([...index.parts]
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name, 'zh-CN'))
      .map(part => part.id))
  }, [index])

  useEffect(() => {
    setScope('compatible')
    setSelectedPartId(null)
    setPartActionsId(null)
  }, [assemblyHostPresetId])

  const selectCategory = (category: PartCategory | 'all') => {
    setActiveSubcategory('')
    setCategoryFilter(category)
    if (category !== 'all') setActiveCategory(category)
  }

  const chooseFiles = (files?: FileList | File[]) => {
    if (!files || files.length === 0) return
    const picked = Array.from(files)
    for (const file of picked) {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!ext || !['3mf', 'stl', 'glb', 'gltf'].includes(ext)) {
        setImportError(`“${file.name}”暂不支持该格式。请选择 3MF、STL、GLB 或独立 GLTF 模型。`)
        return
      }
      if (file.size > 200 * 1024 * 1024) {
        setImportError(`“${file.name}”超过 200 MB，单个模型不能超过 200 MB。`)
        return
      }
    }
    setImportError('')
    setPendingFiles(picked)
  }

  const modelDrop = useFileDrop(chooseFiles, pendingFiles.length > 0, {
    accept: '.3mf,.stl,.glb,.gltf', maxBytes: 200 * 1024 * 1024, onError: setImportError,
  })
  const dropActive = modelDrop.dragging

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const toggleBatch = () => setBatchMode(prev => {
    if (prev) setSelected(new Set())
    return !prev
  })

  const sorted = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase()
    const list = (index?.parts ?? []).filter(part => (categoryFilter === 'all' || part.category === categoryFilter)
      && (scope === 'all' || compatibilityForPart(part, hostKind) !== 'incompatible')
      && (!activeSubcategory || part.subcategory === activeSubcategory)
      && (occlusionFilter === 'all'
        || (occlusionFilter === 'low' && isLowOcclusionPart(part))
        || (occlusionFilter === 'unknown' && !hasKnownFootprint(part)))
      && (!query || `${part.name} ${part.description ?? ''}`.toLocaleLowerCase().includes(query)))
    if (sortMode === 'default') {
      const rank = new Map(order.map((id, i) => [id, i]))
      list.sort((a, b) => Number(compatibilityForPart(a, hostKind) === 'incompatible') - Number(compatibilityForPart(b, hostKind) === 'incompatible')
        || (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        || (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name, 'zh-CN'))
    } else {
      const dir = sortAsc ? 1 : -1
      const compare = (a: PartDefinition, b: PartDefinition) => {
        if (sortMode === 'name') return dir * a.name.localeCompare(b.name, 'zh-CN')
        if (sortMode === 'category') return dir * (a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'zh-CN'))
        if (sortMode === 'format') return dir * ((a.model.format ?? '').localeCompare(b.model.format ?? '') || a.name.localeCompare(b.name, 'zh-CN'))
        if (sortMode === 'occlusion') return dir * (occlusionSortScore(a) - occlusionSortScore(b) || a.name.localeCompare(b.name, 'zh-CN'))
        return dir * (Number(mountNeedsCalibration(a)) - Number(mountNeedsCalibration(b)) || a.name.localeCompare(b.name, 'zh-CN'))
      }
      list.sort(compare)
    }
    return list
  }, [index, activeSubcategory, categoryFilter, hostKind, occlusionFilter, searchTerm, scope, sortMode, sortAsc, order])

  const compatibleCount = useMemo(() => (index?.parts ?? [])
    .filter(part => compatibilityForPart(part, hostKind) !== 'incompatible').length, [hostKind, index])
  const appliedFilterCount = Number(categoryFilter !== 'all')
    + Number(Boolean(activeSubcategory))
    + Number(occlusionFilter !== 'all')
    + Number(sortMode !== 'default')
  const selectedPart = sorted.find(part => part.id === selectedPartId) ?? null

  useEffect(() => {
    if (selectedPartId && !sorted.some(part => part.id === selectedPartId)) setSelectedPartId(null)
  }, [selectedPartId, sorted])

  const subcategories = useMemo(() => categoryFilter === 'all' ? [] : [...new Set([
    ...(index?.parts ?? [])
      .filter(part => part.category === categoryFilter && part.subcategory)
      .map(part => part.subcategory!.trim())
      .filter(Boolean),
    ...(folderCatalog[categoryFilter] ?? []),
  ])].sort((a, b) => a.localeCompare(b, 'zh-CN')), [index, categoryFilter, folderCatalog])

  const createSubcategory = async () => {
    const input = (await textPrompt('新建细分文件夹名称', '直钩'))?.trim()
    if (!input) return
    try {
      const response = await fetch('/api/part-library/group', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', category: activeCategory, name: input }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      setFolderCatalog(prev => ({
        ...prev,
        [activeCategory]: [...new Set([...(prev[activeCategory] ?? []), input])].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      }))
      setActiveSubcategory(input)
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
    } catch (cause) {
      setImportError(`新建细分文件夹失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const deleteSubcategory = async (target = activeSubcategory) => {
    if (!target || !window.confirm(`删除细分文件夹“${target}”？如果其中有配件，确认后将连同配件一起删除。`)) return
    try {
      const request = (force = false) => fetch('/api/part-library/group', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', category: activeCategory, name: target, ...(force ? { force: true } : {}) }),
      })
      let response = await request()
      let result = await response.json().catch(() => ({}))
      if (!response.ok && String(result.error ?? '').includes('连同内容一起删除')) {
        if (!window.confirm(`文件夹“${target}”中仍有配件。继续删除会永久移除这些配件，是否继续？`)) return
        response = await request(true)
        result = await response.json().catch(() => ({}))
      }
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      setFolderCatalog(prev => ({ ...prev, [activeCategory]: (prev[activeCategory] ?? []).filter(name => name !== target) }))
      if (activeSubcategory === target) setActiveSubcategory('')
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
    } catch (cause) {
      setImportError(`删除细分文件夹失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const current = sorted
  const allIds = current.map(part => part.id)

  const persistOrder = async (ids: string[]) => {
    try {
      const response = await fetch('/api/part-library/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reorder',
          ids,
          orders: ids.map((id, index) => ({ id, sortOrder: (index + 1) * 10 })),
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.failed?.length) throw new Error(result.error || result.failed?.[0]?.error || `HTTP ${response.status}`)
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
    } catch (cause) {
      setImportError(`排序保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  if (loading) return <div style={{ padding: 12, fontSize: 12, color: '#888' }}>加载配件库...</div>
  if (error) return <div style={{ padding: 12, fontSize: 12, color: '#ff5050' }}>配件库加载失败: {error}</div>
  if (!index) return null

  const handleReorderDrop = (targetId: string) => {
    const draggedId = reorderId
    if (!draggedId || draggedId === targetId) {
      setReorderId(null)
      setDropTargetId(null)
      return
    }
    const base = current.map(part => part.id)
    const next = base.filter(id => id !== draggedId)
    const targetIndex = next.indexOf(targetId)
    if (targetIndex < 0) next.push(draggedId)
    else next.splice(targetIndex, 0, draggedId)
    setOrder(next)
    void persistOrder(next)
    setReorderId(null)
    setDropTargetId(null)
  }

  const runBatch = async (opts: { action: 'move-category' | 'delete'; category?: PartCategory }) => {
    if (!selected.size || batchBusy) return
    if (opts.action === 'delete' && !window.confirm(`确定删除选中的 ${selected.size} 个零件吗？模型文件将一并移除，无法恢复。`)) return
    setBatchBusy(true)
    try {
      const folder = opts.category ? (PART_CATEGORY_FOLDER[opts.category] ?? '') : ''
      const response = await fetch('/api/part-library/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: opts.action, ids: [...selected], category: opts.category, folder }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      if (result.failed?.length) {
        setImportError(`部分零件处理失败：${result.failed.map((f: { id: string; error: string }) => `${f.id}（${f.error}）`).join('；')}`)
      } else {
        setImportError('')
      }
      setSelected(new Set())
      setBatchMode(false)
      if (opts.action === 'move-category' && opts.category) setActiveCategory(opts.category)
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
    } catch (cause) {
      setImportError(`批量操作失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBatchBusy(false)
    }
  }

  const reorderActive = sortMode === 'default' && !batchMode && reorderId !== null
  const resetFilters = () => {
    setCategoryFilter('all')
    setActiveSubcategory('')
    setOcclusionFilter('all')
    setSortMode('default')
    setSortAsc(true)
  }
  const openResourceSettings = () => window.dispatchEvent(new CustomEvent('snapboard:open-settings', { detail: { tab: 'parts' } }))

  const libraryControls = <>
      <div className="lib-workflow-title" aria-label="装配流程第2步：选择配件">
        <span className="lib-step-index">2</span>
        <div><b>选择配件</b><small>搜索、预览并拖入 3D 完成装配</small></div>
        {!splitLayout && <button type="button" title="点击选择，或将模型文件拖入此栏" onClick={() => fileInput.current?.click()}>＋ 导入</button>}
        {!splitLayout && <button type="button" className="lib-library-manage-button" aria-label="管理配件库" aria-expanded={manageOpen} onClick={() => { setManageOpen(value => !value); setFiltersOpen(false) }}><span aria-hidden="true">⚙</span> 管理</button>}
      </div>

      <div className="lib-sticky-head">
        <div className="lib-search-row" role="search">
          <span aria-hidden="true">⌕</span>
          <input type="search" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} placeholder="搜索名称、用途或规格" aria-label="搜索配件" />
          {searchTerm && <button type="button" onClick={() => setSearchTerm('')} aria-label="清除搜索">×</button>}
        </div>
        <div className="lib-sort-toolbar">
            <div className="lib-filter-sort"><select value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)} aria-label="排序方式"><option value="default">推荐顺序</option><option value="name">名称</option><option value="category">用途分类</option><option value="format">模型格式</option><option value="status">标定状态</option><option value="occlusion">低遮挡优先</option></select>{sortMode !== 'default' && <button type="button" onClick={() => setSortAsc(value => !value)}>{sortAsc ? '升序 ↑' : '降序 ↓'}</button>}</div>
        </div>
        <div className="lib-scope-row">
          <div className="lib-scope-switch" aria-label="配件显示范围">
            <button type="button" className={scope === 'compatible' ? 'on' : ''} onClick={() => setScope('compatible')}>适配当前 <b>{compatibleCount}</b></button>
            <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全部 <b>{index.parts.length}</b></button>
          </div>
          <button type="button" className={'lib-filter-trigger' + (filtersOpen ? ' on' : '')} aria-expanded={filtersOpen} onClick={() => { setFiltersOpen(value => !value); setManageOpen(false) }}>
            筛选{appliedFilterCount ? ` · ${appliedFilterCount}` : ''}
          </button>
        </div>

        {filtersOpen && (
          <section className="lib-filter-panel" aria-label="配件筛选">
            <header><b>筛选配件</b><button type="button" onClick={resetFilters}>重置</button></header>
            {!splitLayout && <><label>用途分类</label>
            <div className="lib-category-grid">
              <button type="button" className={categoryFilter === 'all' ? 'on' : ''} onClick={() => selectCategory('all')}><span>全部用途</span><b>{index.parts.length}</b></button>
              {index.categories.map(cat => (
                <button key={cat.id} type="button" className={categoryFilter === cat.id ? 'on' : ''} onClick={() => selectCategory(cat.id)}>
                  <span>{cat.name}</span><b>{index.parts.filter(part => part.category === cat.id).length}</b>
                </button>
              ))}
            </div>
            {!!subcategories.length && <><label>细分文件夹</label><select value={activeSubcategory} onChange={event => setActiveSubcategory(event.target.value)} aria-label="细分文件夹"><option value="">全部细分</option>{subcategories.map(group => <option key={group} value={group}>{group}</option>)}</select></>}
            </>}<label>装配特性</label>
            <div className="lib-filter-options">
              <button type="button" className={occlusionFilter === 'all' ? 'on' : ''} onClick={() => setOcclusionFilter('all')}>不限</button>
              <button type="button" className={occlusionFilter === 'low' ? 'on' : ''} onClick={() => setOcclusionFilter('low')}>低遮挡</button>
              <button type="button" className={occlusionFilter === 'unknown' ? 'on' : ''} onClick={() => setOcclusionFilter('unknown')}>遮挡未知</button>
            </div>
            <button type="button" className="lib-filter-done" onClick={() => setFiltersOpen(false)}>查看 {sorted.length} 个结果</button>
          </section>
        )}

        {manageOpen && (
          <section className="lib-manage-panel" aria-label="配件库管理">
            <header><b>管理配件库</b><span>{index.packages?.length ?? 0} 个资源包 · {index.parts.length} 个配件</span></header>
            <div><button type="button" onClick={() => fileInput.current?.click()}>＋ 导入配件</button><button type="button" onClick={() => setPackImportOpen(true)}>导入资源包</button><button type="button" onClick={openResourceSettings}>管理资源与文件</button></div>
            <div><button type="button" disabled={!current.length} onClick={() => { toggleBatch(); setReorderMode(false); setManageOpen(false) }}>{batchMode ? '完成批量' : '批量整理'}</button><button type="button" disabled={!current.length} onClick={() => { setReorderMode(true); setBatchMode(false); setSortMode('default'); setManageOpen(false) }}>调整顺序</button></div>
            <div><button type="button" disabled={categoryFilter === 'all'} title={categoryFilter === 'all' ? '先选择一个具体用途分类' : '在当前分类中新建细分'} onClick={() => void createSubcategory()}>＋ 新建细分</button>{activeSubcategory && <button type="button" className="danger" onClick={() => void deleteSubcategory()}>删除“{activeSubcategory}”</button>}</div>
            <p>资源包版本、作者、许可证和索引状态可在“设置 → 配件库”查看。</p>
          </section>
        )}

        {(categoryFilter !== 'all' || activeSubcategory || occlusionFilter !== 'all') && <div className="lib-active-filters">{categoryFilter !== 'all' && <button type="button" onClick={() => selectCategory('all')}>{index.categories.find(cat => cat.id === categoryFilter)?.name} ×</button>}{activeSubcategory && <button type="button" onClick={() => setActiveSubcategory('')}>{activeSubcategory} ×</button>}{occlusionFilter !== 'all' && <button type="button" onClick={() => setOcclusionFilter('all')}>{occlusionFilter === 'low' ? '低遮挡' : '遮挡未知'} ×</button>}</div>}
        {<div className="lib-result-summary" role="status" aria-live="polite"><span>{categoryFilter === 'all' ? '全部用途' : index.categories.find(cat => cat.id === categoryFilter)?.name}</span><b>{sorted.length} 个结果</b><small>{scope === 'compatible' ? `适配 ${hostPreset?.label ?? '当前场景'}` : '正在浏览全部配件'}</small></div>}
        {reorderMode && !filtersOpen && !manageOpen && <div className="lib-reorder-notice"><span>拖动左侧手柄调整资源顺序</span><button type="button" onClick={() => setReorderMode(false)}>完成</button></div>}
      </div>
      {importError && <div className="part-import-inline-error">{importError}</div>}

  </>
  const organizingFooter = <>
      {/* 批量动作条 (文件管理式: 全选/清空/移动到分类/删除) */}
      {batchMode && (
        <div className="lib-batch-bar">
          <span role="status">批量整理 · 已选 {selected.size} / {sorted.length}</span>
          <button type="button" disabled={batchBusy} onClick={toggleBatch}>完成批量</button>
          <button type="button" disabled={batchBusy} onClick={() => setSelected(new Set(allIds))}>全选</button>
          <button type="button" disabled={batchBusy || !selected.size} onClick={() => setSelected(new Set())}>清空</button>
          <select
            className="lib-batch-move"
            value=""
            disabled={batchBusy || !selected.size}
            onChange={event => {
              const target = event.target.value as PartCategory
              if (target) void runBatch({ action: 'move-category', category: target })
            }}
          >
            <option value="" disabled>移动到分类…</option>
            {PART_CATEGORY_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button type="button" className="danger" disabled={batchBusy || !selected.size} title="永久删除选中配件及模型文件；执行前会再次确认" onClick={() => void runBatch({ action: 'delete' })}>{batchBusy ? '处理中…' : '删除所选配件'}</button>
        </div>
      )}

      {!!index.warnings?.length && (
        <details style={{ marginTop: 8, fontSize: 10.5, color: '#d9a441' }}>
          <summary>资源包提示 ({index.warnings.length})</summary>
          {index.warnings.map((warning, i) => <div key={i} style={{ marginTop: 4 }}>• {warning}</div>)}
        </details>
      )}
  </>

  const library = (
    <div
      className={'lib-library-shell'+(splitLayout?' lib-grid-browser':'')}
      style={{ padding: headerless ? '4px 4px 8px' : 8 }}
      {...modelDrop.dropProps}
    >
      {!headerless && (
        <h4 style={{ margin: '8px 0', fontSize: 12, color: '#888' }}>🧩 配件库</h4>
      )}
      <input
        ref={fileInput}
        className="lib-hidden-file"
        type="file"
        multiple
        accept=".3mf,.stl,.glb,.gltf,model/3mf,model/stl,model/gltf-binary,model/gltf+json"
        onChange={event => {
          chooseFiles(event.target.files ?? undefined)
          event.target.value = ''
        }}
      />
      {dropActive && !splitLayout && <div className="lib-file-drop-overlay"><b>松开以导入配件</b><span>支持 3MF / STL / GLB / GLTF</span></div>}

      {splitLayout && <div className="lib-preview-fixed">
        <nav className="lib-category-breadcrumb" aria-label="当前配件分类"><span>{categoryFilter==='all'?'全部用途':index.categories.find(c=>c.id===categoryFilter)?.name ?? categoryFilter}</span>{activeSubcategory && <><span aria-hidden="true">›</span><span>{activeSubcategory}</span></>}</nav>
        {(selectedPart ?? sorted[0]) ? <PartPreviewDialog key={(selectedPart ?? sorted[0]).id} part={selectedPart ?? sorted[0]} embedded onExpand={()=>setPreviewing(selectedPart ?? sorted[0])} onClose={()=>{}} onEdit={()=>setRenaming(selectedPart ?? sorted[0])} onCalibrate={()=>setCalibrating(selectedPart ?? sorted[0])} onSaved={()=>{}}/> : <div className="lib-preview-empty">选择配件后查看三维预览</div>}
      </div>}
      <div className="lib-scroll-content">
      {!splitLayout && libraryControls}
      {<>
      <div className="lib-list" role="list" aria-label="配件搜索结果">
        {sorted.length === 0 && (
          <div className="lib-empty-state">
            <b>{index.parts.length === 0 ? '尚未安装配件资源包' : scope === 'compatible' && compatibleCount === 0 ? `${hostPreset?.label ?? '当前场景'}暂无适配配件` : searchTerm ? `没有找到“${searchTerm}”` : '当前条件没有匹配配件'}</b>
            <span>{index.parts.length === 0 ? '安装版不内置配件。可以整包导入，也可以单独导入自己的模型。' : scope === 'compatible' && compatibleCount === 0 ? '现有零件可能还没有标定对应的连接器。' : '换个关键词，或清除当前筛选条件。'}</span>
            {index.parts.length === 0 && <PartResourcePackImport />}
            <div className="lib-empty-actions">
              {scope === 'compatible' && <button type="button" className="lib-empty-primary" onClick={() => setScope('all')}>查看全部零件</button>}
              {(searchTerm || appliedFilterCount > 0) && <button type="button" onClick={() => { setSearchTerm(''); resetFilters() }}>清除筛选</button>}
              <button type="button" onClick={() => fileInput.current?.click()}>导入配件</button>
            </div>
          </div>
        )}
        {sorted.map(part => {
          const compatibility = compatibilityForPart(part, hostKind)
          const ready = compatibility === 'ready'
          const selectedRow = selectedPartId === part.id
          return (
            <article
              key={part.id}
              role="listitem"
              className={`lib-part compatibility-${compatibility}${selectedRow ? ' is-selected' : ''}${partActionsId === part.id ? ' has-actions-open' : ''}${dropTargetId === part.id && reorderId !== null && reorderId !== part.id ? ' is-drop-target' : ''}`}
              onClick={() => { setPartActionsId(null); if (batchMode) toggleSelect(part.id); else if (!reorderMode) setSelectedPartId(part.id) }}
              onDoubleClick={() => { if (!batchMode) setPreviewing(part) }}
              onDragOver={reorderActive ? event => { event.preventDefault(); setDropTargetId(part.id) } : undefined}
              onDrop={reorderActive ? event => { event.preventDefault(); handleReorderDrop(part.id) } : undefined}
            >
              {batchMode ? (
                <span className={'lib-part-check' + (selected.has(part.id) ? ' on' : '')} aria-label={selected.has(part.id) ? '取消选择' : '选择'}>{selected.has(part.id) ? '✓' : ''}</span>
              ) : reorderMode && sortMode === 'default' ? (
                <span className="lib-order-handle" draggable title="拖动调整资源序号" onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData('application/snapboard-reorder', part.id); event.dataTransfer.effectAllowed = 'move'; setReorderId(part.id) }} onDragEnd={() => { setReorderId(null); setDropTargetId(null) }}>⠿</span>
              ) : null}
              <div
                className="lib-part-dragarea"
                draggable={!batchMode && !reorderMode && ready}
                onDragStart={event => {
                  if (!ready) { event.preventDefault(); return }
                  onDragPart?.(part, event)
                }}
                onDragEnd={onDragEnd}
                title={ready ? '拖到中央 3D 视图进行装配' : compatibilityLabel(compatibility, hostPreset?.label ?? '当前场景', hostKind)}
              >
                <button type="button" className="lib-part-thumb" draggable={false} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if(splitLayout)setSelectedPartId(part.id); else setPreviewing(part) }} aria-label={`查看 ${part.name} 的大图与实际安装效果`}>
                  <PartModelThumbnail part={part} />
                  <span className="lib-thumb-open">预览</span>
                </button>
                <div className="lib-part-copy">
                  <b data-i18n-ignore="true">{part.name}</b>
                  {part.model.dimensionsMm && <span className="lib-part-dimensions-label">尺寸 · {dimensionsLabel({ x: part.model.dimensionsMm[0], y: part.model.dimensionsMm[1], z: part.model.dimensionsMm[2] })}</span>}
                  <div className="lib-part-labels">
                    <em className={`compatibility-${compatibility}`}><i>{ready ? '✓' : compatibility === 'needs-calibration' ? '!' : '—'}</i><span>{compatibilityLabel(compatibility, hostPreset?.label ?? '当前场景', hostKind)}</span></em>
                    {ready && <small className="placement">↗ 拖入 3D</small>}
                    {ready && isLowOcclusionPart(part) && <small className="occlusion">低遮挡</small>}
                  </div>
                </div>
              </div>
              <button type="button" className="lib-part-more" aria-label={`${part.name} 的更多操作`} title="更多操作" aria-expanded={partActionsId === part.id} onClick={event => { event.stopPropagation(); setPartActionsId(current => current === part.id ? null : part.id) }}>⋯</button>
              {partActionsId === part.id && <div className="lib-part-actionmenu" role="menu" aria-label={`${part.name} 的更多操作`} onClick={event => event.stopPropagation()}>
                <div className="lib-part-actionmenu-head"><span aria-hidden="true">⋯</span><div><b>更多操作</b><small data-i18n-ignore="true">{part.name}</small></div></div>
                <button type="button" role="menuitem" onClick={() => { setPreviewing(part); setPartActionsId(null) }}><span aria-hidden="true">◉</span>查看详情</button>
                <button type="button" role="menuitem" onClick={() => { setRenaming(part); setPartActionsId(null) }}><span aria-hidden="true">✎</span>编辑资料与图片</button>
                <button type="button" role="menuitem" onClick={() => { setCalibrating(part); setPartActionsId(null) }}><span aria-hidden="true">⌁</span>装配标定</button>
              </div>}
            </article>
          )
        })}
      </div>

      {selectedPart && !batchMode && (
        <div className="lib-selection-bar">
          <div><small>已选</small><b>{selectedPart.name}</b><span>{compatibilityForPart(selectedPart, hostKind) === 'needs-calibration' ? typeof selectedPart.mount === 'object' && selectedPart.mount.anchors.length ? '装配锚点待确认，标定完成后才可拖入' : '缺少与板孔对应的装配锚点，标定完成后才可拖入' : compatibilityLabel(compatibilityForPart(selectedPart, hostKind), hostPreset?.label ?? '当前场景', hostKind)}</span></div>
          <button type="button" onClick={() => setPreviewing(selectedPart)}>查看预览</button>
          {compatibilityForPart(selectedPart, hostKind) === 'needs-calibration' && <button type="button" className="primary" onClick={() => setCalibrating(selectedPart)}>标定后放置</button>}
          {compatibilityForPart(selectedPart, hostKind) === 'ready' && <strong>按住卡片拖入 3D</strong>}
        </div>
      )}
      </>}

      {!splitLayout && organizingFooter}
      </div>
      <dialog ref={packDialogRef} className="lib-pack-dialog" onCancel={()=>setPackImportOpen(false)} aria-label="导入配件资源包"><header><h3>导入配件资源包</h3><button type="button" onClick={()=>setPackImportOpen(false)}>关闭</button></header><PartResourcePackImport /></dialog>
      {calibrating && (
        <PartMountCalibrator
          key={calibrating.id}
          part={calibrating}
          onClose={() => setCalibrating(null)}
          onSaved={() => {
            setCalibrating(null)
            window.dispatchEvent(new Event('snapboard:part-library-updated'))
          }}
        />
      )}
      {pendingFiles.length > 0 && (
        <PartImportDialog
          files={pendingFiles}
          initialCategory={activeCategory as PartCategory}
          onClose={() => setPendingFiles([])}
          onImported={category => {
            setPendingFiles([])
            selectCategory(category)
          }}
        />
      )}
      {renaming && (
        <PartRenameDialog
          key={renaming.id}
          part={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => setRenaming(null)}
        />
      )}
      {previewing && (
        <PartPreviewDialog
          key={previewing.id}
          part={previewing}
          onClose={() => setPreviewing(null)}
          onEdit={() => { setRenaming(previewing); setPreviewing(null) }}
          onCalibrate={() => { setCalibrating(previewing); setPreviewing(null) }}
          onSaved={() => setPreviewing(null)}
        />
      )}
    </div>
  )
  if (!splitLayout) return library
  return <>
    <section className="lib-management-workspace" aria-label="配件管理" {...modelDrop.dropProps}>
    {dropActive && <div className="lib-file-drop-overlay"><b>松开以导入配件</b><span>支持 3MF / STL / GLB / GLTF</span></div>}
    <div className="lib-left-controls">
      {libraryControls}
    </div>
    <div className="lib-organize-actions" aria-label="配件资源操作">
      <div className="lib-action-group"><strong>添加资源</strong><button type="button" {...modelDrop.dropProps} onClick={()=>fileInput.current?.click()}>＋ 点击或拖入模型</button><button type="button" onClick={()=>setPackImportOpen(true)}>导入资源包</button><button type="button" onClick={openResourceSettings}>管理资源与文件</button></div>
      <div className="lib-action-group"><strong>整理资源</strong><button type="button" disabled={!current.length || batchBusy} aria-pressed={batchMode} onClick={()=>{toggleBatch();setReorderMode(false);setManageOpen(false)}}>{batchMode?'完成批量':'批量整理'}</button><button type="button" disabled={!current.length} aria-pressed={reorderMode} onClick={()=>{setReorderMode(v=>!v);setBatchMode(false);setSortMode('default');setManageOpen(false)}}>{reorderMode?'完成排序':'调整顺序'}</button><button type="button" disabled={categoryFilter==='all'} title="先选择一个具体用途分类" onClick={()=>void createSubcategory()}>新建细分</button>{activeSubcategory && <button type="button" className="danger" title="将删除当前细分文件夹；包含配件时会再次确认" onClick={()=>void deleteSubcategory()}>删除细分文件夹</button>}</div>
    </div>
    {organizingFooter}
    <nav className="lib-category-rail" aria-label="配件用途分类">
      <button type="button" aria-pressed={categoryFilter==='all'} onClick={()=>selectCategory('all')}><span>全部用途</span><b>{index.parts.length}</b></button>
      {index.categories.map(cat=><button type="button" key={cat.id} aria-pressed={categoryFilter===cat.id} onClick={()=>selectCategory(cat.id)}><span>{cat.name}</span><b>{index.parts.filter(p=>p.category===cat.id).length}</b></button>)}
      {!!subcategories.length && <div className="lib-subcategory-rail"><strong>细分文件夹</strong><button aria-pressed={!activeSubcategory} onClick={()=>setActiveSubcategory('')}>全部细分</button>{subcategories.map(name=><button key={name} aria-pressed={activeSubcategory===name} onClick={()=>setActiveSubcategory(name)}>{name}</button>)}</div>}
    </nav>
    </section>
    {gridHost && createPortal(library,gridHost)}
  </>
}
