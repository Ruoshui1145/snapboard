import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useFileDrop } from '../../hooks/useFileDrop'
import type {
  ParseShapeLibraryUpload,
  GenerateShapeLibraryPreview,
  ShapeLibraryApplicationMode,
  ShapeLibraryApplyRequest,
  ShapeLibraryImportOptions,
  ShapeLibraryGeometry,
  ShapeLibraryParameters,
  ShapeLibraryPreset,
  ShapeLibraryPreviewResult,
  ShapeLibraryTab,
} from './types'
import './ShapeLibraryDialog.css'

const DEFAULT_PARAMETERS: ShapeLibraryParameters = {
  width: 320,
  height: 220,
  lockAspectRatio: true,
  flipX: false,
  flipY: false,
  rotation: 0,
  smoothing: 45,
  detail: 60,
}

const DEFAULT_IMPORT_OPTIONS: ShapeLibraryImportOptions = {
  // Logo/signage friendly: include coloured marks on white while keeping pure white excluded.
  threshold: 220,
  invert: false,
  outlineInterpretation: 'auto',
  smoothing: 10,
  simplify: 5,
}

const BUILTIN_THUMBNAILS: Record<string, string> = {
  cloud: 'M18 69C9 68 5 61 7 52C9 43 17 39 25 40C27 28 37 19 50 20C61 20 69 26 73 35C84 33 94 41 94 52C94 63 86 70 75 70H19Z',
  arch: 'M18 79V48C18 27 32 14 50 14C68 14 82 27 82 48V79H65V48C65 38 59 31 50 31C41 31 35 38 35 48V79Z',
  heart: 'M50 82C43 75 18 59 14 42C10 25 22 16 35 18C43 19 48 24 50 29C53 24 58 19 66 18C79 16 91 25 87 42C83 59 57 75 50 82Z',
  star: 'M50 10L61 36L90 38L68 57L75 86L50 70L25 86L32 57L10 38L39 36Z',
  crescent: 'M68 13C46 16 31 34 33 54C35 73 51 86 70 85C60 91 48 93 36 88C15 80 5 56 13 35C22 13 47 3 68 13Z',
  wave: 'M8 34C23 18 37 18 51 34C64 48 76 48 92 33V68C76 83 62 83 49 68C35 53 23 53 8 69Z',
  house: 'M11 47L50 14L89 47V87H62V62H38V87H11Z',
  capsule: 'M27 20H73C86 20 94 31 94 50C94 69 86 80 73 80H27C14 80 6 69 6 50C6 31 14 20 27 20Z',
}

const TAB_ITEMS: Array<{ id: ShapeLibraryTab; label: string; hint: string }> = [
  { id: 'presets', label: '预制图形', hint: '精选板型' },
  { id: 'upload', label: '自定义上传', hint: 'SVG 或图片' },
  { id: 'recent', label: '最近使用', hint: '快速复用' },
]

export interface ShapeLibraryDialogProps<TGeometry = ShapeLibraryGeometry> {
  open: boolean
  initialTab?: ShapeLibraryTab
  presets: ShapeLibraryPreset[]
  generatePreview: GenerateShapeLibraryPreview<TGeometry>
  parseUploadFile: ParseShapeLibraryUpload<TGeometry>
  onApply: (
    result: ShapeLibraryPreviewResult<TGeometry>,
    request: ShapeLibraryApplyRequest,
  ) => void | Promise<void>
  onClose: () => void
  recentPresetIds?: string[]
  maxUploadBytes?: number
}

function presetParameters(preset?: ShapeLibraryPreset): ShapeLibraryParameters {
  if (!preset) return DEFAULT_PARAMETERS
  return {
    ...DEFAULT_PARAMETERS,
    width: preset.defaultWidth,
    height: preset.defaultHeight,
  }
}

function formatArea(area?: number) {
  if (area === undefined || !Number.isFinite(area)) return '—'
  if (area >= 1_000_000) return `${(area / 1_000_000).toFixed(2)} m²`
  return `${Math.round(area).toLocaleString('zh-CN')} mm²`
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isSupportedUpload(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase()
  return file.type === 'image/svg+xml'
    || file.type === 'image/png'
    || file.type === 'image/jpeg'
    || extension === 'svg'
    || extension === 'png'
    || extension === 'jpg'
    || extension === 'jpeg'
}

function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function PreviewArtwork<TGeometry>({
  result,
  fallbackPath,
  parameters,
}: {
  result: ShapeLibraryPreviewResult<TGeometry> | null
  fallbackPath?: string
  parameters: ShapeLibraryParameters
}) {
  const transform = `rotate(${parameters.rotation}deg) ${parameters.flipX ? 'scaleX(-1)' : ''} ${parameters.flipY ? 'scaleY(-1)' : ''}`.trim()
  if (result?.previewImageUrl) {
    return (
      <img
        className="shape-library-preview-image"
        src={result.previewImageUrl}
        alt="当前板型轮廓预览"
        style={{ transform: transform || undefined }}
      />
    )
  }
  const paths = result?.paths?.length
    ? result.paths
    : fallbackPath
      ? [{ d: fallbackPath }]
      : []
  if (!paths.length) {
    return <div className="shape-library-preview-placeholder"><span>⌁</span><p>选择图形后在这里检查轮廓</p></div>
  }
  return (
    <svg
      className="shape-library-preview-svg"
      viewBox={result?.viewBox ?? '0 0 100 100'}
      aria-label="当前板型轮廓预览"
      style={{ transform: transform || undefined }}
    >
      <defs>
        <linearGradient id="shapeLibraryFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#43e1d1" stopOpacity=".3" />
          <stop offset="1" stopColor="#549dff" stopOpacity=".12" />
        </linearGradient>
      </defs>
      {paths.map((path, index) => (
        <path
          key={`${index}-${path.d.slice(0, 18)}`}
          d={path.d}
          fill="url(#shapeLibraryFill)"
          fillRule={path.fillRule}
          stroke="#69e7db"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

function RangeControl({
  label,
  value,
  min,
  max,
  suffix = '%',
  editable = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  editable?: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className="shape-library-range">
      <span><b>{label}</b>{editable
        ? <span className="shape-library-range-number"><input aria-label={`${label}数值`} type="number" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} /><i>{suffix}</i></span>
        : <output>{value}{suffix}</output>}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
    </label>
  )
}

export function ShapeLibraryDialog<TGeometry = ShapeLibraryGeometry>({
  open,
  initialTab = 'presets',
  presets,
  generatePreview,
  parseUploadFile,
  onApply,
  onClose,
  recentPresetIds = [],
  maxUploadBytes = 20 * 1024 * 1024,
}: ShapeLibraryDialogProps<TGeometry>) {
  const [activeTab, setActiveTab] = useState<ShapeLibraryTab>('presets')
  useEffect(() => { if (open) setActiveTab(initialTab) }, [open, initialTab])
  const [selectedPresetId, setSelectedPresetId] = useState(presets[0]?.id ?? '')
  const [parameters, setParameters] = useState<ShapeLibraryParameters>(() => presetParameters(presets[0]))
  const [applicationMode, setApplicationMode] = useState<ShapeLibraryApplicationMode>('replace-outer')
  const [presetPreview, setPresetPreview] = useState<ShapeLibraryPreviewResult<TGeometry> | null>(null)
  const [uploadPreview, setUploadPreview] = useState<ShapeLibraryPreviewResult<TGeometry> | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadOptions, setUploadOptions] = useState<ShapeLibraryImportOptions>(DEFAULT_IMPORT_OPTIONS)
  const [uploadError, setUploadError] = useState('')
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState('')
  const [sessionRecentIds, setSessionRecentIds] = useState<string[]>([])
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  const selectedPreset = presets.find(preset => preset.id === selectedPresetId) ?? presets[0]
  const recentPresets = useMemo(() => {
    const orderedIds = [...sessionRecentIds, ...recentPresetIds]
    const ids = new Set(orderedIds)
    const explicit = orderedIds
      .map(id => presets.find(preset => preset.id === id))
      .filter((preset): preset is ShapeLibraryPreset => Boolean(preset))
    const dated = presets
      .filter(preset => preset.lastUsedAt && !ids.has(preset.id))
      .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))
    return [...new Map([...explicit, ...dated].map(preset => [preset.id, preset])).values()]
  }, [presets, recentPresetIds, sessionRecentIds])

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(element => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onClose, open])

  useEffect(() => {
    if (!open || activeTab === 'upload' || !selectedPreset) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setPreviewLoading(true)
      setPreviewError('')
      Promise.resolve(generatePreview({ preset: selectedPreset, parameters }, controller.signal))
        .then(result => {
          if (!controller.signal.aborted) setPresetPreview(result)
        })
        .catch(reason => {
          if (!controller.signal.aborted && !isAbortError(reason)) {
            setPresetPreview(null)
            setPreviewError(reason instanceof Error ? reason.message : String(reason))
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false)
        })
    }, 140)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeTab, generatePreview, open, parameters, selectedPreset])

  useEffect(() => {
    if (!open || activeTab !== 'upload' || !uploadFile) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setPreviewLoading(true)
      setUploadError('')
      Promise.resolve(parseUploadFile({ file: uploadFile, options: uploadOptions }, controller.signal))
        .then(result => {
          if (!controller.signal.aborted) setUploadPreview(result)
        })
        .catch(reason => {
          if (!controller.signal.aborted && !isAbortError(reason)) {
            setUploadPreview(null)
            setUploadError(reason instanceof Error ? reason.message : String(reason))
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false)
        })
    }, 160)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeTab, open, parseUploadFile, uploadFile, uploadOptions])

  const choosePreset = useCallback((preset: ShapeLibraryPreset) => {
    setSelectedPresetId(preset.id)
    setParameters(presetParameters(preset))
    setApplyError('')
  }, [])

  const receiveFile = useCallback((file?: File) => {
    if (!file || isApplying) return
    if (!isSupportedUpload(file)) {
      setUploadError('暂不支持这个文件。请选择 SVG、PNG、JPG 或 JPEG。')
      return
    }
    if (file.size > maxUploadBytes) {
      setUploadError(`文件过大，请选择小于 ${formatBytes(maxUploadBytes)} 的图像。`)
      return
    }
    setUploadError('')
    setApplyError('')
    setUploadFile(file)
    setUploadPreview(null)
  }, [maxUploadBytes, isApplying])

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    receiveFile(event.target.files?.[0])
    event.target.value = ''
  }

  const fileDrop = useFileDrop(files => {
    if (files.length !== 1) { setUploadError('板型库一次只接收一张图像'); return }
    receiveFile(files[0])
  }, isApplying, { accept: '.svg,.png,.jpg,.jpeg', maxBytes: maxUploadBytes, onError: setUploadError })

  const updateDimension = (key: 'width' | 'height', nextValue: number) => {
    if (!Number.isFinite(nextValue) || nextValue <= 0) return
    setParameters(current => {
      if (!current.lockAspectRatio) return { ...current, [key]: nextValue }
      const ratio = current.width / Math.max(current.height, 0.001)
      return key === 'width'
        ? { ...current, width: nextValue, height: Math.max(1, nextValue / ratio) }
        : { ...current, height: nextValue, width: Math.max(1, nextValue * ratio) }
    })
  }

  const setRotation = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return
    const normalized = ((nextValue + 180) % 360 + 360) % 360 - 180
    setParameters(current => ({ ...current, rotation: Math.round(normalized * 10) / 10 }))
  }

  const currentPreview = activeTab === 'upload'
    ? uploadFile ? uploadPreview : null
    : selectedPreset ? presetPreview : null
  const currentError = activeTab === 'upload' ? uploadError : previewError
  const currentPresetPath = activeTab === 'upload'
    ? undefined
    : selectedPreset?.thumbnailPath ?? (selectedPreset ? BUILTIN_THUMBNAILS[selectedPreset.kind] : undefined)
  const allErrors = currentPreview?.errors ?? []
  const allWarnings = currentPreview?.warnings ?? []
  const isPreviewLoading = previewLoading && (activeTab === 'upload' ? Boolean(uploadFile) : Boolean(selectedPreset))
  const canApply = Boolean(currentPreview) && !allErrors.length && !currentError && !isApplying && !isPreviewLoading
  const rotationRad = parameters.rotation * Math.PI / 180
  const footprintWidth = Math.abs(parameters.width * Math.cos(rotationRad))
    + Math.abs(parameters.height * Math.sin(rotationRad))
  const footprintHeight = Math.abs(parameters.width * Math.sin(rotationRad))
    + Math.abs(parameters.height * Math.cos(rotationRad))

  const handleApply = async () => {
    if (!currentPreview || !canApply) return
    const source: ShapeLibraryApplyRequest['source'] = activeTab === 'upload' && uploadFile
      ? { type: 'upload', fileName: uploadFile.name, mimeType: uploadFile.type }
      : { type: 'preset', presetId: selectedPreset?.id ?? '' }
    const request: ShapeLibraryApplyRequest = {
      source,
      applicationMode,
      parameters,
      ...(source.type === 'upload' ? { importOptions: uploadOptions } : {}),
    }
    setIsApplying(true)
    setApplyError('')
    try {
      await onApply(currentPreview, request)
      if (source.type === 'preset') {
        setSessionRecentIds(current => [source.presetId, ...current.filter(id => id !== source.presetId)].slice(0, 8))
      }
    } catch (reason) {
      setApplyError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setIsApplying(false)
    }
  }

  if (!open || typeof document === 'undefined') return null

  const shownPresets = activeTab === 'recent' ? recentPresets : presets
  const summary = currentPreview?.summary

  return createPortal(
    <div
      className="shape-library-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="shape-library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="shape-library-header">
          <div className="shape-library-title-mark" aria-hidden="true">◇</div>
          <div>
            <span className="shape-library-eyebrow">SHAPE LIBRARY</span>
            <h2 id={titleId}>创建一块更有个性的板</h2>
            <p id={descriptionId}>从预制轮廓开始，或上传自己的图像提取板型。</p>
          </div>
          <button ref={closeButtonRef} className="shape-library-close" type="button" onClick={onClose} aria-label="关闭板型库">×</button>
        </header>

        <nav className="shape-library-tabs" role="tablist" aria-label="板型来源">
          {TAB_ITEMS.map(tab => (
            <button
              key={tab.id}
              id={`shape-library-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="shape-library-source-panel"
              className={activeTab === tab.id ? 'is-active' : ''}
              onClick={() => {
                setActiveTab(tab.id)
                setApplyError('')
              }}
            >
              <strong>{tab.label}</strong><small>{tab.hint}</small>
            </button>
          ))}
        </nav>

        <div className="shape-library-workspace">
          <section
            id="shape-library-source-panel"
            className="shape-library-source"
            role="tabpanel"
            aria-labelledby={`shape-library-tab-${activeTab}`}
          >
            {activeTab === 'upload' ? (
              <div className="shape-library-upload-pane">
                <div
                  className={`shape-library-dropzone ${fileDrop.dragging ? 'is-dragging' : ''} ${uploadFile ? 'has-file' : ''}`}
                  {...fileDrop.dropProps}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    disabled={isApplying}
                    accept=".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg"
                    onChange={handleFileInput}
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <span className="shape-library-upload-icon" aria-hidden="true">＋</span>
                  {uploadFile ? (
                    <>
                      <strong data-i18n-ignore="true">{uploadFile.name}</strong>
                      <small>{formatBytes(uploadFile.size)} · 已准备提取轮廓</small>
                    </>
                  ) : (
                    <>
                      <strong>把图像拖到这里</strong>
                      <small>支持 SVG、透明 PNG 与 JPG，最大 {formatBytes(maxUploadBytes)}</small>
                    </>
                  )}
                  <button type="button" disabled={isApplying} onClick={() => fileInputRef.current?.click()}>{uploadFile ? '重新选择' : '选择图像'}</button>
                </div>
                <div className="shape-library-upload-controls">
                  <RangeControl
                    label="明暗阈值"
                    value={uploadOptions.threshold}
                    min={0}
                    max={255}
                    suffix=""
                    editable
                    onChange={threshold => setUploadOptions(current => ({ ...current, threshold }))}
                  />
                  <label className="shape-library-toggle-row">
                    <span><b>反相轮廓</b><small>适合浅色主体或深色背景</small></span>
                    <input
                      type="checkbox"
                      checked={uploadOptions.invert}
                      onChange={event => setUploadOptions(current => ({ ...current, invert: event.target.checked }))}
                    />
                  </label>
                  <div className="shape-library-outline-mode" aria-label="轮廓解释方式">
                    <span><b>轮廓解释</b><small>手绘粗线建议使用“闭合线稿”</small></span>
                    <div>
                      <button type="button" className={uploadOptions.outlineInterpretation === 'auto' ? 'is-active' : ''} onClick={() => setUploadOptions(current => ({ ...current, outlineInterpretation: 'auto' }))}>智能</button>
                      <button type="button" className={uploadOptions.outlineInterpretation === 'silhouette' ? 'is-active' : ''} onClick={() => setUploadOptions(current => ({ ...current, outlineInterpretation: 'silhouette' }))}>实心剪影</button>
                      <button type="button" className={uploadOptions.outlineInterpretation === 'closed-stroke' ? 'is-active' : ''} onClick={() => setUploadOptions(current => ({ ...current, outlineInterpretation: 'closed-stroke' }))}>闭合线稿</button>
                    </div>
                  </div>
                  <RangeControl
                    label="边缘平滑"
                    value={uploadOptions.smoothing}
                    min={0}
                    max={100}
                    onChange={smoothing => setUploadOptions(current => ({ ...current, smoothing }))}
                  />
                  <RangeControl
                    label="轮廓简化"
                    value={uploadOptions.simplify}
                    min={0}
                    max={100}
                    onChange={simplify => setUploadOptions(current => ({ ...current, simplify }))}
                  />
                </div>
                <p className="shape-library-privacy-note"><span>✓</span> 分离的文字、图标和装饰点会保留为可独立分割的板件，不再只取最大轮廓。</p>
                <p className="shape-library-privacy-note"><span>✓</span> 图像仅用于本次板型处理，不向普通用户展示文件路径。</p>
              </div>
            ) : shownPresets.length ? (
              <div className="shape-library-preset-grid" aria-label={activeTab === 'recent' ? '最近使用的板型' : '预制板型'}>
                {shownPresets.map(preset => {
                  const path = preset.thumbnailPath ?? BUILTIN_THUMBNAILS[preset.kind]
                  return (
                    <button
                      type="button"
                      className={`shape-library-preset-card ${selectedPreset?.id === preset.id ? 'is-selected' : ''}`}
                      key={preset.id}
                      aria-pressed={selectedPreset?.id === preset.id}
                      onClick={() => choosePreset(preset)}
                    >
                      {preset.recommended && <span className="shape-library-recommended">推荐</span>}
                      <svg viewBox={preset.thumbnailViewBox ?? '0 0 100 100'} aria-hidden="true">
                        {path
                          ? <path d={path} />
                          : <rect x="15" y="20" width="70" height="60" rx="12" />}
                      </svg>
                      <strong>{preset.name}</strong>
                      <small>{preset.description || `${preset.defaultWidth} × ${preset.defaultHeight} mm`}</small>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="shape-library-empty">
                <span>◇</span>
                <strong>{activeTab === 'recent' ? '还没有最近使用的板型' : '板型正在准备中'}</strong>
                <p>{activeTab === 'recent' ? '应用一次预制图形后，它会出现在这里。' : '稍后再来看看，或先上传自己的轮廓。'}</p>
                {activeTab === 'recent' && <button type="button" onClick={() => setActiveTab('presets')}>浏览预制图形</button>}
              </div>
            )}
          </section>

          <main className="shape-library-preview-panel">
            <div className="shape-library-panel-heading">
              <div><span>实时预览</span><h3 data-i18n-ignore={activeTab === 'upload' && uploadFile ? 'true' : undefined}>{activeTab === 'upload' ? uploadFile?.name ?? '自定义板型' : selectedPreset?.name ?? '选择一个板型'}</h3></div>
              <span className={`shape-library-preview-state ${allErrors.length || currentError ? 'has-error' : 'is-ready'}`}>
                <i />{isPreviewLoading ? '正在生成' : allErrors.length || currentError ? '需要调整' : currentPreview ? '轮廓就绪' : '等待输入'}
              </span>
            </div>
            <div className="shape-library-preview-stage">
              <div className="shape-library-stage-grid" />
              {isPreviewLoading && <div className="shape-library-loading"><i /><span>正在整理轮廓…</span></div>}
              <PreviewArtwork result={currentPreview} fallbackPath={currentPresetPath} parameters={parameters} />
              <div className="shape-library-size-readout">
                <span>{Math.round(footprintWidth)} × {Math.round(footprintHeight)} mm</span><i />
                <span>{parameters.rotation.toFixed(parameters.rotation % 1 ? 1 : 0)}°</span>
              </div>
            </div>
            <div className="shape-library-summary" aria-label="轮廓摘要">
              <div><span>预计面积</span><strong>{formatArea(summary?.area)}</strong></div>
              <div><span>轮廓数量</span><strong>{summary?.contourCount ?? '—'}</strong></div>
              <div><span>顶点数量</span><strong>{summary?.vertexCount ?? '—'}</strong></div>
              <div><span>最窄结构</span><strong>{summary?.minFeatureWidth === undefined ? '—' : `${summary.minFeatureWidth.toFixed(1)} mm`}</strong></div>
            </div>
            {(currentError || allErrors.length > 0 || allWarnings.length > 0) && (
              <div className="shape-library-messages" aria-live="polite">
                {currentError && <p className="is-error"><b>!</b><span>{currentError}</span></p>}
                {allErrors.map(error => <p className="is-error" key={error}><b>!</b><span>{error}</span></p>)}
                {allWarnings.map(warning => <p className="is-warning" key={warning}><b>i</b><span>{warning}</span></p>)}
              </div>
            )}
          </main>

          <aside className="shape-library-settings">
            <div className="shape-library-settings-title"><span>参数</span><small>单位：毫米</small></div>
            <section className="shape-library-setting-group">
              <h4>板型尺寸</h4>
              <div className="shape-library-dimension-row">
                <label><span>宽度</span><div><input type="number" min="1" step="1" value={Number(parameters.width.toFixed(2))} onChange={event => updateDimension('width', Number(event.target.value))} /><b>mm</b></div></label>
                <button
                  type="button"
                  className={parameters.lockAspectRatio ? 'is-active' : ''}
                  onClick={() => setParameters(current => ({ ...current, lockAspectRatio: !current.lockAspectRatio }))}
                  aria-pressed={parameters.lockAspectRatio}
                  aria-label={parameters.lockAspectRatio ? '取消等比缩放' : '启用等比缩放'}
                  title="等比缩放"
                >↕</button>
                <label><span>高度</span><div><input type="number" min="1" step="1" value={Number(parameters.height.toFixed(2))} onChange={event => updateDimension('height', Number(event.target.value))} /><b>mm</b></div></label>
              </div>
              <div className="shape-library-flip-row">
                <button type="button" className={parameters.flipX ? 'is-active' : ''} aria-pressed={parameters.flipX} onClick={() => setParameters(current => ({ ...current, flipX: !current.flipX }))}><span>↔</span>水平翻转</button>
                <button type="button" className={parameters.flipY ? 'is-active' : ''} aria-pressed={parameters.flipY} onClick={() => setParameters(current => ({ ...current, flipY: !current.flipY }))}><span>↕</span>垂直翻转</button>
              </div>
              <div className="shape-library-rotation-control">
                <label>
                  <span>旋转角度</span>
                  <div><input type="number" min="-180" max="180" step="1" value={parameters.rotation} onChange={event => setRotation(Number(event.target.value))} /><b>°</b></div>
                </label>
                <div className="shape-library-rotation-actions" aria-label="旋转快捷操作">
                  <button type="button" onClick={() => setRotation(parameters.rotation - 90)}>↶ −90°</button>
                  <button type="button" className={parameters.rotation === 0 ? 'is-active' : ''} onClick={() => setRotation(0)}>归零</button>
                  <button type="button" onClick={() => setRotation(parameters.rotation + 90)}>↷ +90°</button>
                </div>
                <input className="shape-library-rotation-range" type="range" min="-180" max="180" step="1" value={parameters.rotation} aria-label="旋转角度" onChange={event => setRotation(Number(event.target.value))} />
              </div>
            </section>
            {activeTab !== 'upload' && (
              <section className="shape-library-setting-group">
                <h4>轮廓风格</h4>
                <RangeControl label="圆润程度" value={parameters.smoothing} min={0} max={100} onChange={smoothing => setParameters(current => ({ ...current, smoothing }))} />
                <RangeControl label="轮廓细节" value={parameters.detail} min={10} max={100} onChange={detail => setParameters(current => ({ ...current, detail }))} />
              </section>
            )}
            <section className="shape-library-setting-group">
              <h4>应用到草图</h4>
              <div className="shape-library-mode-options">
                <button type="button" className={applicationMode === 'replace-outer' ? 'is-active' : ''} onClick={() => setApplicationMode('replace-outer')} aria-pressed={applicationMode === 'replace-outer'}><span className="shape-library-mode-icon">▱</span><span><b>替换外轮廓</b><small>用当前板型创建整块板</small></span><i /></button>
                <button type="button" className={applicationMode === 'insert-hole' ? 'is-active' : ''} onClick={() => setApplicationMode('insert-hole')} aria-pressed={applicationMode === 'insert-hole'}><span className="shape-library-mode-icon">◇</span><span><b>作为内孔</b><small>在已有板面中开出形状</small></span><i /></button>
              </div>
            </section>
            <div className="shape-library-manufacturing-note"><span>i</span><p><b>应用前会做制造检查</b>过窄结构、自交或未闭合轮廓会在预览中提示。</p></div>
          </aside>
        </div>

        <footer className="shape-library-footer">
          <div aria-live="polite">{applyError ? <span className="shape-library-apply-error">{applyError}</span> : <span>应用后仍可在草图中调整尺寸与位置。</span>}</div>
          <button type="button" className="shape-library-secondary" onClick={onClose}>取消</button>
          <button type="button" className="shape-library-primary" disabled={!canApply} onClick={() => void handleApply()}>{isApplying ? '正在应用…' : applicationMode === 'replace-outer' ? '创建板型' : '插入内孔'}<span>→</span></button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
