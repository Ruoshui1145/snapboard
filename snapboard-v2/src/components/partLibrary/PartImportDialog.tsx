import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { PART_CATEGORY_FOLDER, PART_CATEGORY_OPTIONS, type PartCategory, type PartDefinition } from '../../partLibrary/types'
import { dimensionsLabel, inspectModelFile, type ModelInspection } from '../../utils/modelInspection'

const readableSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const fileStem = (name: string) => name.replace(/\.[^.]+$/, '')
const CUSTOM_SUBCATEGORY = '__custom__'

interface FileStatus {
  name: string
  size: number
  included: boolean
  state: 'pending' | 'ok' | 'fail'
  error?: string
  inspection?: ModelInspection
  inspecting?: boolean
}

interface FolderListResponse {
  groups?: unknown
  error?: string
}

interface ImportProps {
  files: File[]
  onClose: () => void
  onImported: (category: PartCategory) => void
  /** 从当前配件库大类打开导入时，沿用当前大类，便于直接看到该类已有细分目录。 */
  initialCategory?: PartCategory
}

/** 导入新配件 (支持单文件与批量; 可选择大类, 按大类归档到“配件资源包/<大类文件夹>/”) */
export function PartImportDialog({ files, onClose, onImported, initialCategory = 'custom' }: ImportProps) {
  const single = files.length === 1
  const initialName = single ? fileStem(files[0].name) : ''
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState('')
  const [subcategory, setSubcategory] = useState('')
  const [subcategoryMode, setSubcategoryMode] = useState<'none' | 'existing' | 'custom'>('none')
  const [subcategoryOptions, setSubcategoryOptions] = useState<string[]>([])
  const [subcategoryLoading, setSubcategoryLoading] = useState(false)
  const [usageImageFile, setUsageImageFile] = useState<File | null>(null)
  const [category, setCategory] = useState<PartCategory>(initialCategory)
  const [statuses, setStatuses] = useState<FileStatus[]>(() =>
    files.map(file => ({ name: file.name, size: file.size, included: true, state: 'pending' as const })))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [renderNodes, setRenderNodes] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    setSubcategory('')
    setSubcategoryMode('none')
    setSubcategoryLoading(true)
    fetch(`/api/part-library/group?category=${encodeURIComponent(category)}`, { cache: 'no-store' })
      .then(response => response.json().then((result: FolderListResponse) => ({ response, result })))
      .then(({ response, result }) => {
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
        const groups = Array.isArray(result.groups)
          ? result.groups.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
          : []
        if (alive) setSubcategoryOptions([...new Set(groups)].sort((a, b) => a.localeCompare(b, 'zh-CN')))
      })
      .catch(() => { if (alive) setSubcategoryOptions([]) })
      .finally(() => { if (alive) setSubcategoryLoading(false) })
    return () => { alive = false }
  }, [category])

  useEffect(() => {
    let alive = true
    files.forEach((file, index) => {
      setStatuses(prev => prev.map((status, statusIndex) => statusIndex === index ? { ...status, inspecting: true } : status))
      inspectModelFile(file)
        .then(inspection => {
          if (!alive) return
          setStatuses(prev => prev.map((status, statusIndex) => statusIndex === index ? { ...status, inspection, inspecting: false } : status))
          if (inspection.objects.length > 1) setRenderNodes(prev => ({ ...prev, [file.name]: inspection.objects[0].path }))
        })
        .catch(() => {
          if (alive) setStatuses(prev => prev.map((status, statusIndex) => statusIndex === index ? { ...status, inspecting: false } : status))
        })
    })
    return () => { alive = false }
  }, [files])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const importOne = async (file: File, index: number, importName: string) => {
    const fileStatus = statuses[index]
    const query = new URLSearchParams({
      filename: file.name,
      name: importName,
      category,
      description: description.trim(),
      subcategory: subcategory.trim(),
    })
    if (fileStatus?.inspection) query.set('dimensionsMm', JSON.stringify([
      fileStatus.inspection.dimensionsMm.x,
      fileStatus.inspection.dimensionsMm.y,
      fileStatus.inspection.dimensionsMm.z,
    ]))
    const renderNode = renderNodes[file.name]
    if (renderNode) query.set('renderNode', renderNode)
    const folder = PART_CATEGORY_FOLDER[category]
    if (folder) query.set('folder', folder)
    const response = await fetch(`/api/part-library/import?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `导入失败 (HTTP ${response.status})`)
    setStatuses(prev => prev.map((s, i) => i === index ? { ...s, state: 'ok' } : s))
    return result as { packageId?: string; localId?: string }
  }

  const uploadUsageImage = async (target: { packageId?: string; localId?: string }) => {
    if (!usageImageFile || !target.packageId || !target.localId) return
    const query = new URLSearchParams({
      packageId: target.packageId,
      localId: target.localId,
      filename: usageImageFile.name,
    })
    const response = await fetch(`/api/part-library/usage-image?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': usageImageFile.type || 'application/octet-stream' },
      body: usageImageFile,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `实装示例图上传失败 (HTTP ${response.status})`)
  }

  const submit = async () => {
    if (!single && name.trim()) return // 批量模式不强制命名 (文件名即名称)
    if (single && !name.trim()) {
      setError('请填写配件名称')
      return
    }
    setBusy(true)
    setError('')
    const selectedIndexes = statuses.map((status, index) => status.included ? index : -1).filter(index => index >= 0)
    if (!selectedIndexes.length) {
      setError('请至少保留一个要导入的模型文件')
      setBusy(false)
      return
    }
    let failed = 0
    let succeeded = 0
    for (const i of selectedIndexes) {
      const importName = single ? name.trim() : fileStem(files[i].name)
      try {
        const imported = await importOne(files[i], i, importName)
        if (single) await uploadUsageImage(imported)
        succeeded++
      } catch (cause) {
        failed++
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, state: 'fail', error: message } : s))
        setError(`“${files[i].name}”导入失败：${message}`)
        // 单个模型失败不阻断其余文件；每一行保留自己的最终状态。
      }
    }
    if (succeeded > 0) {
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
    }
    setDone(true)
    if (failed > 0) setError(`批量导入完成：成功 ${succeeded} 个，失败 ${failed} 个。请查看文件列表中的错误。`)
    setBusy(false)
    if (failed === 0 && succeeded > 0) onImported(category)
  }

  const categoryLabel = useMemo(
    () => PART_CATEGORY_OPTIONS.find(option => option.id === category)?.label ?? '自定义',
    [category],
  )
  const folderNote = PART_CATEGORY_FOLDER[category]
    ? `按大类归档：配件资源包/${PART_CATEGORY_FOLDER[category]}/`
    : '按大类归档：配件资源包/我的配件/'

  return createPortal(
    <div className="part-import-backdrop" role="presentation" onPointerDown={event => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <div className="part-import-modal" role="dialog" aria-modal="true" aria-labelledby="part-import-title">
        <header>
          <div>
            <strong id="part-import-title">{single ? '导入新配件' : `批量导入配件 (${files.length} 个)`}</strong>
            <span>{single ? '确认信息后将自动加入配件库' : `确认信息后将按大类批量导入，共 ${files.length} 个模型`}</span>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </header>

        <div className="part-import-scroll" style={{ overflowY: 'auto', minHeight: 0 }}>
          {/* 文件清单 (批量可滚动) */}
          <div className="part-import-list">
            {statuses.map((item, index) => (
              <div key={index} className="part-import-file-row">
                {files.length > 1 && <label className="part-import-file-toggle" title={item.included ? '将此文件加入配件库' : '跳过此文件，不导入配件库'}>
                  <input type="checkbox" checked={item.included} disabled={busy} onChange={event => setStatuses(prev => prev.map((status, statusIndex) => statusIndex === index ? { ...status, included: event.target.checked } : status))} />
                  <span>{item.included ? '导入' : '跳过'}</span>
                </label>}
                <span className="part-import-file-icon">📦</span>
                <div className="part-import-file-copy">
                  <b title={item.name}>{item.name}</b>
                  <small>{item.name.split('.').pop()?.toUpperCase()} · {readableSize(item.size)}</small>
                  <small className="part-import-dimensions">{item.inspection ? `尺寸 ${dimensionsLabel(item.inspection.dimensionsMm)}` : item.inspecting ? '尺寸读取中…' : '尺寸暂不可读'}</small>
                  {item.inspection && item.inspection.objects.length > 1 && (
                    <label className="part-import-render-choice">
                      <span>实际渲染</span>
                      <select value={renderNodes[item.name] ?? ''} onChange={event => setRenderNodes(prev => ({ ...prev, [item.name]: event.target.value }))}>
                        {item.inspection.objects.map(option => <option key={option.path} value={option.path}>{option.label} · {dimensionsLabel(option.dimensionsMm)}</option>)}
                      </select>
                    </label>
                  )}
                  {item.error && <em className="part-import-file-error">{item.error}</em>}
                </div>
                <em className={'part-import-file-state ' + item.state}>
                  {item.state === 'ok' ? '✓ 完成' : item.state === 'fail' ? '失败' : busy ? '导入中…' : '待导入'}
                </em>
              </div>
            ))}
          </div>

          <div className="part-import-fields">
            {single && (
              <label>
                <span>配件名称</span>
                <input
                  autoFocus
                  value={name}
                  maxLength={80}
                  placeholder="例如：双孔墙面底座"
                  onChange={event => setName(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && !busy) void submit() }}
                />
                <small>这里的显示名称可以与原文件名不同。</small>
              </label>
            )}
            {!single && (
              <label>
                <span>批量说明 <i>可选</i></span>
                <small>批量模式以文件名作为配件名称；如需逐一命名请在导入后使用卡片“改名”。</small>
              </label>
            )}
            <label>
              <span>所属分类</span>
              <select value={category} onChange={event => setCategory(event.target.value as PartCategory)}>
                {PART_CATEGORY_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <small>{folderNote}</small>
            </label>
            <label>
              <span>细分文件夹 <i>可选</i></span>
              <select
                value={subcategoryMode === 'custom' ? CUSTOM_SUBCATEGORY : subcategory}
                disabled={subcategoryLoading}
                onChange={event => {
                  const value = event.target.value
                  if (value === CUSTOM_SUBCATEGORY) {
                    setSubcategoryMode('custom')
                    setSubcategory('')
                  } else {
                    setSubcategoryMode(value ? 'existing' : 'none')
                    setSubcategory(value)
                  }
                }}
              >
                <option value="">不指定（放在大类根目录）</option>
                {subcategoryOptions.map(option => <option key={option} value={option}>{option}</option>)}
                <option value={CUSTOM_SUBCATEGORY}>自定义…</option>
              </select>
              {subcategoryMode === 'custom' && <input value={subcategory} maxLength={40} autoFocus placeholder="输入新的细分文件夹名称" onChange={event => setSubcategory(event.target.value)} />}
              <small>{subcategoryLoading ? '正在读取已有细分文件夹…' : subcategoryMode === 'custom' ? '仅在没有合适的已有文件夹时使用；导入时会自动创建。' : '先从已有细分文件夹中选择；自定义选项固定在列表最后。'}</small>
            </label>
            <label>
              <span>说明 <i>可选</i></span>
              <textarea
                value={description}
                maxLength={240}
                placeholder="用途、规格或安装说明"
                onChange={event => setDescription(event.target.value)}
              />
            </label>
            {single && <label>
              <span>实装示例图 <i>可选</i></span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setUsageImageFile(event.target.files?.[0] ?? null)} />
              <small>{usageImageFile ? `已选择：${usageImageFile.name}` : '悬停配件缩略图时显示，例如装到宿舍板后的照片。'}</small>
            </label>}
          </div>

          <div className="part-import-note">
            导入后需要用配件卡片上的“设置”标定吸附面与默认朝向，完成后即可拖入 3D 视图装配。
          </div>
          {error && <div className="part-import-error">{error}</div>}
        </div>

        <footer>
          <button type="button" onClick={onClose} disabled={busy}>{done ? '关闭' : '取消'}</button>
          <button type="button" className="primary" onClick={() => void submit()}
            disabled={busy || done || (single && !name.trim())}>
            {busy ? '正在导入…' : done ? '已完成' : single ? `导入到${categoryLabel}库` : `批量导入 ${files.length} 个`}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

interface RenameProps {
  part: PartDefinition
  onClose: () => void
  onRenamed: () => void
}

export function PartRenameDialog({ part, onClose, onRenamed }: RenameProps) {
  const [name, setName] = useState(part.name)
  const [description, setDescription] = useState(part.description ?? '')
  const [subcategory, setSubcategory] = useState(part.subcategory ?? '')
  const [subcategoryMode, setSubcategoryMode] = useState<'none' | 'existing' | 'custom'>(part.subcategory ? 'existing' : 'none')
  const [subcategoryOptions, setSubcategoryOptions] = useState<string[]>([])
  const [subcategoryLoading, setSubcategoryLoading] = useState(false)
  const [sortOrder, setSortOrder] = useState(part.sortOrder ?? 0)
  const [category, setCategory] = useState<PartCategory>(part.category)
  const [usageImageFile, setUsageImageFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const sameCategory = category === part.category
    setSubcategory(sameCategory ? (part.subcategory ?? '') : '')
    setSubcategoryMode(sameCategory && part.subcategory ? 'existing' : 'none')
    setSubcategoryLoading(true)
    fetch(`/api/part-library/group?category=${encodeURIComponent(category)}`, { cache: 'no-store' })
      .then(response => response.json().then((result: FolderListResponse) => ({ response, result })))
      .then(({ response, result }) => {
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
        const groups = Array.isArray(result.groups)
          ? result.groups.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
          : []
        if (!alive) return
        const sorted = [...new Set(groups)].sort((a, b) => a.localeCompare(b, 'zh-CN'))
        setSubcategoryOptions(sorted)
        if (sameCategory && part.subcategory && !sorted.includes(part.subcategory)) setSubcategoryMode('custom')
      })
      .catch(() => { if (alive) setSubcategoryOptions([]) })
      .finally(() => { if (alive) setSubcategoryLoading(false) })
    return () => { alive = false }
  }, [category, part.category, part.subcategory])

  const replaceUsageImage = async () => {
    if (!usageImageFile) return
    if (!part.packageId || !part.localId) throw new Error('当前配件缺少资源包 ID，无法保存实装照片')
    const query = new URLSearchParams({ packageId: part.packageId, localId: part.localId, filename: usageImageFile.name })
    const response = await fetch(`/api/part-library/usage-image?${query}`, {
      method: 'POST', headers: { 'Content-Type': usageImageFile.type || 'application/octet-stream' }, body: usageImageFile,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `实装图保存失败 (HTTP ${response.status})`)
  }

  const removeUsageImage = async () => {
    if (!part.model.usageImage) return
    if (!part.packageId || !part.localId) {
      setError('当前配件缺少资源包 ID，无法删除实装照片')
      return
    }
    if (!window.confirm('确定删除这张实际安装照片吗？模型和配件资料不会受影响。')) return
    setBusy(true)
    setError('')
    try {
      const query = new URLSearchParams({ packageId: part.packageId, localId: part.localId })
      const response = await fetch(`/api/part-library/usage-image?${query}`, { method: 'DELETE' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `实装图删除失败 (HTTP ${response.status})`)
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
      onRenamed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const submit = async () => {
    const cleanName = name.trim()
    if (!cleanName) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/part-library/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: part.packageId,
          localId: part.localId,
          name: cleanName,
          description: description.trim(),
          subcategory: subcategory.trim(),
          sortOrder,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `修改失败 (HTTP ${response.status})`)
      await replaceUsageImage()
      if (category !== part.category) {
        const moveResponse = await fetch('/api/part-library/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'move-category',
            ids: [part.id],
            category,
            folder: PART_CATEGORY_FOLDER[category] || '我的配件',
          }),
        })
        const moveResult = await moveResponse.json().catch(() => ({}))
        if (!moveResponse.ok || moveResult.failed?.length) {
          throw new Error(moveResult.error || moveResult.failed?.[0]?.error || `分类移动失败 (HTTP ${moveResponse.status})`)
        }
      }
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
      onRenamed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`确定永久删除“${part.name}”吗？模型、缩略图和 part.json 都会被删除，无法恢复。`)) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/part-library/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ids: [part.id] }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.failed?.length) throw new Error(result.error || result.failed?.[0]?.error || `删除失败 (HTTP ${response.status})`)
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
      onRenamed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="part-import-backdrop" role="presentation" onPointerDown={event => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <div className="part-import-modal compact" role="dialog" aria-modal="true" aria-labelledby="part-rename-title">
        <header>
          <div>
            <strong id="part-rename-title">配件资料与展示</strong>
            <span>名称、用途、分类、实装照片和文件位置</span>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </header>
        <div className="part-import-fields">
          <label>
            <span>配件名称</span>
            <input autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !busy) void submit() }} />
          </label>
          <label>
            <span>排序序号</span>
            <input type="number" min={0} max={999999} step={10} value={sortOrder}
              onChange={event => setSortOrder(Math.max(0, Math.round(Number(event.target.value) || 0)))} />
            <small>外部导入会自动追加序号；拖动排序手柄后也会自动写回。</small>
          </label>
          <label>
            <span>所属分类 / 文件位置</span>
            <select value={category} onChange={event => setCategory(event.target.value as PartCategory)}>
              {PART_CATEGORY_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label} · {PART_CATEGORY_FOLDER[option.id] || '我的配件'}</option>)}
            </select>
            <small>当前：配件资源包/{part.pack ?? '未知资源包'}/ · 保存后会移动整个零件目录。</small>
          </label>
          <label>
            <span>说明</span>
            <textarea value={description} maxLength={240} onChange={event => setDescription(event.target.value)} />
          </label>
          <label>
            <span>细分文件夹 <i>可选</i></span>
            <select
              value={subcategoryMode === 'custom' ? CUSTOM_SUBCATEGORY : subcategory}
              disabled={subcategoryLoading}
              onChange={event => {
                const value = event.target.value
                if (value === CUSTOM_SUBCATEGORY) {
                  setSubcategoryMode('custom')
                  setSubcategory('')
                } else {
                  setSubcategoryMode(value ? 'existing' : 'none')
                  setSubcategory(value)
                }
              }}
            >
              <option value="">不指定（放在大类根目录）</option>
              {subcategoryOptions.map(option => <option key={option} value={option}>{option}</option>)}
              <option value={CUSTOM_SUBCATEGORY}>自定义…</option>
            </select>
            {subcategoryMode === 'custom' && <input value={subcategory} maxLength={40} autoFocus placeholder="输入新的细分文件夹名称" onChange={event => setSubcategory(event.target.value)} />}
            <small>{subcategoryLoading ? '正在读取已有细分文件夹…' : subcategoryMode === 'custom' ? '当前名称不在已有目录中，将按新目录保存。' : '先从已有目录选择；自定义选项固定在最后。'}</small>
          </label>
          <label className="part-edit-usage-field">
            <span>实际安装照片 <i>可选</i></span>
            {part.model.usageImage && <img src={`/partLibrary/${part.model.usageImage}`} alt={`${part.name} 当前实装示例`} />}
            <div className="part-edit-usage-actions">
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setUsageImageFile(event.target.files?.[0] ?? null)} />
              {part.model.usageImage && <button type="button" className="danger" onClick={() => void removeUsageImage()} disabled={busy}>删除照片</button>}
            </div>
            <small>{usageImageFile ? `点击“保存信息”替换为：${usageImageFile.name}` : part.model.usageImage ? '可重新选择图片替换，或点击“删除照片”立即移除。' : '添加装到洞洞板后的真实照片，帮助用户理解用途。'}</small>
          </label>
        </div>
        {error && <div className="part-import-error">{error}</div>}
        <footer>
          <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>删除零件</button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="primary" onClick={() => void submit()}
            disabled={busy || !name.trim()}>
            {busy ? '正在保存…' : '保存信息'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
