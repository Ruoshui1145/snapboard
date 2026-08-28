import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { PART_CATEGORY_FOLDER, PART_CATEGORY_OPTIONS, type PartCategory, type PartDefinition } from '../../partLibrary/types'

const readableSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const fileStem = (name: string) => name.replace(/\.[^.]+$/, '')

interface FileStatus {
  name: string
  size: number
  state: 'pending' | 'ok' | 'fail'
  error?: string
}

interface ImportProps {
  files: File[]
  onClose: () => void
  onImported: (category: PartCategory) => void
}

/** 导入新配件 (支持单文件与批量; 可选择大类, 按大类归档到“配件资源包/<大类文件夹>/”) */
export function PartImportDialog({ files, onClose, onImported }: ImportProps) {
  const single = files.length === 1
  const initialName = single ? fileStem(files[0].name) : ''
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<PartCategory>('custom')
  const [statuses, setStatuses] = useState<FileStatus[]>(() =>
    files.map(file => ({ name: file.name, size: file.size, state: 'pending' as const })))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const importOne = async (file: File, index: number, importName: string) => {
    const query = new URLSearchParams({
      filename: file.name,
      name: importName,
      category,
      description: description.trim(),
    })
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
  }

  const submit = async () => {
    if (!single && name.trim()) return // 批量模式不强制命名 (文件名即名称)
    if (single && !name.trim()) {
      setError('请填写配件名称')
      return
    }
    setBusy(true)
    setError('')
    let failed = 0
    let succeeded = 0
    for (let i = 0; i < files.length; i++) {
      const importName = single ? name.trim() : fileStem(files[i].name)
      try {
        await importOne(files[i], i, importName)
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
                <span className="part-import-file-icon">📦</span>
                <div>
                  <b title={item.name}>{item.name}</b>
                  <small>{item.name.split('.').pop()?.toUpperCase()} · {readableSize(item.size)}</small>
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
              <span>说明 <i>可选</i></span>
              <textarea
                value={description}
                maxLength={240}
                placeholder="用途、规格或安装说明"
                onChange={event => setDescription(event.target.value)}
              />
            </label>
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
  const [sortOrder, setSortOrder] = useState(part.sortOrder ?? 0)
  const [category, setCategory] = useState<PartCategory>(part.category)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
          sortOrder,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `修改失败 (HTTP ${response.status})`)
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
            <strong id="part-rename-title">配件信息与文件位置</strong>
            <span>名称、序号、分类和删除都在这里管理</span>
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
