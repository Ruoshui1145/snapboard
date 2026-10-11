import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/I18nProvider'
import { parseCadDxf, cadContours, dxfUnitScale, type CadDrawing, type CadRole } from '../../features/cad/dxf'
import { ImportCadCommand } from '../../features/cad/ImportCadCommand'
import { useAppStore } from '../../store/useAppStore'
import { openRailPopover } from '../shapeLibrary/openRailPopover'
import { useFileDrop } from '../../hooks/useFileDrop'
import './CadImportDialog.css'

export function CadImportDialog({ onClose, embedded = false, active = true, onPreview, onApplied }: {
  onClose(): void; embedded?: boolean; active?: boolean; onPreview?(node: ReactNode): void; onApplied?(contourId?: string): void
}) {
  const request = useRef(0), autoOpenedRequest = useRef(0), fileInput = useRef<HTMLInputElement>(null), entityPopover = useRef<HTMLDivElement>(null), entityTrigger = useRef<HTMLButtonElement>(null)
  const rememberedRoles = useRef(new Map<string, CadRole>())
  const { locale } = useI18n(), en = locale === 'en-US'
  const label = (zh: string, english: string) => en ? english : zh
  const [drawing, setDrawing] = useState<CadDrawing | null>(null)
  const [fileName, setFileName] = useState(''), [scale, setScale] = useState('')
  const [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false), [appliedIds, setAppliedIds] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [entityOpen, setEntityOpen] = useState(false)
  const project = useAppStore(s => s.project)
  const projectContourIds = useMemo(() => new Set(project.parts.flatMap(part => part.features).flatMap(feature => feature.type === 'sketch' ? feature.contours.map(contour => contour.id) : [])), [project])
  const applied = appliedIds.length > 0 && appliedIds.every(id => projectContourIds.has(id))
  const points = drawing?.paths.flatMap(p => p.preview) ?? []
  const minX = points.reduce((v, p) => Math.min(v, p.x), Infinity), minY = points.reduce((v, p) => Math.min(v, p.y), Infinity)
  const maxX = points.reduce((v, p) => Math.max(v, p.x), -Infinity), maxY = points.reduce((v, p) => Math.max(v, p.y), -Infinity)
  const width = maxX - minX, height = maxY - minY, pad = Math.max(width, height, 1) * .04
  const roles: [CadRole, string][] = [['outer', label('外轮廓', 'Outer')], ['inner', label('内孔', 'Cutout')], ['construction', label('辅助线', 'Auxiliary')], ['skip', label('不导入', 'Exclude')]]
  const update = (ids: string[], role: CadRole) => {
    setAppliedIds([])
    setDrawing(d => d ? { ...d, paths: d.paths.map(p => {
      if (!ids.includes(p.contour.id)) return p
      const next = !p.valid && (role === 'outer' || role === 'inner') ? 'construction' : role
      if (next !== 'skip') rememberedRoles.current.set(p.contour.id, next)
      return { ...p, role: next }
    }) } : d)
  }
  const clearCandidate = () => {
    ++request.current
    if (entityPopover.current?.matches(':popover-open')) entityPopover.current.hidePopover()
    if (fileInput.current) fileInput.current.value = ''
    rememberedRoles.current.clear()
    setDrawing(null); setFileName(''); setScale(''); setError('')
    setConfirmed(false); setSelected([]); setLoading(false); setAppliedIds([])
  }
  useEffect(() => () => { ++request.current }, [])
  useEffect(() => { if (!active && entityPopover.current?.matches(':popover-open')) entityPopover.current.hidePopover() }, [active])
  useEffect(() => {
    if (!active || !embedded || !drawing || !entityTrigger.current || autoOpenedRequest.current === request.current) return
    autoOpenedRequest.current = request.current
    openRailPopover(entityTrigger.current, entityPopover.current)
  }, [active, drawing, embedded])
  const cadPreview = useMemo(() => drawing && points.length && Number.isFinite(width) && Number.isFinite(height) ? <div className="cad-preview-content">
    <svg viewBox={`${minX - pad} ${minY - pad} ${width + pad * 2} ${height + pad * 2}`} aria-label={en ? 'CAD contour preview' : 'CAD 轮廓预览'}>
      {drawing.paths.map(p => <polyline key={p.contour.id} points={[...p.preview, ...(p.contour.closed ? p.preview.slice(0, 1) : [])].map(v => `${v.x},${v.y}`).join(' ')} fill="none" stroke={!p.valid ? '#ff7676' : p.role === 'inner' ? '#ffcf70' : p.role === 'construction' ? '#9da6b8' : '#63dccc'} strokeDasharray={p.role === 'construction' ? '5 4' : undefined} opacity={p.role === 'skip' ? .2 : 1} strokeWidth={selected.includes(p.contour.id) ? 3 : 2} vectorEffect="non-scaling-stroke" onClick={() => setSelected([p.contour.id])} />)}
    </svg>
    <small className="cad-preview-meta">{scale ? `${(width * Number(scale)).toFixed(1)} × ${(height * Number(scale)).toFixed(1)} mm` : label('请确认文件单位', 'Confirm file units')} · {drawing.paths.filter(p => p.role === 'outer').length} {label('外轮廓', 'outer')} / {drawing.paths.filter(p => p.role === 'inner').length} {label('内孔', 'cutouts')}</small>
  </div> : null, [drawing, points.length, minX, minY, width, height, pad, selected, en, scale])
  useEffect(() => { if (embedded) onPreview?.(applied ? null : cadPreview) }, [cadPreview, applied, embedded, onPreview])
  useEffect(() => () => { if (embedded) onPreview?.(null) }, [embedded, onPreview])

  const chooseFile = async (file?: File) => {
    if (!file) return
    const token = ++request.current
    if (entityPopover.current?.matches(':popover-open')) entityPopover.current.hidePopover()
    setDrawing(null); setError(''); setConfirmed(false); setSelected([])
    setScale(''); setFileName(file.name); setLoading(true); setAppliedIds([])
    try {
      if (file.size > 12_000_000) throw new Error(label('DXF 文件不能超过 12 MB', 'DXF file exceeds 12 MB'))
      const source = await file.text()
      if (token !== request.current) return
      const parsed = parseCadDxf(source)
      if (token !== request.current) return
      rememberedRoles.current = new Map(parsed.paths.map(p => [p.contour.id, p.role]))
      setDrawing(parsed); setScale(String(dxfUnitScale(parsed.unit) ?? ''))
    } catch (cause) { if (token === request.current) setError(String(cause)) }
    finally { if (token === request.current) setLoading(false) }
  }

  const fileDrop = useFileDrop(async files => {
    if (files.length !== 1 || !files[0].name.toLowerCase().endsWith('.dxf')) { setError(label('请拖入一个 DXF 文件', 'Drop one DXF file')); return }
    await chooseFile(files[0])
  }, loading, { accept: '.dxf', maxBytes: 12_000_000, onError: setError })
  const content = <div className={embedded ? 'cad-embedded' : 'cad-backdrop'} onKeyDown={e => {
    e.stopPropagation()
    if (!embedded && e.key === 'Escape') onClose()
  }}><section className="cad-dialog" role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label={label('导入 DXF', 'Import DXF')} data-i18n-ignore="true">
    {!embedded && <header><h2>{label('导入 CAD 草图', 'Import CAD Sketch')}</h2><button type="button" onClick={onClose} aria-label={label('关闭', 'Close')}>×</button></header>}
    <p className="cad-help">{label('解析平面 ASCII DXF 的线、圆弧与闭合路径；确认单位和轮廓用途后按原尺寸添加。', 'Parse lines, arcs and closed paths in planar ASCII DXF. Confirm units and roles before adding at original size.')}</p>
    <div className="cad-file-card" {...fileDrop.dropProps}>
      <div className="cad-file-info"><strong title={fileName}>{fileName || label('选择 DXF 文件', 'Choose a DXF file')}</strong><small>{label('可拖入 DXF · 最大 12 MB', 'Drop DXF · max 12 MB')}</small></div>
      <div className="cad-file-actions">
        <input ref={fileInput} type="file" accept=".dxf" aria-label="DXF" onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = '' }} />
        <button type="button" className="file-drop-prompt" onClick={() => fileInput.current?.click()}><span className="file-drop-plus" aria-hidden="true">＋</span>{fileName ? label('更换 / 拖入 DXF', 'Replace / drop DXF') : label('点击或拖入 DXF', 'Choose or drop DXF')}</button>
        {fileName && <button type="button" onClick={clearCandidate}>{label('清除候选', 'Clear candidate')}</button>}
      </div>
    </div>
    <div className="cad-status" aria-live="polite">
      {loading ? label('正在读取和解析 DXF…', 'Reading and parsing DXF…')
        : error ? <span role="alert">{label('读取失败：', 'Could not read file: ')}{error}。{label('请选择其他 DXF 文件或检查文件内容。', 'Choose another DXF or check its contents.')}</span>
          : applied ? label('已添加到当前草图。可继续编辑，或选择其他文件。', 'Added to the current sketch. Continue editing or choose another file.')
            : drawing ? label(`已识别 ${drawing.paths.length} 条路径，请确认单位及轮廓用途。`, `${drawing.paths.length} paths found. Confirm units and contour roles.`)
              : label('选择文件后可预览轮廓，并确认单位和用途。', 'Choose a file to preview contours, then confirm units and roles.')}
    </div>
    {drawing && <>
      <div className="cad-units"><label>{label('文件单位', 'File units')} <select aria-label="CAD units" value={scale} onChange={e => { setScale(e.target.value); setAppliedIds([]) }}>
        <option value="">{label('单位不明，请选择', 'Unknown — choose units')}</option>
        {[[1, 'mm'], [10, 'cm'], [1000, 'm'], [25.4, 'inch'], [304.8, 'ft'], [.001, 'µm'], [.0254, 'mil'], [914.4, 'yd'], [100, 'dm'], [10000, 'dam']].map(([v, name]) => <option key={v} value={v}>{name}</option>)}
      </select></label><p>{scale ? `${(width * Number(scale)).toFixed(3)} × ${(height * Number(scale)).toFixed(3)} mm` : label('确认单位后显示实际尺寸', 'Choose units to show actual dimensions')}</p></div>
      {embedded&&<button ref={entityTrigger} type="button" className="board-flyout-trigger cad-entity-trigger" aria-haspopup="dialog" aria-expanded={entityOpen} onClick={e=>openRailPopover(e.currentTarget,entityPopover.current)}>{label(`分类 DXF 路径（${drawing.paths.length}）· ${entityOpen?'收起':'展开'}`, `Classify DXF paths (${drawing.paths.length}) · ${entityOpen?'Close':'Open'}`)}</button>}
      <div className="cad-content">{!embedded && cadPreview}<div ref={entityPopover} popover={embedded?'auto':undefined} onToggle={e=>setEntityOpen(e.currentTarget.matches(':popover-open'))} className={'cad-list'+(embedded?' board-option-popover':'')} role={embedded?'dialog':undefined} aria-label={embedded?label('DXF 路径分类','DXF path classification'):undefined}>
        {embedded&&<strong>{label('DXF 路径分类','DXF path classification')}</strong>}
        <div className="cad-role-actions">{selected.length ? roles.map(([role, text]) => <button type="button" key={role} disabled={(role==='outer'||role==='inner')&&drawing.paths.some(p=>selected.includes(p.contour.id)&&!p.valid)} onClick={() => update(selected, role)}>{text}</button>) : <small>{label('直接修改每行用途；勾选路径后可批量修改。','Change each path role directly, or select paths for bulk changes.')}</small>}</div>
        {[...new Set(drawing.paths.map(p => p.layer))].map(layer => <label className="cad-layer" key={layer}><input type="checkbox" checked={drawing.paths.filter(p => p.layer === layer).every(p => p.role !== 'skip')} onChange={e => {
          const enabled = e.target.checked
          setAppliedIds([])
          setDrawing(d => d ? { ...d, paths: d.paths.map(p => p.layer === layer ? { ...p, role: enabled ? rememberedRoles.current.get(p.contour.id) ?? 'construction' : 'skip' } : p) } : d)
        }} />{label('图层', 'Layer')}: {layer}</label>)}
        {drawing.paths.map(p => <article key={p.contour.id}>
          <label><input type="checkbox" checked={selected.includes(p.contour.id)} onChange={e => setSelected(s => e.target.checked ? [...s, p.contour.id] : s.filter(id => id !== p.contour.id))} />{p.contour.name}</label>
          <span className="cad-role-control">{label('用途','Role')}<select aria-label={p.contour.name} value={p.role} onChange={e => update([p.contour.id], e.target.value as CadRole)}>{roles.map(([r, text]) => <option key={r} value={r} disabled={!p.valid && (r === 'outer' || r === 'inner')}>{text}</option>)}</select></span>
          {p.issue && <small>{!p.contour.closed ? label('未闭合：需在 CAD 中连接端点并闭合（JOIN/PEDIT），再导入作外轮廓或内孔；当前可选辅助线或不导入。','Open path: join and close endpoints in CAD (JOIN/PEDIT), then reimport for outer or cutout use. Here choose Auxiliary or Exclude.') : label('轮廓相交或自交；请在 CAD 中修复后重新导入。','Intersecting or self-intersecting outline. Repair it in CAD and reimport.')}</small>}
        </article>)}
      </div></div>
      {drawing.warnings.length > 0 && <div className="cad-warnings">{drawing.warnings.map(w => <p key={w}>{w==='Duplicate line entities excluded' ? label('已忽略重复线段，闭合轮廓保留。','Duplicate line entities ignored; closed outlines preserved.') : w.startsWith('POINT:') ? label('已忽略 POINT 点标记；它不属于制造轮廓。','POINT annotations excluded from manufacturing outlines.') : w}</p>)}<label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{label('我确认不导入上述内容', 'I acknowledge the excluded content')}</label></div>}
    </>}
    {(embedded||drawing)&&<footer className="cad-completion">
      {embedded&&<p>{drawing?label(`将按原尺寸添加 ${drawing.paths.filter(p=>p.role!=='skip').length} 条路径，几何锁定；原轮廓保留。`, `Add ${drawing.paths.filter(p=>p.role!=='skip').length} paths at original size, with locked geometry. Existing outlines remain.`):label('请先选择 DXF 文件。', 'Choose a DXF file first.')}</p>}
      {!embedded && <button type="button" onClick={onClose}>{label('取消', 'Cancel')}</button>}<button type="button" disabled={!drawing || applied || !scale || !drawing.paths.some(p => p.role !== 'skip') || (drawing.warnings.length > 0 && !confirmed)} onClick={() => {
        if (!drawing) return
        try {
          const s = useAppStore.getState(), contours = cadContours(drawing, Number(scale), s.project.config.pixelToMM, fileName)
          s.execute(new ImportCadCommand(contours))
          useAppStore.getState().setUI({ activeTool: 'select', viewMode: '2d', selectedContourId: contours[0]?.id ?? null, selectedConstraintId: null })
          window.dispatchEvent(new CustomEvent('snapboard:fit-active-sketch'))
          setAppliedIds(contours.map(contour => contour.id))
          if (entityPopover.current?.matches(':popover-open')) entityPopover.current.hidePopover()
          if (embedded) onApplied?.(contours[0]?.id)
          else onClose()
        } catch (cause) { setError(String(cause)) }
      }}>{label('添加到草图（原尺寸）', 'Add to sketch (original size)')}</button></footer>}
  </section></div>
  return embedded ? content : createPortal(content, document.body)
}
