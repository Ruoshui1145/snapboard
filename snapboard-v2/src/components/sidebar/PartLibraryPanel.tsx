// ============ 配件库面板 — 分类浏览 + 拖出 + 排序 + 批量操作 ============
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePartLibrary } from '../../hooks/usePartLibrary'
import {
  PART_CATEGORY_FOLDER, PART_CATEGORY_OPTIONS,
  mountNeedsCalibration, mountStatusLabel, partPreviewPath,
  type PartCategory, type PartDefinition,
} from '../../partLibrary/types'
import { PartImportDialog, PartRenameDialog } from '../partLibrary/PartImportDialog'
import { PartModelThumbnail } from '../partLibrary/PartModelThumbnail'
import { PartMountCalibrator } from '../partLibrary/PartMountCalibrator'

interface Props {
  /** 配件被拖出时的回调 (startDrag) */
  onDragPart?: (def: PartDefinition, e: React.DragEvent) => void
  onDragEnd?: () => void
  /** 不渲染自己的标题 (由右侧栏折叠卡片头部承担) */
  headerless?: boolean
}

type SortMode = 'default' | 'name' | 'category' | 'format' | 'status'

export function PartLibraryPanel({ onDragPart, onDragEnd, headerless }: Props) {
  const { index, loading, error, activeCategory, setActiveCategory } = usePartLibrary()
  const [calibrating, setCalibrating] = useState<PartDefinition | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [renaming, setRenaming] = useState<PartDefinition | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [importError, setImportError] = useState('')
  // 排序：模式 + 方向 + 资源序号（写回 part.json.sortOrder）
  const [sortMode, setSortMode] = useState<SortMode>('default')
  const [sortAsc, setSortAsc] = useState(true)
  const [order, setOrder] = useState<string[]>([])
  const [reorderId, setReorderId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // 批量 (文件管理式): 复选 + 底部动作条
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!index) return
    setOrder([...index.parts]
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name, 'zh-CN'))
      .map(part => part.id))
  }, [index])

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
    const list = (index?.parts ?? []).filter(part => part.category === activeCategory)
    if (sortMode === 'default') {
      const rank = new Map(order.map((id, i) => [id, i]))
      list.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        || (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name, 'zh-CN'))
    } else {
      const dir = sortAsc ? 1 : -1
      const compare = (a: PartDefinition, b: PartDefinition) => {
        if (sortMode === 'name') return dir * a.name.localeCompare(b.name, 'zh-CN')
        if (sortMode === 'category') return dir * (a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'zh-CN'))
        if (sortMode === 'format') return dir * ((a.model.format ?? '').localeCompare(b.model.format ?? '') || a.name.localeCompare(b.name, 'zh-CN'))
        return dir * (Number(mountNeedsCalibration(a)) - Number(mountNeedsCalibration(b)) || a.name.localeCompare(b.name, 'zh-CN'))
      }
      list.sort(compare)
    }
    return list
  }, [index, activeCategory, sortMode, sortAsc, order])

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

  return (
    <div style={{ padding: headerless ? '4px 10px 10px' : 8 }}>
      {!headerless && (
        <h4 style={{ margin: '8px 0', fontSize: 12, color: '#888' }}>🧩 配件库</h4>
      )}

      {/* ============ 吸顶头部: 资源包摘要 + 导入 + 排序工具栏 ============ */}
      <div className="lib-sticky-head">
        <details className="lib-pack-summary">
          <summary>
            {index.packages?.length ?? 0} 个资源包 · {index.parts.length} 个零件 · {index.designs?.length ?? 0} 个方案
          </summary>
          {index.packages?.map(pack => (
            <div key={pack.id} className="lib-pack-row">
              <span>{pack.name}</span>
              <span>v{pack.version} · {pack.author}</span>
            </div>
          ))}
        </details>

        <div
          className={'part-import-dropzone' + (dropActive ? ' active' : '')}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              fileInput.current?.click()
            }
          }}
          onDragEnter={event => { event.preventDefault(); setDropActive(true) }}
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true) }}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false)
          }}
          onDrop={event => {
            event.preventDefault()
            event.stopPropagation()
            setDropActive(false)
            chooseFiles(event.dataTransfer.files)
          }}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".3mf,.stl,.glb,.gltf,model/3mf,model/stl,model/gltf-binary,model/gltf+json"
            onChange={event => {
              chooseFiles(event.target.files ?? undefined)
              event.target.value = ''
            }}
          />
          <span className="part-import-icon">{dropActive ? '↓' : '+'}</span>
          <span><b>{dropActive ? '松开即可读取模型' : '导入配件模型（可多选）'}</b><small>拖到这里，或点击选择 · 3MF / STL / GLB / GLTF · 支持批量</small></span>
        </div>
        {importError && <div className="part-import-inline-error">{importError}</div>}

        {/* 排序 + 批量工具栏 */}
        <div className="lib-sort-bar">
          <select
            className="lib-sort-select"
            value={sortMode}
            onChange={event => setSortMode(event.target.value as SortMode)}
            title="排序方式：资源序号 / 名称 / 类别 / 模型格式 / 标定状态"
          >
            <option value="default">排序: 资源序号</option>
            <option value="name">排序: 名称</option>
            <option value="category">排序: 类别</option>
            <option value="format">排序: 模型格式</option>
            <option value="status">排序: 标定状态</option>
          </select>
          <button
            type="button"
            className="lib-sort-dir"
            disabled={sortMode === 'default'}
            title={sortAsc ? '当前升序 · 点击切换降序' : '当前降序 · 点击切换升序'}
            onClick={() => setSortAsc(value => !value)}
          >{sortAsc ? '↑' : '↓'}</button>
          <button
            type="button"
            className={'lib-batch-toggle' + (batchMode ? ' on' : '')}
            disabled={!current.length}
            onClick={toggleBatch}
            title="进入批量选择模式：多选后按类别移动或删除"
          >{batchMode ? '退出批量' : '批量'}</button>
        </div>
        {sortMode === 'default' && !batchMode && (
          <div className="lib-sort-hint">拖动卡片左侧的⠿手柄可调整序号，并自动写回资源包</div>
        )}

        {/* 分类标签 (圆角胶囊) — 常驻吸顶层, 快速切换 */}
        <div className="lib-cats">
          {index.categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={'lib-cat' + (activeCategory === cat.id ? ' on' : '')}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* 零件卡片 (悬浮圆角卡) */}
      <div className="lib-list">
        {sorted.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: 8, lineHeight: 1.55 }}>
            该分类暂无零件。可以：
            <div style={{ margin: '4px 0' }}>
              ① 在上方拖入/选择模型批量导入；或
            </div>
            <div>
              ② 用文件管理器把 3MF/STL 直接拖进
              <code style={{ color: 'var(--accent)' }}> 配件资源包/对应大类文件夹/</code>
              （如 <code style={{ color: 'var(--accent)' }}>01-挂钩类/</code>），开发服务器会自动收录。
            </div>
          </div>
        )}
        {sorted.map(part => (
          <div
            key={part.id}
            className={'lib-part' + (mountNeedsCalibration(part) ? ' needs-calibration' : '')
              + (dropTargetId === part.id && reorderId !== null && reorderId !== part.id ? ' is-drop-target' : '')}
            onDragOver={reorderActive ? event => { event.preventDefault(); setDropTargetId(part.id) } : undefined}
            onDrop={reorderActive ? event => { event.preventDefault(); handleReorderDrop(part.id) } : undefined}
          >
            {batchMode ? (
              <span
                className={'lib-part-check' + (selected.has(part.id) ? ' on' : '')}
                onClick={() => toggleSelect(part.id)}
                aria-label={selected.has(part.id) ? '取消选择' : '选择'}
              >{selected.has(part.id) ? '✓' : ''}</span>
            ) : sortMode === 'default' ? (
              <span
                className="lib-order-handle"
                draggable
                title="拖动调整资源序号"
                onDragStart={event => {
                  event.stopPropagation()
                  event.dataTransfer.setData('application/snapboard-reorder', part.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setReorderId(part.id)
                }}
                onDragEnd={() => { setReorderId(null); setDropTargetId(null) }}
              >⠿</span>
            ) : null}
            <div
              className="lib-part-dragarea"
              draggable={!batchMode && !mountNeedsCalibration(part)}
              onDragStart={e => {
                if (batchMode) {
                  e.preventDefault()
                  return
                }
                if (mountNeedsCalibration(part)) {
                  e.preventDefault()
                  setCalibrating(part)
                  return
                }
                onDragPart?.(part, e)
              }}
              onDragEnd={onDragEnd}
              onClick={batchMode ? () => toggleSelect(part.id) : undefined}
              role={batchMode ? 'checkbox' : undefined}
              aria-checked={batchMode ? selected.has(part.id) : undefined}
              title={batchMode ? '点击选择/取消' : mountNeedsCalibration(part) ? '请先完成装配标定' : '拖到中央 3D 视图进行装配'}
            >
              {/* 有缩略图则直接显示；没有时按分类显示清晰占位图标。 */}
              <div className="lib-part-thumb">
                <PartModelThumbnail part={part} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, color: '#e0e0e0' }}>{part.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{part.description}</div>
                <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
                  <span className="lib-part-badge order">#{String(part.sortOrder ?? 0).padStart(3, '0')}</span>
                  <span className="lib-part-badge">{part.model.format?.toUpperCase() ?? partPreviewPath(part)?.split('.').pop()?.toUpperCase()}</span>
                  <span className="lib-part-badge">{part.kind === 'parametric' ? '参数化' : '固定尺寸'}</span>
                  <span className="lib-part-badge">{mountStatusLabel(part)}</span>
                  {part.author && <span className="lib-part-badge" title={`来自 ${part.packageId}@${part.packageVersion}`}>by {part.author}</span>}
                </div>
              </div>
            </div>
            <div className="lib-part-actions">
              <button
                className="lib-part-settings"
                title="配件信息、排序、分类和删除"
                aria-label={`管理 ${part.name} 的信息和文件位置`}
                draggable={false}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); setRenaming(part) }}
              >✎</button>
              <button
                className="lib-part-settings"
                title="设置默认朝向和装配吸附点"
                aria-label={`设置 ${part.name} 的装配吸附点`}
                draggable={false}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); setCalibrating(part) }}
              >⚙</button>
            </div>
          </div>
        ))}
      </div>

      {/* 批量动作条 (文件管理式: 全选/清空/移动到分类/删除) */}
      {batchMode && (
        <div className="lib-batch-bar">
          <span>已选 {selected.size} · 共 {sorted.length}</span>
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
          <button type="button" className="danger" disabled={batchBusy || !selected.size} onClick={() => void runBatch({ action: 'delete' })}>{batchBusy ? '处理中…' : '删除'}</button>
        </div>
      )}

      {!!index.warnings?.length && (
        <details style={{ marginTop: 8, fontSize: 10.5, color: '#d9a441' }}>
          <summary>资源包提示 ({index.warnings.length})</summary>
          {index.warnings.map((warning, i) => <div key={i} style={{ marginTop: 4 }}>• {warning}</div>)}
        </details>
      )}
      {calibrating && (
        <PartMountCalibrator
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
          onClose={() => setPendingFiles([])}
          onImported={category => {
            setPendingFiles([])
            setActiveCategory(category)
          }}
        />
      )}
      {renaming && (
        <PartRenameDialog
          part={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => setRenaming(null)}
        />
      )}
    </div>
  )
}
