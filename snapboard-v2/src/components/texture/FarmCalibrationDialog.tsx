import { useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SNAPCOLOR_LUTS, normalizeSnapColorLutId, type SnapColorMaterial } from '../../utils/snapColorLut'
import type { SnapColorProfile } from '../../utils/snapColorPackage'
import { useAppStore } from '../../store/useAppStore'
import { calibrationCornerReducer, calibrationPointFromClick, emptyCalibrationCorners, validCalibrationQuad, type CalibrationPoint } from '../../utils/calibrationCorners'
import './FarmCalibrationDialog.css'
import { useFileDrop } from '../../hooks/useFileDrop'

const MODES = [
  { value: 'RYBW', lut: 'snapcolor-petg-rybw', pages: 1 },
  { value: 'CMYW', lut: 'snapcolor-petg-cmyw', pages: 1 },
  { value: '5-Color Extended (1444)', lut: 'snapcolor-petg-5color', pages: 2 },
] as const
const DEFAULT_SUPPORTED_MODES: string[] = MODES.map(item => item.value)

type Point = CalibrationPoint
type ApiResult = {
  taskId: string
  message?: string
  pages?: number | string[]
  cellCount?: number
  invalidCells?: number | number[]
  previewUrl?: string
  dimensionsMm?: [number, number]
  files?: { name: string; url: string }[]
  packageUrl?: string
}

type Metadata = {
  name: string
  revision: string
  batch: string
  machine: string
  nozzleMm: string
  layerHeightMm: string
  layerCount: string
  backing: string
  printFace: string
  lineWidthMm: string
  speedMmS: string
  temperatureC: string
  notes: string
}

const initialMetadata: Metadata = {
  name: '', revision: 'r001', batch: '', machine: '', nozzleMm: '0.4',
  layerHeightMm: '0.08', layerCount: '5', backing: 'White', printFace: 'face-down',
  lineWidthMm: '0.42', speedMmS: '', temperatureC: '', notes: '',
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const invalidCount = (result?: ApiResult) => Array.isArray(result?.invalidCells) ? result.invalidCells.length : result?.invalidCells ?? 0
const packageApi = () => import('../../utils/snapColorPackage')

async function farmRequest(action: string, body: Record<string, unknown>): Promise<ApiResult> {
  const response = await fetch('/api/snapcolor/farm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await response.json().catch(() => ({})) as ApiResult & { error?: string }
  if (!response.ok) throw new Error(data.error || data.message || `本地校色服务返回 ${response.status}`)
  if (!data.taskId) throw new Error('校色服务未返回任务 ID')
  return data
}

async function readPhoto(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('照片请使用 JPG、PNG 或 WebP')
  if (file.size > 10 * 1024 * 1024) throw new Error('照片超过 10 MB，请压缩后再上传')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取照片'))
    reader.readAsDataURL(file)
  })
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  return { dataUrl, width: image.naturalWidth, height: image.naturalHeight }
}

function CornerNumberInput({ value, max, label, disabled, onCommit }: {
  value: number | null; max: number; label: string; disabled: boolean; onCommit(value: number): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  return <input type="text" inputMode="numeric" aria-label={label} disabled={disabled} value={draft ?? (value ?? '')}
    onFocus={event => { cancelled.current = false; setDraft(String(value ?? '')); event.currentTarget.select() }}
    onChange={event => setDraft(event.currentTarget.value)}
    onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur()
      if (event.key === 'Escape') { cancelled.current = true; setDraft(null); event.currentTarget.blur() }
    }}
    onBlur={event => {
      if (!cancelled.current && /^\d+$/.test(event.currentTarget.value.trim())) {
        const next = Number(event.currentTarget.value.trim())
        if (next <= max && next !== value) onCommit(next)
      }
      cancelled.current = false
      setDraft(null)
    }} />
}

export function FarmCalibrationDialog({ onClose }: {
  onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [available, setAvailable] = useState(false)
  const [reason, setReason] = useState('正在检查本地校色服务…')
  const [supportedModes, setSupportedModes] = useState<string[]>(DEFAULT_SUPPORTED_MODES)
  const [profiles, setProfiles] = useState<SnapColorProfile[]>([])
  const [tab, setTab] = useState<'board' | 'photo' | 'profile'>('board')
  const [mode, setMode] = useState<string>(MODES[0].value)
  const modeInfo = MODES.find(item => item.value === mode) ?? MODES[0]
  const lut = SNAPCOLOR_LUTS.find(item => item.id === modeInfo.lut)!
  const [materials, setMaterials] = useState<SnapColorMaterial[]>(SNAPCOLOR_LUTS[0].materials.map(item => ({ ...item })))
  const [metadata, setMetadata] = useState<Metadata>(initialMetadata)
  const [blockSize, setBlockSize] = useState('5')
  const [gap, setGap] = useState('0.8')
  const [taskId, setTaskId] = useState('')
  const [board, setBoard] = useState<ApiResult | null>(null)
  const [page, setPage] = useState(1)
  const [photo, setPhoto] = useState<{ dataUrl: string; width: number; height: number } | null>(null)
  const [cornerDraft, dispatchCorners] = useReducer(calibrationCornerReducer, emptyCalibrationCorners())
  const { points: corners, active: activeCorner, history: cornerHistory } = cornerDraft
  const [offsetX, setOffsetX] = useState('0')
  const [offsetY, setOffsetY] = useState('0')
  const [zoom, setZoom] = useState('1')
  const [barrel, setBarrel] = useState('0')
  const [wb, setWb] = useState(false)
  const [bright, setBright] = useState(false)
  const [results, setResults] = useState<Record<number, ApiResult>>({})
  const [merged, setMerged] = useState<ApiResult | null>(null)
  const [fixIndex, setFixIndex] = useState('')
  const [fixColor, setFixColor] = useState('#FFFFFF')
  const [fixReason, setFixReason] = useState('')
  const [pack, setPack] = useState<ApiResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const currentLutId = useAppStore(state => normalizeSnapColorLutId(state.boardTexture.lutId))
  const setBoardTexture = useAppStore(state => state.setBoardTexture)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    let active = true
    void fetch('/api/snapcolor/farm').then(async response => {
      const state = await response.json() as { available?: boolean; reason?: string; modes?: string[] }
      if (active) { setAvailable(Boolean(response.ok && state.available)); setSupportedModes(state.modes?.length ? state.modes : DEFAULT_SUPPORTED_MODES); setReason(state.reason || (state.available ? '' : '当前网页没有本地 Python 校色服务，请在桌面版中生成校准板。')) }
    }).catch(() => { if (active) setReason('当前网页没有本地 Python 校色服务，请在桌面版中生成校准板。') })
    void packageApi().then(api => api.listSnapColorProfiles()).then(items => { if (active) setProfiles(items) }).catch(() => undefined)
    return () => { active = false; element?.close() }
  }, [])

  const updateMetadata = (key: keyof Metadata, value: string) => setMetadata(current => ({ ...current, [key]: value }))
  const choosePhoto = (file?: File) => {
    if (!file || busy) return
    void readPhoto(file).then(value => { setPhoto(value); dispatchCorners({ type: 'reset' }); setError('') })
      .catch(cause => setError(errorMessage(cause)))
  }
  const photoDrop = useFileDrop(files => {
    if (files.length !== 1) { setError('校准照片一次只接收一张'); return }
    choosePhoto(files[0])
  }, busy, { accept: 'image/jpeg,image/png,image/webp', maxBytes: 10 * 1024 * 1024, onError: setError })
  const resetTask = () => {
    setBoard(null); setTaskId(''); setResults({}); setMerged(null); setPack(null)
    setPage(1); setPhoto(null); dispatchCorners({ type: 'reset' })
  }
  const changeMode = (value: string) => {
    const selected = MODES.find(item => item.value === value) ?? MODES[0]
    const definition = SNAPCOLOR_LUTS.find(item => item.id === selected.lut)!
    setMode(selected.value)
    setMaterials(definition.materials.map(item => ({ ...item })))
    setMetadata(current => ({ ...current, backing: 'White', layerHeightMm: String(definition.layerHeight), layerCount: String(definition.layerCount) }))
    resetTask()
  }
  const run = async (action: string, payload: Record<string, unknown>, accept: (result: ApiResult) => void) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await farmRequest(action, payload)
      setTaskId(result.taskId)
      accept(result)
      setNotice(result.message || '完成')
      return result
    } catch (cause) { setError(errorMessage(cause)); return null }
    finally { setBusy(false) }
  }
  const generate = async () => {
    if (!materials.every(item => item.name.trim())) { setError('请填写每个耗材槽位的名称'); return }
    if (!Number.isFinite(Number(blockSize)) || Number(blockSize) <= 0 || !Number.isFinite(Number(gap)) || Number(gap) < 0) { setError('色块尺寸或间距无效'); return }
    setBusy(true); setError(''); setNotice('')
    setBoard(null); setResults({}); setMerged(null); setPack(null)
    try {
      const created = await farmRequest('create', { mode, materials, metadata })
      setTaskId(created.taskId)
      const generated = await farmRequest('generate', { taskId: created.taskId, mode, blockSize: Number(blockSize), gap: Number(gap), backing: metadata.backing })
      setBoard(generated); setResults({}); setMerged(null); setPack(null)
      setNotice(generated.message || '校准板已生成')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  const extract = () => {
    if (!photo || corners.some(point => !point)) { setError('请上传照片，并按左上、右上、右下、左下标记四角'); return }
    if (!validCalibrationQuad(corners, photo.width, photo.height)) { setError('四角必须按左上、右上、右下、左下顺序形成照片内的凸四边形，不能交叉或重合'); return }
    if ([offsetX, offsetY, zoom, barrel].some(value => value.trim() === '' || !Number.isFinite(Number(value))) || Number(zoom) <= 0) { setError('取样参数无效'); return }
    setResults(current => { const next = { ...current }; delete next[page]; return next })
    setMerged(null); setPack(null)
    void run('extract', {
      taskId, mode, page: `Page ${page}`, imageDataUrl: photo.dataUrl, corners,
      offsetX: Number(offsetX), offsetY: Number(offsetY), zoom: Number(zoom), barrel: Number(barrel), wb, bright,
    }, result => { setResults(current => ({ ...current, [page]: result })); setMerged(null); setPack(null) })
  }
  const fix = () => {
    const index = Number(fixIndex)
    if (!Number.isInteger(index) || index < 0 || !fixReason.trim()) { setError('请输入色格序号和修正原因'); return }
    const rgb = [1, 3, 5].map(position => parseInt(fixColor.slice(position, position + 2), 16))
    void run('fix', { taskId, mode, page: `Page ${page}`, index, rgb, reason: fixReason.trim() }, result => {
      setResults(current => ({ ...current, [page]: result })); setMerged(null); setPack(null); setFixReason('')
    })
  }
  const merge = () => void run('merge', { taskId, mode, pages: [1, 2] }, result => { setMerged(result); setPack(null) })
  const makePackage = () => {
    if (!metadata.name.trim() || !metadata.batch.trim() || !metadata.machine.trim()) { setError('请填写档案名称、耗材批次和设备'); return }
    if (Number(metadata.layerHeightMm) !== lut.layerHeight || Number(metadata.layerCount) !== lut.layerCount) { setError('光学层高和层数须与校准板一致'); return }
    void run('package', { taskId, mode, materials, metadata: { ...metadata, status: 'extracted' } }, result => { setPack(result) })
  }
  const importPackage = async (file: Blob) => {
    setBusy(true); setError('')
    try {
      const api = await packageApi()
      const profile = await api.importSnapColorPackage(file)
      window.dispatchEvent(new Event('snapboard:snapcolor-profiles-updated'))
      setProfiles(await api.listSnapColorProfiles())
      setNotice(`已导入 ${profile.name}；请在当前工程中明确选用。`)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  const profileDrop = useFileDrop(async files => {
    if (files.length !== 1 || !files[0].name.toLowerCase().endsWith('.snapcolor')) { setError('请拖入一个 .snapcolor 校色档案'); return }
    await importPackage(files[0])
  }, busy, { accept: '.snapcolor', onError: setError })
  const rotate = async () => {
    if (!photo) return
    const image = new Image(); image.src = photo.dataUrl; await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalHeight; canvas.height = image.naturalWidth
    const context = canvas.getContext('2d')
    if (!context) { setError('无法旋转照片'); return }
    context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(image, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', .95)
    if (dataUrl.length > 16 * 1024 * 1024) { setError('旋转后的照片超过 16 MB，请压缩后重新上传'); return }
    setPhoto({ dataUrl, width: canvas.width, height: canvas.height })
    dispatchCorners({ type: 'reset' })
  }
  const currentResult = results[page]
  const pageCount = modeInfo.pages
  const pageReady = (number: number) => results[number]?.invalidCells !== undefined && Number.isInteger(results[number]?.cellCount) && !invalidCount(results[number])
  const readyForPackage = pageCount === 1 ? pageReady(1) : Boolean(merged && [1, 2].every(pageReady))
  const renderFiles = (files?: ApiResult['files']) => files?.length ? <ul className="farm-files">{files.map(file => <li key={file.name}><a href={file.url} download>{file.name}</a></li>)}</ul> : null

  return createPortal(<dialog ref={dialog} className="farm-dialog" aria-labelledby="farm-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
    onClick={event => event.stopPropagation()}
    onKeyDownCapture={event => {
      if (tab !== 'photo' || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, [contenteditable=true]')) return
      event.preventDefault()
      event.stopPropagation()
      if (cornerHistory.length) dispatchCorners({ type: 'undo' })
    }}>
    <header className="farm-head"><div><small>SNAPCOLOR</small><h2 id="farm-title">校色管理</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭校色管理">×</button></header>
    <nav className="farm-tabs" aria-label="校色步骤">
      <button type="button" aria-current={tab === 'board' ? 'step' : undefined} onClick={() => setTab('board')}>1 校准板</button>
      <button type="button" aria-current={tab === 'photo' ? 'step' : undefined} onClick={() => setTab('photo')}>2 照片取色</button>
      <button type="button" aria-current={tab === 'profile' ? 'step' : undefined} onClick={() => setTab('profile')}>3 档案</button>
    </nav>
    <div className="farm-body">
      <aside className="farm-source-credit" aria-label="校色流程来源">
        <b>校色流程来源</b>
        <span>校准板、照片取色与档案合并基于 <a href="https://github.com/lumina-layer-studio/Lumina-Layers" target="_blank" rel="noopener noreferrer">Lumina Studio v1.6.9</a>（GPLv3）。SnapColor 改造了任务界面、校色包封装与工程接入。</span>
      </aside>
      {!available && <p className="farm-unavailable" role="status">{reason}</p>}
      {tab === 'board' && <div className="farm-grid">
        <section><h3>新建校色任务</h3>
          <label>颜色模式<select value={mode} onChange={event => changeMode(event.target.value)}>{MODES.map(item => <option key={item.value} value={item.value} disabled={!supportedModes.includes(item.value)}>{item.value}{supportedModes.includes(item.value) ? '' : '（暂不可用）'}</option>)}</select></label>
          <p className="farm-hint">耗材槽位顺序必须与实际打印顺序一致。</p>
          <div className="farm-materials">{materials.map((item, index) => <div className="farm-material" key={index}><label>槽位 {index + 1}<input value={item.name} disabled={Boolean(board)} maxLength={80} onChange={event => setMaterials(current => current.map((material, i) => i === index ? { ...material, name: event.target.value } : material))} /></label><label aria-label={`槽位 ${index + 1} 的标识颜色`}>颜色<input type="color" value={item.color} disabled={Boolean(board)} onChange={event => setMaterials(current => current.map((material, i) => i === index ? { ...material, color: event.target.value } : material))} /></label></div>)}</div>
          <div className="farm-row"><label>色块边长 mm<input type="number" min="2" max="15" step="0.1" value={blockSize} disabled={Boolean(board)} onChange={event => setBlockSize(event.target.value)} /></label><label>间距 mm<input type="number" min="0" max="5" step="0.1" value={gap} disabled={Boolean(board)} onChange={event => setGap(event.target.value)} /></label></div>
          <label>背衬<select value={metadata.backing} disabled={Boolean(board) || !['RYBW', 'CMYW', 'BW (Black & White)'].includes(mode)} onChange={event => updateMetadata('backing', event.target.value)}><option value="White">白色</option><option value="Black">黑色</option></select></label>
          <button type="button" className={board ? undefined : 'farm-primary'} disabled={!available || busy || Boolean(board) || !supportedModes.includes(mode)} onClick={() => void generate()}>生成校准板</button>
          {board && <button type="button" disabled={busy} onClick={resetTask}>新建另一校色任务</button>}
        </section>
        <section><h3>板面与打印条件</h3>
          {board?.previewUrl ? <img className="farm-board-preview" src={board.previewUrl} alt="校准板预览" /> : <div className="farm-placeholder">生成后显示校准板预览</div>}
          {board?.dimensionsMm && <p>实际尺寸：{board.dimensionsMm[0]} × {board.dimensionsMm[1]} mm</p>}
          <p>共 {pageCount} 页 · {lut.layerCount} 层 × {lut.layerHeight} mm · {materials.length} 个耗材槽位</p>
          <p className="farm-hint">按文件内打印设置制作，并核对面向、层高、背衬和材料槽位；如改动工艺，请重新校色。</p>
          {renderFiles(board?.files)}
          {board && <button type="button" className="farm-primary" onClick={() => setTab('photo')}>继续上传照片</button>}
        </section>
      </div>}
      {tab === 'photo' && <div className="farm-grid">
        <section><h3>拍摄与四角定位</h3><p className="farm-hint">固定照明、曝光和白平衡，避免反光。按左上、右上、右下、左下依次点击四角。</p>
          <div className="farm-row"><label>校准板页<select value={page} onChange={event => { setPage(Number(event.target.value)); setPhoto(null); dispatchCorners({ type: 'reset' }) }}>{Array.from({ length: pageCount }, (_, i) => <option key={i} value={i + 1}>第 {i + 1} 页</option>)}</select></label><label className="file-drop-field" {...photoDrop.dropProps}>校准照片<span className="file-drop-prompt"><span className="file-drop-plus" aria-hidden="true">＋</span>点击或拖入照片</span><input type="file" disabled={busy} accept="image/jpeg,image/png,image/webp" onChange={event => { choosePhoto(event.target.files?.[0]); event.target.value = '' }} /></label></div>
          {photo && <><button type="button" onClick={() => void rotate()}>顺时针旋转 90°</button>
            <div className="farm-photo"><div className="farm-photo-image">
              <img src={photo.dataUrl} alt="待取色照片，点击标记当前角点" onClick={event => {
                if (activeCorner === null) { setNotice('四角已标完；请先选择要修改的角点编号'); return }
                const point = calibrationPointFromClick(event.clientX, event.clientY,
                  event.currentTarget.getBoundingClientRect(), photo.width, photo.height)
                dispatchCorners({ type: 'mark', index: activeCorner, point, advance: true })
                setNotice('')
              }} />
              <svg viewBox={`0 0 ${photo.width} ${photo.height}`} preserveAspectRatio="none" aria-hidden="true">
                <polyline points={[...corners.filter((point): point is Point => point !== null),
                  ...(corners.every(Boolean) ? [corners[0] as Point] : [])].map(point => point.join(',')).join(' ')} />
              </svg>
              {corners.map((point, index) => point && <span key={index} data-active={activeCorner === index}
                style={{ left: `${point[0] / photo.width * 100}%`, top: `${point[1] / photo.height * 100}%` }}>{index + 1}</span>)}
            </div></div>
            <div className="farm-corner-actions"><span role="status">{activeCorner === null
              ? '四角已标完；选编号可重定位' : `下一点：${activeCorner + 1} ${['左上', '右上', '右下', '左下'][activeCorner]}`}</span>
              <button type="button" disabled={!cornerHistory.length} onClick={() => dispatchCorners({ type: 'undo' })}>撤销上一点</button>
              <button type="button" disabled={corners.every(point => !point)} onClick={() => dispatchCorners({ type: 'clear' })}>清除四角</button>
            </div></>}
          <div className="farm-corners">{['左上', '右上', '右下', '左下'].map((label, index) => <fieldset key={label}>
            <legend><button type="button" disabled={!photo} aria-pressed={activeCorner === index} onClick={() => dispatchCorners({ type: 'select', index })}>{index + 1} {label}</button></legend>
            <label>X<CornerNumberInput label={`${label} X`} disabled={!photo} value={corners[index]?.[0] ?? null} max={photo ? photo.width - 1 : 0}
              onCommit={value => dispatchCorners({ type: 'mark', index, point: [value, corners[index]?.[1] ?? 0] })} /></label>
            <label>Y<CornerNumberInput label={`${label} Y`} disabled={!photo} value={corners[index]?.[1] ?? null} max={photo ? photo.height - 1 : 0}
              onCommit={value => dispatchCorners({ type: 'mark', index, point: [corners[index]?.[0] ?? 0, value] })} /></label>
          </fieldset>)}</div>
        </section>
        <section><h3>取样核对</h3>
          <div className="farm-row"><label>水平偏移 px<input type="number" value={offsetX} onChange={event => setOffsetX(event.target.value)} /></label><label>垂直偏移 px<input type="number" value={offsetY} onChange={event => setOffsetY(event.target.value)} /></label><label>缩放<input type="number" step="0.01" min="0.1" value={zoom} onChange={event => setZoom(event.target.value)} /></label><label>畸变<input type="number" step="0.01" value={barrel} onChange={event => setBarrel(event.target.value)} /></label></div>
          <div className="farm-checks"><label><input type="checkbox" checked={wb} onChange={event => setWb(event.target.checked)} /> 白平衡补偿</label><label><input type="checkbox" checked={bright} onChange={event => setBright(event.target.checked)} /> 亮度补偿</label></div>
          <button type="button" className={readyForPackage || (pageCount > 1 && [1, 2].every(pageReady)) ? undefined : 'farm-primary'} disabled={!available || !taskId || busy || !photo || corners.some(point => !point)} onClick={extract}>提取第 {page} 页</button>
          {currentResult && <><p>第 {page} 页：{currentResult.cellCount ?? '—'} 格，异常 {invalidCount(currentResult)} 格。{invalidCount(currentResult) ? '请重新取样或修正，异常格不能作为有效黑色。' : '请对照照片核查颜色。'}</p>{currentResult.files?.find(file => /warp|透视|校正/i.test(file.name)) && <img className="farm-result-preview" src={currentResult.files.find(file => /warp|透视|校正/i.test(file.name))!.url} alt={`第 ${page} 页透视校正预览`} />}{currentResult.previewUrl && <img className="farm-result-preview" src={currentResult.previewUrl} alt={`第 ${page} 页取样结果预览`} />}{renderFiles(currentResult.files)}{Array.isArray(currentResult.invalidCells) && currentResult.invalidCells.length > 0 && <p>异常色格：{currentResult.invalidCells.slice(0, 20).map(index => <button type="button" key={index} onClick={() => setFixIndex(String(index))}>{index}</button>)}</p>}</>}
          {currentResult && <details><summary>修正单格颜色</summary><div className="farm-row"><label>色格序号<input type="number" min="0" step="1" value={fixIndex} onChange={event => setFixIndex(event.target.value)} /></label><label>实测颜色<input type="color" value={fixColor} onChange={event => setFixColor(event.target.value)} /></label></div><label>修正原因<input value={fixReason} onChange={event => setFixReason(event.target.value)} placeholder="例如：反光导致该格取样偏白" /></label><button type="button" disabled={busy} onClick={fix}>保存修正</button></details>}
          {pageCount > 1 && <><p>页状态：{[1, 2].map(number => `第 ${number} 页${results[number] ? pageReady(number) ? '已提取' : '有待核对的异常' : '待提取'}`).join(' · ')}</p><button type="button" className={!merged && [1, 2].every(pageReady) ? 'farm-primary' : undefined} disabled={busy || ![1, 2].every(pageReady) || Boolean(merged)} onClick={merge}>核对并合并两页</button>{merged && <p>已合并：{merged.cellCount ?? '—'} 格</p>}</>}
          {readyForPackage && <button type="button" className="farm-primary" onClick={() => setTab('profile')}>继续封装档案</button>}
        </section>
      </div>}
      {tab === 'profile' && <div className="farm-profile-tab">
        <section className="farm-builtin"><h3>内置校色档案 · PETG 实测</h3>
          <p className="farm-hint">先按你的耗材品牌选内置档案：多品牌 PETG 实测配色开箱即用。批次、喷嘴或工艺与档案不一致时，再用下方流程校自己的档案（从「1 校准板」开始）。</p>
          <ul className="farm-builtin-list">{SNAPCOLOR_LUTS.map(item => {
            const active = item.id === currentLutId
            return <li key={item.id} aria-current={active || undefined}>
              <div className="farm-builtin-head"><b data-i18n-ignore="true">{item.name}</b>{active && <span className="farm-builtin-active">使用中</span>}</div>
              <p className="farm-hint">{item.description}</p>
              <div className="farm-builtin-materials">{item.materials.map((material, index) => <span key={index}><i style={{ background: material.color }} />{material.name}</span>)}</div>
              <div className="farm-builtin-foot"><small>{item.layerCount} 层 × {item.layerHeight.toFixed(2)} mm</small>
                <button type="button" className={active ? undefined : 'farm-primary'} disabled={active} onClick={() => { setBoardTexture({ lutId: item.id }); setNotice(`已选用 ${item.name}；纹理工作室的「材料与配色」中可查看。`) }}>{active ? '当前档案' : '选用到当前工程'}</button></div>
            </li>
          })}</ul>
        </section>
        <div className="farm-grid">
        <section><h3>保存农场校色包</h3>
          <div className="farm-row"><label>档案名称<input value={metadata.name} onChange={event => updateMetadata('name', event.target.value)} /></label><label>修订号<input value={metadata.revision} onChange={event => updateMetadata('revision', event.target.value)} /></label><label>耗材批次<input value={metadata.batch} onChange={event => updateMetadata('batch', event.target.value)} /></label><label>设备<input value={metadata.machine} onChange={event => updateMetadata('machine', event.target.value)} /></label><label>喷嘴 mm<input type="number" min="0.1" step="0.1" value={metadata.nozzleMm} onChange={event => updateMetadata('nozzleMm', event.target.value)} /></label><label>层高 mm<input type="number" min="0.02" step="0.01" value={metadata.layerHeightMm} disabled onChange={event => updateMetadata('layerHeightMm', event.target.value)} /></label><label>光学层数<input type="number" min="1" step="1" value={metadata.layerCount} disabled onChange={event => updateMetadata('layerCount', event.target.value)} /></label><label>打印面<select value={metadata.printFace} disabled><option value="face-down">正面贴床</option></select></label><label>线宽 mm<input type="number" step="0.01" value={metadata.lineWidthMm} onChange={event => updateMetadata('lineWidthMm', event.target.value)} /></label><label>速度 mm/s<input type="number" value={metadata.speedMmS} onChange={event => updateMetadata('speedMmS', event.target.value)} /></label><label>温度 ℃<input type="number" value={metadata.temperatureC} onChange={event => updateMetadata('temperatureC', event.target.value)} /></label></div>
          <label>工艺备注<textarea value={metadata.notes} onChange={event => updateMetadata('notes', event.target.value)} /></label>
          <p className="farm-hint">本次封装状态为“已提取”。独立检查卡通过后，才可在后续复验流程发布“已验证”版本。</p>
          <button type="button" className={pack ? undefined : 'farm-primary'} disabled={!available || busy || !readyForPackage || Boolean(pack)} onClick={makePackage}>生成 .snapcolor</button>
          {pack?.packageUrl && <><a className="farm-download-primary" href={pack.packageUrl} download>下载 .snapcolor 校色包</a><button type="button" disabled={busy} onClick={() => void fetch(pack.packageUrl!).then(response => { if (!response.ok) throw new Error('无法读取校色包'); return response.blob() }).then(importPackage).catch(cause => setError(errorMessage(cause)))}>导入此档案</button></>}
        </section>
        <section><h3>我的校色档案（自定义）</h3><p className="farm-hint">内置档案不匹配你的耗材或工艺时，从「1 校准板」新建校色任务；也可以直接导入已有的 .snapcolor 档案。</p><label className="file-drop-field" {...profileDrop.dropProps}><span className="file-drop-prompt"><span className="file-drop-plus" aria-hidden="true">＋</span>点击或拖入 .snapcolor 档案</span><input type="file" accept=".snapcolor" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void importPackage(file); event.target.value = '' }} /></label>
          {profiles.length ? <ul className="farm-profiles">{profiles.map(profile => <li key={profile.id}><span><b data-i18n-ignore="true">{profile.name}</b><small>{profile.revision} · {profile.status === 'verified' ? '已验证' : '已提取'} · {profile.hash.slice(0, 10)}</small></span></li>)}</ul> : <p>尚无自定义档案。</p>}
        </section>
        </div>
      </div>}
    </div>
    <footer className="farm-foot"><span role="status">{busy ? '正在处理…' : error || notice || (taskId ? `任务 ${taskId}` : '')}</span>{busy && taskId && <button type="button" onClick={() => void farmRequest('cancel', { taskId }).then(result => setNotice(result.message || '已取消')).catch(cause => setError(errorMessage(cause)))}>取消任务</button>}{error && <button type="button" onClick={() => setError('')}>清除错误</button>}<button type="button" onClick={onClose} disabled={busy}>关闭</button></footer>
  </dialog>, document.body)
}
