import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../store/useAppStore'
import type { BoardTextureConfig, BoardTextureAvoidZone, BoardTextureColorMode, BoardTextureFit, BoardTextureModelingMode } from '../../types/geometry'
import { BOARD_TEXTURE_PRESETS, backBoardTexture, boardTextureForSide, createDefaultBoardTexture, getSplitPanelTextureBounds, texturePanelsForSide, editableTextureComposition, textureCanvasKey, backTextureForRendering, hasBoardTextureSource } from '../../utils/boardTexture'
import { AssemblyMarkingPanel } from '../assemblyMarking/AssemblyMarkingPanel'
import { WoodGrainPanel } from './WoodGrainPanel'
import { SNAPCOLOR_LUTS, normalizeSnapColorLutId } from '../../utils/snapColorLut'
import type { SnapColorProfile } from '../../utils/snapColorPackage'
import { SNAPCOLOR_IMAGE_ACCEPT, snapColorModelingModeAvailable } from '../../config/snapColorFeatures'
import { prepareTextureSvg } from '../../utils/textureSvg'
import { useFileDrop } from '../../hooks/useFileDrop'
import {
  createDefaultTextureComposition,
  createDefaultTextureCrop,
  distributeTextureImages,
  restoreTextureLayers,
  normalizeTextureComposition,
  textureCompositionSignature,
  textureAssetSizeError,
  MAX_TEXTURE_ASSET_BYTES,
  MAX_TEXTURE_SVG_ASSET_BYTES,
  MAX_TEXTURE_SVG_TOTAL_BYTES,
  type TextureComposition,
  type TextureCompositionLayer,
  type TextureCompositionPlacedLayer,
  type TextureImageFit,
} from '../../utils/textureComposition'
import { createDefaultTexturePattern, type TexturePatternId } from '../../utils/texturePatterns'
import { VENEER_MATERIALS, VENEER_FAMILIES, veneerFamily, veneerFamilyPatch } from './veneerMaterials'
import './TextureStudio.css'

const FIT_OPTIONS: Array<{ id: BoardTextureFit; label: string; hint: string }> = [
  { id: 'cover', label: '覆盖', hint: '铺满板面，允许裁掉图片边缘' },
  { id: 'contain', label: '完整', hint: '显示整张图片，可能留下背景边' },
  { id: 'stretch', label: '拉伸', hint: '强制匹配整个板面比例' },
  { id: 'tile', label: '平铺', hint: '把图案重复排列到整块板面' },
]

const COLOR_MODES: Array<{ id: BoardTextureColorMode; label: string }> = [
  { id: 'original', label: '原色' },
  { id: 'mono', label: '黑白' },
  { id: 'posterize', label: '色阶' },
]

const ALL_MODELING_MODES: Array<{ id: BoardTextureModelingMode; label: string; hint: string }> = [
  { id: 'high-fidelity', label: '高保真图片', hint: '叠色区域连续轮廓 · 保留细节与层厚' },
  { id: 'pixel', label: '像素艺术', hint: '保留可见色块，可手动设置格子尺寸' },
  { id: 'vector', label: 'SVG 矢量', hint: '纯色路径直接制造 · 复杂效果自动转图片处理' },
]
const MODELING_MODES = ALL_MODELING_MODES.filter(mode => snapColorModelingModeAvailable(mode.id))

const MATHEMATICAL_PATTERNS: Array<{ id: TexturePatternId; label: string; hint: string }> = [
  { id: 'square', label: '方格密铺', hint: '周期 · 正方形单元交替填色' },
  { id: 'triangle', label: '三角密铺', hint: '周期 · 60°正三角形三色循环' },
  { id: 'hexagon', label: '六边形蜂窝', hint: '周期 · 正六边形共享边阵列' },
  { id: 'truchet-arcs', label: 'Truchet 圆弧砖', hint: '种子化 · 单元素随机转向组合' },
]

const PALETTE_MODES = [
  { id: 'rybw', label: 'RYBW' }, { id: 'cmyw', label: 'CMYW' }, { id: 'bw', label: '黑白' },
  { id: '5color', label: '5色 · 白红黄蓝黑' },
  { id: '6color', label: '6色 · 白青品绿黄黑' },
  { id: '8color', label: '8色 · 白青品黄黑红蓝绿' },
] as const
type PaletteMode = typeof PALETTE_MODES[number]['id']
const lutMode = (id: string): PaletteMode | undefined => {
  const match = id.match(/^snapcolor-petg-(rybw|cmyw|bw|5color|6color|8color)$/)
  return match?.[1] as PaletteMode | undefined
}

const AVOID_ZONE_PRESETS: Array<Omit<BoardTextureAvoidZone, 'id' | 'enabled'>> = [
  { name: '中央视觉核心', x: 0.32, y: 0.3, width: 0.36, height: 0.4 },
  { name: '底部收纳带', x: 0, y: 0, width: 1, height: 0.24 },
  { name: '左侧功能带', x: 0, y: 0.12, width: 0.24, height: 0.76 },
  { name: '右侧功能带', x: 0.76, y: 0.12, width: 0.24, height: 0.76 },
]

const createAvoidZoneId = () => `texture-avoid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const clampUnit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const normalizeAvoidZoneDraft = (zone: BoardTextureAvoidZone): BoardTextureAvoidZone => {
  const x = Math.min(0.98, clampUnit(zone.x))
  const y = Math.min(0.98, clampUnit(zone.y))
  return {
    ...zone,
    x,
    y,
    width: Math.max(0.02, Math.min(1 - x, zone.width)),
    height: Math.max(0.02, Math.min(1 - y, zone.height)),
  }
}

interface TextureRangeProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  inputMax?: number
  onChange(value: number): void
}

function TextureRange({ label, value, min, max, step, unit = '', inputMax = max, onChange }: TextureRangeProps) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const cancelBlur = useRef(false)
  const displayed = Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0'
  const commit = (raw: string) => {
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw.trim())) {
      const number = Number(raw.trim())
      if (Number.isFinite(number)) onChange(Math.round(Math.max(min, Math.min(inputMax, number)) * 100) / 100)
    }
    setDraft(null)
  }
  return (
    <div className="texture-range">
      <div className="texture-range-heading"><label htmlFor={id}>{label}</label><span className="texture-range-value">
        <input type="text" inputMode="decimal" aria-label={label} value={draft ?? displayed}
          onFocus={event => { cancelBlur.current = false; setDraft(displayed); event.currentTarget.select() }}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') { cancelBlur.current = true; setDraft(null); event.currentTarget.blur() }
          }}
          onBlur={event => { if (cancelBlur.current) { cancelBlur.current = false; return } commit(event.currentTarget.value) }} />
        {unit.trim() && <small>{unit.trim()}</small>}
      </span></div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(+event.target.value)} />
    </div>
  )
}

const loadBrowserImage = (file: File): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.onload = () => {
    URL.revokeObjectURL(url)
    resolve(image)
  }
  image.onerror = () => {
    URL.revokeObjectURL(url)
    reject(new Error('浏览器无法解码这张图片，请改用 PNG、JPG 或 WebP'))
  }
  image.src = url
})

async function prepareImage(file: File): Promise<{ dataUrl: string; aspect: number; width: number; height: number; mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'; vector: boolean }> {
  const lowerName = file.name.toLowerCase()
  const vector = file.type === 'image/svg+xml' || lowerName.endsWith('.svg')
  const sizeError = textureAssetSizeError(file.size, vector ? 'image/svg+xml' : 'image/png')
  if (sizeError) throw new Error(sizeError)
  if (vector) {
    const prepared = prepareTextureSvg(await file.text())
    const image = new Image()
    image.src = prepared.dataUrl
    try { await image.decode() } catch { throw new Error('SVG 已解析但浏览器无法解码，请检查嵌入图片或将字体转曲后重试') }
    return { ...prepared, aspect: prepared.width / prepared.height, mime: 'image/svg+xml', vector: true }
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
      && !/\.(png|jpe?g|webp)$/i.test(lowerName)) throw new Error('当前只支持 PNG、JPG 或 WebP 图片')
  const image = await loadBrowserImage(file)
  const limit = 1600
  const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法创建图片处理画布')
  ctx.drawImage(image, 0, 0, width, height)
  const transparent = file.type === 'image/png' || file.type === 'image/webp' || /\.(png|webp)$/i.test(lowerName)
  const mime = transparent ? 'image/png' : 'image/webp'
  return {
    dataUrl: canvas.toDataURL(mime, 0.9),
    aspect: width / height,
    width,
    height,
    mime,
    vector: false,
  }
}

export function TextureStudio({ docked = false }: { docked?: boolean }) {
  const open = useAppStore(state => state.ui.textureStudioOpen)
  const rootSetUI = useAppStore(state => state.setUI)
  const editSide = useAppStore(state => state.boardTexture.backEnabled ? state.ui.textureEditSide : 'front')
  const selectedTextureLayerId = useAppStore(state => editSide === 'back' ? state.ui.selectedBackTextureLayerId : state.ui.selectedTextureLayerId)
  const setUI = (partial: Parameters<typeof rootSetUI>[0]) => {
    if (editSide === 'back' && 'selectedTextureLayerId' in partial) {
      const { selectedTextureLayerId, ...other } = partial
      rootSetUI({ ...other, selectedBackTextureLayerId: selectedTextureLayerId })
    } else rootSetUI(partial)
  }
  const storedTexture = useAppStore(state => state.boardTexture)
  const marking = useAppStore(state => state.assemblyMarking)
  const projectName = useAppStore(state => state.project.metadata.name)
  const textureSolve = useAppStore(state => state.textureSolve)
  const runTextureSolve = useAppStore(state => state.runTextureSolve)
  const texture = { ...createDefaultBoardTexture(), ...boardTextureForSide(storedTexture, editSide), lutId: normalizeSnapColorLutId(storedTexture.lutId) }
  const setRootTexture = useAppStore(state => state.setBoardTexture)
  const setTextureSide = useAppStore(state => state.setBoardTextureSide)
  const setTexture = (partial: Partial<BoardTextureConfig>) => setTextureSide(editSide, partial)
  const splitResult = useAppStore(state => state.splitResult)
  const splitConfig = useAppStore(state => state.splitConfig)
  const inputRef = useRef<HTMLInputElement>(null)
  const [sourcePicker, setSourcePicker] = useState<'preset' | 'pattern' | 'library' | null>(null)
  const [replaceLayerId, setReplaceLayerId] = useState<string | null>(null)
  const [aspectLocked, setAspectLocked] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [resetProgress, setResetProgress] = useState<number | null>(null)
  const resetDoneTimer = useRef<number | null>(null)
  const [minimized, setMinimized] = useState(false)
  const [inspectorTarget, setInspectorTarget] = useState<HTMLElement | null>(null)
  const [lutOptions, setLutOptions] = useState([...SNAPCOLOR_LUTS])
  const [profiles, setProfiles] = useState<SnapColorProfile[]>([])
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const refreshLutOptions = () => void import('../../utils/snapColorPackage')
    .then(api => api.listSnapColorProfiles())
    .then(items => { setProfiles(items); setLutOptions([...SNAPCOLOR_LUTS]); setProfilesLoaded(true) })
    .catch(() => setProfilesLoaded(true))
  useEffect(() => {
    setInspectorTarget(docked && open ? document.getElementById('workbench-properties') : null)
  }, [docked, open])
  useEffect(() => {
    if (open) refreshLutOptions()
  }, [open])
  useEffect(() => {
    window.addEventListener('snapboard:snapcolor-profiles-updated', refreshLutOptions)
    return () => window.removeEventListener('snapboard:snapcolor-profiles-updated', refreshLutOptions)
  }, [])
  useEffect(() => {
    if (resetProgress !== 70) return
    // The texture state has committed; the viewport rebuild runs in this commit.
    const frame = window.requestAnimationFrame(() => {
      setResetProgress(100)
      resetDoneTimer.current = window.setTimeout(() => setResetProgress(null), 900)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [resetProgress, storedTexture])
  useEffect(() => () => {
    if (resetDoneTimer.current !== null) window.clearTimeout(resetDoneTimer.current)
  }, [])
  const imageDrop = useFileDrop(files => importFiles(files, null), uploading, {
    accept: SNAPCOLOR_IMAGE_ACCEPT, onError: setError,
    maxBytes: mime => mime === 'image/svg+xml' ? MAX_TEXTURE_SVG_ASSET_BYTES : MAX_TEXTURE_ASSET_BYTES,
  })
  if (!open) return null

  const panels = texturePanelsForSide(splitResult?.panels ?? [], editSide)

  const bounds = getSplitPanelTextureBounds(panels)
  const actualPanels = splitResult?.panels ?? []
  const renderedBack = backTextureForRendering(storedTexture, actualPanels, splitConfig, marking, projectName)
  const frontKey = textureCanvasKey(storedTexture, bounds.width / bounds.height, actualPanels)
  const backKey = renderedBack ? textureCanvasKey(renderedBack, bounds.width / bounds.height, texturePanelsForSide(actualPanels, 'back')) : null
  const frontReady = !!textureSolve.canvas && textureSolve.frontKey === frontKey
  const backReady = !!textureSolve.backCanvas && textureSolve.backKey === backKey
  const colorReady = frontReady && (!storedTexture.backEnabled || backReady)
  const structuralCoreMm = splitConfig.thickness - texture.textureThickness * (storedTexture.backEnabled ? 2 : 1)
  const structuralThickness = Math.max(0.2, structuralCoreMm)
  const registeredLut = lutOptions.find(lut => lut.id === texture.lutId)
  const selectedProfile = profiles.find(profile => profile.id === texture.lutId)
  const selectedLut = texture.lutId.startsWith('snapcolor-farm:') && profilesLoaded && !selectedProfile ? undefined : registeredLut
  const activeLut = selectedLut ?? lutOptions[0]
  const selectedMode = selectedProfile?.mode ?? lutMode(texture.lutId)
  const matchingLuts = lutOptions.filter(lut => lutMode(lut.id) === selectedMode || profiles.some(profile => profile.id === lut.id && profile.mode === selectedMode))
  const minimumColorThickness = activeLut.layerCount * activeLut.layerHeight + 0.08
  const opticalThickness = activeLut.layerCount * activeLut.layerHeight
  const studioMode = texture.surfaceMode === 'snapcolor' ? 'image' : 'material'
  const composition = editableTextureComposition(texture, panels)
  const selectedLayer = composition.layers.find(layer => layer.id === selectedTextureLayerId) ?? composition.layers.at(-1)
  const selectedImageLayer = selectedLayer && selectedLayer.kind !== 'panel-sequence' ? selectedLayer : null
  const activePattern = selectedLayer?.kind === 'pattern' ? selectedLayer.pattern : texture.pattern
  const setPattern = (pattern: typeof activePattern) => selectedLayer?.kind === 'pattern' && updateLayer(selectedLayer.id, layer => layer.kind === 'pattern' ? { ...layer, pattern } : layer)
  const selectedAsset = selectedImageLayer?.kind === 'image' ? composition.assets.find(asset => asset.id === selectedImageLayer.assetId) : undefined
  const imageAspect = selectedAsset && selectedImageLayer?.kind === 'image'
    ? ((selectedAsset.width || selectedAsset.aspect * 1000) * selectedImageLayer.placement.crop.width)
      / Math.max(1, selectedAsset.height * selectedImageLayer.placement.crop.height) : 1
  const imageSizeSliderMax = Math.min(1_000_000, Math.max(20,
    Math.hypot(bounds.width, bounds.height) * Math.max(4, imageAspect * 2, 2 / Math.max(.01, imageAspect)),
    selectedImageLayer?.placement.mode === 'free' || selectedImageLayer?.placement.mode === 'repeat'
      ? selectedImageLayer.placement.transform.widthMm : 0,
    selectedImageLayer?.placement.mode === 'free' || selectedImageLayer?.placement.mode === 'repeat'
      ? selectedImageLayer.placement.transform.heightMm : 0))
  const avoidPreviewImage = selectedAsset?.dataUrl
  const selectedPreset = BOARD_TEXTURE_PRESETS.find(preset => preset.id === texture.presetId) ?? BOARD_TEXTURE_PRESETS[0]
  const enabledAvoidZoneCount = texture.avoidZones.filter(zone => zone.enabled).length
  const transparentVeneer = texture.surfaceMaterialKind === 'transparent-petg'
  const materialFamily = veneerFamily(texture)

  const setSurfaceOverride = (key: keyof typeof texture.surfacePrintOverrides, input: HTMLInputElement, min: number, max: number) => {
    const value = Number(input.value)
    if (input.value && (!Number.isFinite(value) || value < min || value > max)) {
      setError(`校准值必须在 ${min}–${max} 之间`)
      input.value = String(texture.surfacePrintOverrides[key] ?? '')
      return
    }
    setError('')
    setTexture({ surfacePrintOverrides: { ...texture.surfacePrintOverrides, [key]: input.value ? value : undefined } })
  }

  const addAvoidZone = (preset: Omit<BoardTextureAvoidZone, 'id' | 'enabled'>) => {
    if (texture.avoidZones.length >= 32) return
    setTexture({ avoidZones: [...texture.avoidZones, { ...preset, id: createAvoidZoneId(), enabled: true }] })
  }

  const updateAvoidZone = (id: string, partial: Partial<BoardTextureAvoidZone>) => {
    setTexture({
      avoidZones: texture.avoidZones.map(zone => zone.id === id
        ? normalizeAvoidZoneDraft({ ...zone, ...partial })
        : zone),
    })
  }

  const removeAvoidZone = (id: string) => {
    setTexture({ avoidZones: texture.avoidZones.filter(zone => zone.id !== id) })
  }

  const setComposition = (next: TextureComposition, selectedLayerId?: string) => {
    const normalized = normalizeTextureComposition(next)
    if (normalized.layers.length !== next.layers.length || normalized.assets.length !== next.assets.length) {
      setError('素材或图层超过容量，请减少数量或缩小文件。')
      return
    }
    setTexture({ enabled: normalized.layers.length > 0, source: 'composition', surfaceMode: 'snapcolor', opacity: 1, composition: normalized })
    if (selectedLayerId !== undefined) setUI({ selectedTextureLayerId: selectedLayerId })
  }

  const importFiles = async (files?: FileList | File[], replaceTarget = replaceLayerId) => {
    if (uploading) return
    const requested = Array.from(files ?? []).slice(0, replaceTarget ? 1 : 12)
    if (!requested.length) return
    setUploading(true)
    setError('')
    try {
      const results: PromiseSettledResult<{ file: File; prepared: Awaited<ReturnType<typeof prepareImage>> }>[] = []
      let batchSvgBytes = 0
      // Prepare sequentially so several large XML/decode jobs do not peak together.
      for (const file of requested) {
        try {
          const vector = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
          if (vector && batchSvgBytes + file.size > MAX_TEXTURE_SVG_TOTAL_BYTES) throw new Error('本次导入的 SVG 总量不能超过 256 MB')
          const prepared = await prepareImage(file)
          if (vector) batchSvgBytes += file.size
          results.push({ status: 'fulfilled', value: { file, prepared } })
        } catch (reason) { results.push({ status: 'rejected', reason }) }
      }
      const prepared = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${requested[index].name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : [])
      if (!prepared.length) throw new Error(failures.join('\n'))
      const latest = editableTextureComposition(boardTextureForSide(useAppStore.getState().boardTexture, editSide), panels)
      let next = latest.layers.length
        ? structuredClone(latest)
        : createDefaultTextureComposition()
      let lastLayerId = ''
      for (const [index, item] of prepared.entries()) {
        const revision = textureCompositionSignature(item.prepared.dataUrl)
        let asset = next.assets.find(candidate => candidate.dataUrl === item.prepared.dataUrl)
        if (!asset) {
          const baseId = `texture-${revision}`
          let id = baseId, suffix = 2
          while (next.assets.some(candidate => candidate.id === id)) id = `${baseId}-${suffix++}`
          asset = {
            id, name: item.file.name, mime: item.prepared.mime, dataUrl: item.prepared.dataUrl,
            width: item.prepared.width, height: item.prepared.height, aspect: item.prepared.aspect, revision,
          }
          next.assets.push(asset)
        }
        const whole = !next.layers.length && prepared.length === 1
        const widthMm = whole ? bounds.width : Math.max(20, Math.min(160, bounds.width * 0.55 || 100))
        const heightMm = whole ? bounds.height : widthMm / Math.max(0.05, asset.aspect)
        const layerId = `image-layer-${Date.now().toString(36)}-${index}-${revision}`
        if (replaceTarget) {
          next.layers = next.layers.map(layer => layer.id === replaceTarget && layer.kind === 'image' ? { ...layer, assetId: asset.id, name: asset.name } : layer)
          lastLayerId = replaceTarget
          continue
        }
        next.layers.push({
          id: layerId, kind: 'image', name: item.file.name, assetId: asset.id,
          visible: true, locked: false, opacity: 1,
          placement: {
            mode: 'free', autoFit: whole, fit: 'cover', crop: createDefaultTextureCrop(),
            transform: {
              xMm: bounds.minX + bounds.width / 2 + index * 8,
              yMm: bounds.minY + bounds.height / 2 - index * 8,
              widthMm, heightMm, rotationDeg: 0, flipX: false, flipY: false,
            },
          },
        })
        lastLayerId = layerId
      }
      const normalized = normalizeTextureComposition(next)
      if (normalized.layers.length !== next.layers.length) throw new Error('图片超出资源容量或图层上限，请减少数量或缩小文件后再导入')
      next = normalized
      setComposition(next, lastLayerId)
      if (prepared.some(item => item.prepared.vector)) setTexture({ modelingMode: 'vector' })
      if (failures.length) setError(`已导入 ${prepared.length} 张；${failures.join('\n')}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setUploading(false)
      setReplaceLayerId(null); setSourcePicker(null)
    }
  }

  const updateLayer = (layerId: string, update: (layer: TextureCompositionLayer) => TextureCompositionLayer) => {
    setComposition({ ...composition, layers: composition.layers.map(layer => {
      if (layer.id !== layerId) return layer
      const next = update(layer)
      if (layer.kind !== 'panel-sequence' && next.kind !== 'panel-sequence' && layer.placement.mode === 'free' && layer.placement.autoFit && next.placement.mode === 'free' && next.placement.autoFit
        && JSON.stringify(layer.placement.transform) !== JSON.stringify(next.placement.transform)) return { ...next, placement: { ...next.placement, autoFit: false } }
      return next
    }) }, layerId)
  }

  const freeLayersForAssets = () => composition.assets.map((asset, index): TextureCompositionLayer => {
    const widthMm = Math.max(20, Math.min(160, bounds.width * 0.55 || 100))
    return {
      id: `restored-layer-${Date.now().toString(36)}-${index}-${asset.id}`,
      kind: 'image', name: asset.name, assetId: asset.id, visible: true, locked: false, opacity: 1,
      placement: {
        mode: 'free', fit: 'cover', crop: createDefaultTextureCrop(),
        transform: {
          xMm: bounds.minX + bounds.width / 2 + index * 8,
          yMm: bounds.minY + bounds.height / 2 - index * 8,
          widthMm, heightMm: widthMm / Math.max(0.05, asset.aspect), rotationDeg: 0, flipX: false, flipY: false,
        },
      },
    }
  })

  const restoreAssetsAsFreeLayers = () => {
    const sequence = composition.layers.find(layer => layer.kind === 'panel-sequence')
    const saved = sequence?.kind === 'panel-sequence' ? sequence.restoreVisibility : undefined
    const layers = saved && sequence ? restoreTextureLayers(composition, sequence.id).layers : freeLayersForAssets()
    setComposition({ ...composition, layers }, layers.at(-1)?.id ?? '')
  }

  const removeLayer = (layerId: string) => {
    const removed = composition.layers.find(layer => layer.id === layerId)
    let layers = composition.layers.filter(layer => layer.id !== layerId)
    // “每板一张”会临时把自由图层收成一个序列层。退出唯一序列时恢复图层，
    // 图片资源永远不随排列层删除；资源删除必须是另一个显式动作。
    if (removed?.kind === 'panel-sequence') layers = removed.restoreVisibility ? restoreTextureLayers(composition, removed.id).layers : layers.some(layer => layer.kind === 'image') ? layers : freeLayersForAssets()
    setComposition({ ...composition, layers }, layers.at(-1)?.id ?? '')
  }

  const activateAsset = (assetId: string) => {
    const existing = composition.layers.find(layer => layer.kind === 'image' && layer.assetId === assetId)
    if (existing) { setUI({ selectedTextureLayerId: existing.id }); return }
    const asset = composition.assets.find(item => item.id === assetId)
    if (!asset) return
    const widthMm = Math.max(20, Math.min(160, bounds.width * 0.55 || 100))
    const layer: TextureCompositionLayer = {
      id: `asset-layer-${Date.now().toString(36)}-${asset.id}`,
      kind: 'image', name: asset.name, assetId: asset.id, visible: true, locked: false, opacity: 1,
      placement: { mode: 'free', fit: 'cover', crop: createDefaultTextureCrop(), transform: { xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2, widthMm, heightMm: widthMm / Math.max(.05, asset.aspect), rotationDeg: 0, flipX: false, flipY: false } },
    }
    setComposition({ ...composition, layers: [...composition.layers, layer] }, layer.id)
  }

  const moveLayer = (layerId: string, direction: -1 | 1) => {
    const index = composition.layers.findIndex(layer => layer.id === layerId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= composition.layers.length) return
    const layers = [...composition.layers]
    ;[layers[index], layers[target]] = [layers[target], layers[index]]
    setComposition({ ...composition, layers }, layerId)
  }

  const setSelectedLayerPlacement = (mode: 'whole' | 'free' | 'grid' | 'brick' | 'per-panel') => {
    if (!selectedImageLayer) return
    updateLayer(selectedImageLayer.id, layer => {
      if (layer.kind === 'panel-sequence') return layer
      const current = layer.placement
      const fallbackTransform = current.mode === 'free' || current.mode === 'repeat'
        ? current.transform
        : {
            xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2,
            widthMm: Math.max(20, bounds.width * .45), heightMm: Math.max(20, bounds.height * .45),
            rotationDeg: current.rotationDeg, flipX: current.flipX, flipY: current.flipY,
          }
      if (mode === 'whole') return { ...layer, placement: { mode: 'free', autoFit: true, fit: current.fit, crop: current.crop, transform: { xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2, widthMm: bounds.width, heightMm: bounds.height, rotationDeg: 0, flipX: false, flipY: false } } }
      if (mode === 'per-panel') return { ...layer, placement: { mode: 'per-panel', panelIds: 'all', fit: current.fit, crop: current.crop, insetMm: 0, rotationDeg: fallbackTransform.rotationDeg, flipX: fallbackTransform.flipX, flipY: fallbackTransform.flipY } }
      if (mode === 'grid' || mode === 'brick') return { ...layer, placement: { mode: 'repeat', transform: fallbackTransform, fit: current.fit, crop: current.crop, repeat: { kind: mode, gapXmm: 0, gapYmm: 0, alternateFlipX: false, alternateFlipY: false } } }
      return { ...layer, placement: { mode: 'free', transform: fallbackTransform, fit: current.fit, crop: current.crop } }
    })
  }

  const distributeImagesToPanels = () => {
    const id = crypto.randomUUID()
    setComposition(distributeTextureImages(composition, panels, id), id)
  }

  const wholeLayer = selectedImageLayer?.placement.mode === 'free' &&
    Math.abs(selectedImageLayer.placement.transform.xMm - bounds.minX - bounds.width / 2) < .01 &&
    Math.abs(selectedImageLayer.placement.transform.yMm - bounds.minY - bounds.height / 2) < .01 &&
    Math.abs(selectedImageLayer.placement.transform.widthMm - bounds.width) < .01 &&
    Math.abs(selectedImageLayer.placement.transform.heightMm - bounds.height) < .01 && Math.abs(selectedImageLayer.placement.transform.rotationDeg) < .01
  const resizeLayer = (axis: 'widthMm' | 'heightMm', value: number) => {
    if (!selectedImageLayer) return
    updateLayer(selectedImageLayer.id, layer => {
      if (layer.kind === 'panel-sequence' || (layer.placement.mode !== 'free' && layer.placement.mode !== 'repeat')) return layer
      const t = layer.placement.transform
      const ratio = t.widthMm / t.heightMm
      const transform = { ...t, [axis]: value, ...(aspectLocked ? axis === 'widthMm' ? { heightMm: value / ratio } : { widthMm: value * ratio } : {}) }
      return { ...layer, placement: { ...layer.placement, transform } }
    })
  }
  const addProcedural = (kind: 'preset' | 'pattern', id: string) => {
    const idLayer = crypto.randomUUID()
    const common = { id: idLayer, visible: true, locked: false, opacity: 1,
      placement: { mode: 'free' as const, autoFit: true, fit: 'stretch' as const, crop: createDefaultTextureCrop(), transform: {
        xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2,
        widthMm: bounds.width, heightMm: bounds.height, rotationDeg: 0, flipX: false, flipY: false } } }
    const layer: TextureCompositionPlacedLayer = kind === 'preset'
      ? { ...common, kind, presetId: id, name: BOARD_TEXTURE_PRESETS.find(p => p.id === id)?.name ?? '图案' }
      : { ...common, kind, pattern: createDefaultTexturePattern(id as TexturePatternId), name: MATHEMATICAL_PATTERNS.find(p => p.id === id)?.label ?? '数学纹样' }
    setComposition({ ...composition, layers: [...composition.layers, layer] }, idLayer)
    setSourcePicker(null)
  }

  const resetTexture = () => {

          if (!window.confirm('重置当前工程的全部纹理、图片图层和制造参数？')) return
          if (resetDoneTimer.current !== null) window.clearTimeout(resetDoneTimer.current)
          setResetProgress(20)
          window.requestAnimationFrame(() => {
            setRootTexture(createDefaultBoardTexture())
            setResetProgress(70)
          })

  }

  const inspector = <div key={editSide} className="texture-properties">
    {error && <p className="texture-import-error" role="alert">{error}</p>}
    <div className="texture-active-target"><span><b>{storedTexture.backEnabled ? `${editSide === 'front' ? '正面' : '背面'}外观属性` : '外观属性'}</b><small title={selectedImageLayer?.name}>{selectedImageLayer && studioMode === 'image' ? selectedImageLayer.name : '当前板面的外观设置'}</small></span></div>
    {studioMode === 'material' && <section className="texture-section texture-veneer-family" aria-label="材质贴面设置">
      <header className="texture-section-title"><span><b>材质贴面</b><small>先选耗材类型，再调整贴面</small></span></header>
      <div className="texture-veneer-families" role="group" aria-label="材质类型">
        {VENEER_FAMILIES.map(family => <button key={family.id} type="button" aria-pressed={materialFamily === family.id}
          data-family={family.id} onClick={() => setRootTexture(veneerFamilyPatch(texture, family.id))}>
          <span aria-hidden="true" className="texture-veneer-swatch"/><span><b>{family.label}</b><small>{family.hint}</small></span>
        </button>)}
      </div>
      {materialFamily === 'decorative' && <>
        <label className="texture-layout-choice">装饰耗材示例<select aria-label="装饰耗材示例" value={VENEER_MATERIALS.some(material => material.name === texture.surfaceMaterialName) ? texture.surfaceMaterialName : ''}
          onChange={event => {
            const selected = VENEER_MATERIALS.find(material => material.name === event.target.value)
            if (selected) setTexture({ surfaceMaterialName: selected.name, surfaceColor: selected.color })
          }}><option value="">自定义料卷</option>{VENEER_MATERIALS.map(material => <option key={material.name} value={material.name}>{material.name}</option>)}</select></label>
        <p className="texture-inline-note">质感由料卷本身形成，沿用常规贴面工艺。色标仅用于预览。</p>
      </>}
      {materialFamily === 'transparent' && <section className="texture-veneer-parameters" aria-label="透明 PETG 参数">
        <label className="texture-layout-choice">透明效果<select aria-label="透明效果" value={texture.surfacePrintGoal} onChange={event => setTexture({
          surfacePrintGoal: event.target.value as typeof texture.surfacePrintGoal,
          ...(event.target.value !== 'standard' ? { surfaceFinish: 'textured-pei' as const } : {}) })}>
          <option value="standard">常规质感</option><option value="frosted">细磨砂 · 试验</option><option value="clear-experimental">清亮 · 试验</option>
        </select></label>
        <div className="texture-material-grid texture-calibration-grid">
          <label><span>喷嘴温度 °C · 220–270</span><input key={`compact-nozzle-${texture.surfacePrintOverrides.nozzleTempC ?? ''}`} type="number" min="220" max="270" step="1" defaultValue={texture.surfacePrintOverrides.nozzleTempC ?? ''} placeholder="沿用 245"
            onBlur={event => setSurfaceOverride('nozzleTempC', event.currentTarget, 220, 270)} /></label>
          <label><span>风扇 % · 0–100</span><input key={`compact-fan-${texture.surfacePrintOverrides.fanPercent ?? ''}`} type="number" min="0" max="100" step="1" defaultValue={texture.surfacePrintOverrides.fanPercent ?? ''}
            placeholder={texture.surfacePrintGoal === 'clear-experimental' ? '试验 0' : texture.surfacePrintGoal === 'frosted' ? '试验 20' : '沿用料卷'} onBlur={event => setSurfaceOverride('fanPercent', event.currentTarget, 0, 100)} /></label>
        </div>
        <p className="texture-inline-note">清亮方案使用更细实心走线，会更耗时。基材底色和层线会影响透明观感，请先试打。</p>
      </section>}
      {materialFamily === 'wood' && <WoodGrainPanel compact value={texture.woodGrain} onChange={woodGrain => setTexture({ woodGrain,
        ...(woodGrain.filamentType !== texture.woodGrain.filamentType ? { baseMaterialName: `普通 ${woodGrain.filamentType}`, surfaceMaterialName: `仿木 ${woodGrain.filamentType}` } : {}) })} />}
      <TextureRange label="贴面厚度" value={texture.textureThickness} min={0.4} max={Math.max(.4, Math.min(2, splitConfig.thickness - .2))} step={.1} unit=" mm" onChange={textureThickness => setTexture({ textureThickness })} />
      <p className="texture-inline-note">总板厚 {splitConfig.thickness.toFixed(1)} mm · 基层 {structuralCoreMm.toFixed(1)} mm · 贴面 {texture.textureThickness.toFixed(1)} mm</p>
      {structuralCoreMm < .2 && <p className="texture-profile-warning" role="alert">贴面超过可用厚度，请减薄贴面，或在板材设计中增加总厚度。</p>}
    </section>}
    {studioMode === 'image' && selectedLayer?.kind === 'pattern' && <section className="texture-section"><header className="texture-section-title"><b>图案参数</b></header>
              <div className="texture-control-grid">
                <TextureRange label="单元尺寸" value={activePattern.cellSizeMm} min={6} max={100} step={1} unit=" mm" onChange={cellSizeMm => setPattern( { ...activePattern, cellSizeMm })} />
                <TextureRange label="线条宽度" value={activePattern.lineWidthMm} min={0.5} max={4} step={0.1} unit=" mm" onChange={lineWidthMm => setPattern( { ...activePattern, lineWidthMm })} />
              </div>
              <div className="texture-pattern-style">
                {(['filled', 'alternating', 'outline'] as const).map(style => <button type="button" key={style} className={activePattern.style === style ? 'on' : ''}
                  onClick={() => setPattern( { ...activePattern, style })}>{style === 'filled' ? '填色' : style === 'alternating' ? '交替' : '描边'}</button>)}
                <button type="button" onClick={() => setPattern( { ...activePattern, seed: crypto.getRandomValues(new Uint32Array(1))[0] })}>换一种</button>
              </div>
              <div className="texture-pattern-palette">
                {activePattern.palette.slice(0, 4).map((color, index) => <label key={`${index}-${color}`}><span>颜色 {index + 1}</span><input type="color" value={color} onChange={event => setPattern( { ...activePattern, palette: activePattern.palette.map((item, itemIndex) => itemIndex === index ? event.target.value.toUpperCase() : item) })} /></label>)}
              </div>
              <p className="texture-inline-note">方格、三角和六边形是周期密铺；Truchet 使用坐标哈希决定每个单元朝向，同一种子在预览、分板和3MF中保持一致。</p>
    </section>}
    {studioMode === 'image' && <>
                {selectedImageLayer && <div key={selectedImageLayer.id} className="texture-layer-inspector">
                  <div className="texture-layer-arrangements">
                    <button type="button" className={wholeLayer ? 'on' : ''} onClick={() => setSelectedLayerPlacement('whole')}>整幅</button>
                    <button type="button" className={selectedImageLayer.placement.mode === 'free' && !wholeLayer ? 'on' : ''} onClick={() => setSelectedLayerPlacement('free')}>自由</button>
                    <button type="button" className={selectedImageLayer.placement.mode === 'repeat' ? 'on' : ''} onClick={() => setSelectedLayerPlacement('grid')}>阵列</button>
                    <button type="button" className={selectedImageLayer.placement.mode === 'per-panel' ? 'on' : ''} onClick={() => setSelectedLayerPlacement('per-panel')}>每板</button>
                  </div>
                  {selectedImageLayer.placement.mode === 'repeat' && <label className="texture-layout-choice">阵列方式<select value={selectedImageLayer.placement.repeat.kind} onChange={e => setSelectedLayerPlacement(e.target.value as 'grid' | 'brick')}><option value="grid">规则阵列</option><option value="brick">错列阵列</option></select></label>}
                  {selectedImageLayer.placement.mode === 'per-panel' && selectedImageLayer.kind === 'image' && <button type="button" className="texture-minor-action" onClick={distributeImagesToPanels}>按图片顺序分配 / 逐板指定</button>}
                  <div className="texture-fit-options">{FIT_OPTIONS.filter(option => option.id !== 'tile').map(option => <button type="button" key={option.id} title={option.hint} className={selectedImageLayer.placement.fit === option.id ? 'on' : ''}
                    onClick={() => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' ? { ...layer, placement: { ...layer.placement, fit: option.id as TextureImageFit } } : layer)}>{option.label}</button>)}</div>
                  {selectedImageLayer.placement.fit === 'contain' && <p className="texture-inline-note">“完整”会按图片比例留白；直接铺满请选择“覆盖”（可能裁掉图片边缘）。</p>}
                  {selectedImageLayer.placement.mode === 'free' || selectedImageLayer.placement.mode === 'repeat' ? <div className="texture-control-grid">
                    <TextureRange label="X 位置" value={selectedImageLayer.placement.transform.xMm} min={bounds.minX - bounds.width} max={bounds.minX + bounds.width * 2} step={1} unit=" mm" onChange={xMm => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat') ? { ...layer, placement: { ...layer.placement, transform: { ...layer.placement.transform, xMm } } } : layer)} />
                    <TextureRange label="Y 位置" value={selectedImageLayer.placement.transform.yMm} min={bounds.minY - bounds.height} max={bounds.minY + bounds.height * 2} step={1} unit=" mm" onChange={yMm => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat') ? { ...layer, placement: { ...layer.placement, transform: { ...layer.placement.transform, yMm } } } : layer)} />
                    <label className="texture-enable"><input type="checkbox" checked={aspectLocked} onChange={e => setAspectLocked(e.target.checked)} />等比调整宽高</label>
                    <TextureRange label="宽度" value={selectedImageLayer.placement.transform.widthMm} min={10} max={imageSizeSliderMax} inputMax={1_000_000} step={1} unit=" mm" onChange={value => resizeLayer('widthMm', value)} />
                    <TextureRange label="高度" value={selectedImageLayer.placement.transform.heightMm} min={10} max={imageSizeSliderMax} inputMax={1_000_000} step={1} unit=" mm" onChange={value => resizeLayer('heightMm', value)} />
                    <TextureRange label="旋转" value={selectedImageLayer.placement.transform.rotationDeg} min={-180} max={180} step={1} unit="°" onChange={rotationDeg => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat') ? { ...layer, placement: { ...layer.placement, transform: { ...layer.placement.transform, rotationDeg } } } : layer)} />
                    {selectedImageLayer.placement.mode === 'repeat' && <><TextureRange label="水平间距" value={selectedImageLayer.placement.repeat.gapXmm} min={0} max={100} step={1} unit=" mm" onChange={gapXmm => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' && layer.placement.mode === 'repeat' ? { ...layer, placement: { ...layer.placement, repeat: { ...layer.placement.repeat, gapXmm } } } : layer)} /><TextureRange label="垂直间距" value={selectedImageLayer.placement.repeat.gapYmm} min={0} max={100} step={1} unit=" mm" onChange={gapYmm => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' && layer.placement.mode === 'repeat' ? { ...layer, placement: { ...layer.placement, repeat: { ...layer.placement.repeat, gapYmm } } } : layer)} /></>}
                  </div> : <TextureRange label="板内缩" value={selectedImageLayer.placement.insetMm} min={0} max={20} step={0.5} unit=" mm" onChange={insetMm => updateLayer(selectedImageLayer.id, layer => layer.kind !== 'panel-sequence' && layer.placement.mode === 'per-panel' ? { ...layer, placement: { ...layer.placement, insetMm } } : layer)} />}
                  <TextureRange label="图层透明度" value={selectedImageLayer.opacity * 100} min={5} max={100} step={1} unit="%" onChange={opacity => updateLayer(selectedImageLayer.id, layer => ({ ...layer, opacity: opacity / 100 }))} />
                </div>}
                {selectedLayer?.kind === 'panel-sequence' && <div className="texture-panel-assignment">
                  <header><div><b>逐板指定图片</b><small>每块板可以选择任意已导入图片</small></div><button type="button" onClick={() => updateLayer(selectedLayer.id, layer => layer.kind === 'panel-sequence' ? { ...layer, panelAssetMap: undefined } : layer)}>恢复自动顺序</button></header>
                  <div>{panels.map((panel, index) => {
                    const automatic = selectedLayer.assetIds[index % selectedLayer.assetIds.length]
                    return <label key={panel.id}><span>{panel.id.toUpperCase()}</span><select value={selectedLayer.panelAssetMap?.[panel.id] ?? automatic} onChange={event => updateLayer(selectedLayer.id, layer => layer.kind === 'panel-sequence' ? { ...layer, panelAssetMap: { ...(layer.panelAssetMap ?? {}), [panel.id]: event.target.value } } : layer)}>
                      {composition.assets.map(asset => <option key={asset.id} value={asset.id} data-i18n-ignore="true">{asset.name}</option>)}
                    </select></label>
                  })}</div>
                  <button type="button" className="texture-exit-sequence" onClick={restoreAssetsAsFreeLayers}>退出每板模式并恢复自由图层</button>
                </div>}
    </>}
        {studioMode === 'image' && <details className="texture-section texture-avoidance">
          <summary className="texture-section-title">
            <span><b>纹理避让区</b><small>{enabledAvoidZoneCount ? `${enabledAvoidZoneCount} 个区域回填基材色` : '保护徽标、留白与配件密集区域'}</small></span>
          </summary>
          <>
            <div className="texture-avoid-preview" style={{ background: texture.surfaceMode === 'veneer' ? texture.surfaceColor : selectedPreset.preview }}>
              {avoidPreviewImage && <img src={avoidPreviewImage} alt="避让区背景预览" />}
              {texture.avoidZones.map(zone => <span key={zone.id} className={zone.enabled ? '' : 'disabled'} title={zone.name} style={{
                left: `${zone.x * 100}%`, bottom: `${zone.y * 100}%`, width: `${zone.width * 100}%`, height: `${zone.height * 100}%`,
              }}>{zone.enabled ? '基材' : '暂停'}</span>)}
            </div>
            <div className="texture-avoid-presets" aria-label="添加纹理避让区">
              {AVOID_ZONE_PRESETS.map(preset => <button type="button" key={preset.name} disabled={texture.avoidZones.length >= 32} onClick={() => addAvoidZone(preset)}>＋ {preset.name}</button>)}
            </div>
            {texture.avoidZones.length === 0 ? (
              <p className="texture-inline-note">避让区不会删除板件或孔位，只会在 3D 预览与 3MF 纹理画布中显示基材色。</p>
            ) : (
              <div className="texture-avoid-list">
                {texture.avoidZones.map(zone => <article key={zone.id} className={zone.enabled ? '' : 'disabled'}>
                  <div className="texture-avoid-row">
                    <label className="texture-avoid-toggle"><input type="checkbox" checked={zone.enabled} onChange={event => updateAvoidZone(zone.id, { enabled: event.target.checked })} /><span>启用</span></label>
                    <input className="texture-avoid-name" value={zone.name} maxLength={80} aria-label="避让区名称" onChange={event => updateAvoidZone(zone.id, { name: event.target.value })} />
                    <button type="button" className="texture-avoid-remove" onClick={() => removeAvoidZone(zone.id)} aria-label={`删除 ${zone.name}`}>删除</button>
                  </div>
                  <div className="texture-control-grid">
                    <TextureRange label="距左" value={zone.x * 100} min={0} max={Math.max(0, (1 - zone.width) * 100)} step={1} unit="%" onChange={value => updateAvoidZone(zone.id, { x: value / 100 })} />
                    <TextureRange label="距底" value={zone.y * 100} min={0} max={Math.max(0, (1 - zone.height) * 100)} step={1} unit="%" onChange={value => updateAvoidZone(zone.id, { y: value / 100 })} />
                    <TextureRange label="宽度" value={zone.width * 100} min={2} max={Math.max(2, (1 - zone.x) * 100)} step={1} unit="%" onChange={value => updateAvoidZone(zone.id, { width: value / 100 })} />
                    <TextureRange label="高度" value={zone.height * 100} min={2} max={Math.max(2, (1 - zone.y) * 100)} step={1} unit="%" onChange={value => updateAvoidZone(zone.id, { height: value / 100 })} />
                  </div>
                </article>)}
              </div>
            )}
          </>
        </details>}

        {studioMode !== 'material' && <details className="texture-section texture-color-section"><summary>当前面图像效果</summary>
          <header className="texture-section-title">
            <span><b>图像效果</b><small>仅调节图案观感，修改实时生效；黑白效果不会切换为黑白两料配色</small></span>
          </header>
          <><div className="texture-color-modes">
            {COLOR_MODES.map(mode => (
              <button type="button" key={mode.id} className={texture.colorMode === mode.id ? 'on' : ''}
                onClick={() => setTexture({ colorMode: mode.id })}>{mode.label}</button>
            ))}
          </div>
          <div className="texture-control-grid">
            <TextureRange label="亮度" value={texture.brightness} min={0.4} max={1.6} step={0.02} onChange={brightness => setTexture({ brightness })} />
            <TextureRange label="对比度" value={texture.contrast} min={0.4} max={1.6} step={0.02} onChange={contrast => setTexture({ contrast })} />
            <TextureRange label="饱和度" value={texture.saturation} min={0} max={1.8} step={0.02} onChange={saturation => setTexture({ saturation })} />
          </div>
          <label className="texture-enable texture-cleanup" title="在叠色匹配前稳定相近颜色，再清理小块杂色；限制色差，保留明显的轮廓与阴影。关闭可对比原匹配效果。"><input type="checkbox" checked={texture.cleanup} onChange={event => setTexture({ cleanup: event.target.checked })} /><span>抑制色斑（保留原图边缘）</span></label>
          {studioMode === 'image' && <>              <div className="texture-image-model-modes">
                {MODELING_MODES.map(mode => (
                  <button type="button" key={mode.id} className={texture.modelingMode === mode.id ? 'on' : ''}
                    title={mode.hint} onClick={() => setTexture({ modelingMode: mode.id })}><b>{mode.label}</b><small>{mode.hint}</small></button>
                ))}
              </div>
              {texture.modelingMode === 'pixel' && <TextureRange label="像素格尺寸" value={texture.pixelSize} min={0.4} max={6} step={0.1} unit="mm" onChange={pixelSize => setTexture({ pixelSize })} />}</>}
            {texture.colorMode !== 'original' && <TextureRange label="目标色阶" value={texture.colorCount} min={2} max={8} step={1} unit=" 色" onChange={colorCount => setTexture({ colorCount })} />}
          <details className="texture-advanced-settings"><summary className="texture-section-title"><b>高级颜色与制造设置</b></summary>
          <div className="texture-print-note"><b>光学层说明</b><span>切片器按档案中各实体耗材显示层色，不会模拟透光后的混合色；网页板面是最终正面观感预览。</span></div>
          <TextureRange label="颜色细节" value={texture.quantizeColors} min={8} max={96} step={4} unit=" 色" onChange={quantizeColors => setTexture({ quantizeColors })} />
          <TextureRange label="色相保护" value={texture.hueWeight} min={0} max={1} step={0.05} onChange={hueWeight => setTexture({ hueWeight })} />

          {texture.modelingMode !== 'pixel' && <label className="texture-enable texture-cleanup" title="减少阶梯与碎线段；关闭可对比 V1.1 网格方式。实际效果请先打印试样。"><input type="checkbox" checked={texture.manufacturingContours !== false} onChange={event => setTexture({ manufacturingContours: event.target.checked })} /><span>连续轮廓制造（试验，可关闭对比）</span></label>}
          {texture.modelingMode !== 'pixel' && <label className="texture-lut-select"><span><b>制造边缘质量</b><small>精细档按毫米采样并重建共享边界；请先打印试样对照</small></span>
            <select value={texture.manufacturingEdgeQuality ?? 'standard'} onChange={event => setTexture({ manufacturingEdgeQuality: event.target.value as 'standard' | 'fine' })}>
              <option value="standard">标准 · 保留原导出</option><option value="fine">精细 · 抗锯齿试验</option>
            </select>
          </label>}
          </details>
          </>
        </details>}

        {texture.surfaceMode === 'snapcolor' && <section className="texture-section texture-palette-section">
          <header className="texture-section-title"><span><b>材料与配色</b><small>当前工程共用 · 修改实时生效</small></span></header>
          <aside className="texture-source-credit" aria-label="校色来源与实现">
            <b>来源与实现</b>
            <span>部分内置 PETG 校色数据来自 <a href="https://github.com/lumina-layer-studio/Lumina-Layers" target="_blank" rel="noopener noreferrer">Lumina Studio v1.6.9</a>（GPLv3）。SnapColor 负责工程配色与导出接入；SVG 路径解析由 SnapBoard 实现。</span>
          </aside>
          <div className="texture-material-grid"><span className="texture-material-label">材料</span><b className="texture-material-value">{selectedProfile ? '档案未记录' : selectedLut ? 'PETG' : '未知'}</b></div>
          <label className="texture-lut-select"><span><b>配色模式</b><small>选择耗材组合</small></span>
            <select value={selectedMode ?? ''} onChange={event => {
              const next = lutOptions.find(lut => lutMode(lut.id) === event.target.value)
                ?? lutOptions.find(lut => profiles.some(profile => profile.id === lut.id && profile.mode === event.target.value))
              if (next) setTexture({ lutId: next.id })
            }}>
              {!selectedMode && <option value="">档案已缺失</option>}
              {PALETTE_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
          <label className="texture-lut-select"><span><b>校色档案</b><small>选用已有档案；在右上角设置管理</small></span>
            <select title={selectedProfile?.name ?? selectedLut?.name} value={selectedLut ? texture.lutId : ''} onChange={event => setTexture({ lutId: event.target.value as typeof texture.lutId })}>
              {!selectedLut && <option value="">当前档案已缺失</option>}
              {matchingLuts.map(lut => {
                const profile = profiles.find(item => item.id === lut.id)
                return <option key={lut.id} value={lut.id}>{profile ? `${profile.name} · ${profile.revision}` : `${lut.name} · 内置实测`}</option>
              })}
            </select>
          </label>
          {selectedLut ? <small className="texture-lut-description">{selectedProfile ? `${selectedProfile.name} · ${selectedProfile.revision} · ${selectedProfile.status === 'verified' ? '已验证' : '实验档案'}` : '内置实测档案'} · {selectedLut.materials.map(item => item.name).join(' / ')} · {selectedLut.layerCount} 层 × {selectedLut.layerHeight.toFixed(2)} mm</small>
            : <p className="texture-profile-warning" role="alert">工程引用的校色档案已缺失。请选择现有档案；不会自动替换原档案。</p>}
          {(texture.textureThickness < minimumColorThickness || splitConfig.thickness < minimumColorThickness * (storedTexture.backEnabled ? 2 : 1) + (storedTexture.backEnabled ? 2.5 : 0.2)) && <p className="texture-profile-warning" role="alert">所选配色{storedTexture.backEnabled ? '每面' : ''}至少需要 {minimumColorThickness.toFixed(2)} mm 彩色表层，并保留 {storedTexture.backEnabled ? '2.50' : '0.20'} mm 结构基材。当前{storedTexture.backEnabled ? '每面' : ''}表层 {texture.textureThickness.toFixed(2)} mm、总厚度 {splitConfig.thickness.toFixed(2)} mm；请调整厚度。</p>}
        </section>}

        <details key={studioMode} className="texture-shared-settings"><summary>{studioMode === 'material' ? '基材与详细工艺' : '材料与制造 · 两面共用'}</summary>
        <section className="texture-section texture-layer-plan">
          <header className="texture-section-title"><span><b>工程制造参数</b><small>当前工程共用 · 修改实时生效</small></span></header>
          <h3 className="texture-group-heading">材料与基材</h3>
          <div className="texture-material-grid">
            <label><span>基材名称（工程记录）</span><input type="text" value={texture.baseMaterialName} maxLength={80} onChange={event => setTexture({ baseMaterialName: event.target.value })} /></label>
            <label className="texture-color-input"><span>显示标记</span><input type="color" value={texture.baseColor} onChange={event => setTexture({ baseColor: event.target.value.toUpperCase() })} /></label>
            {studioMode === 'material' && <>
              <label><span>实际料卷名称</span><input type="text" value={texture.surfaceMaterialName} maxLength={80} onChange={event => setTexture({ surfaceMaterialName: event.target.value })} /></label>
              <label className="texture-color-input"><span>表层颜色标记</span><input type="color" value={texture.surfaceColor} onChange={event => setTexture({ surfaceColor: event.target.value.toUpperCase() })} /></label>
            </>}
          </div>
          <p className="texture-inline-note">名称和色标用于工程标记；实际料卷请在切片器中核对。</p>
          {texture.surfaceMode !== 'woodgrain' && <><h3 className="texture-group-heading">表面工艺</h3>
          <div className="texture-finish-options">
            <button type="button" className={texture.surfaceFinish === 'textured-pei' ? 'on' : ''} onClick={() => setTexture({ surfaceFinish: 'textured-pei' })}><b>{storedTexture.backEnabled ? '正面朝下' : '细磨砂面'}</b><small>{storedTexture.backEnabled ? '背面朝上 · 正面接触热床' : '朝下 · 纹理 PEI 接触面'}</small></button>
            <button type="button" className={texture.surfaceFinish === 'smooth-top' ? 'on' : ''} onClick={() => setTexture({ surfaceFinish: 'smooth-top', ...(texture.surfaceMode === 'veneer' && texture.surfacePrintGoal !== 'standard' ? { surfacePrintGoal: 'standard' as const } : {}) })}><b>{storedTexture.backEnabled ? '背面朝下' : '普通顶面'}</b><small>{storedTexture.backEnabled ? '正面朝上 · 背面接触热床' : '朝上 · 打印顶面走线'}</small></button>
          </div>
          <p className="texture-inline-note">{storedTexture.backEnabled ? '两面都复用彩色薄层，中间保留结构芯；此选项只决定整件的打印朝向，两面位置和总板厚不变。' : texture.surfaceFinish === 'textured-pei' ? '装饰面朝下，基材底层随表层覆盖调整。' : '装饰面朝上，基材底面保留贴床底层。'}</p></>}
          {texture.surfaceMode === 'veneer' && <>
            <p className="texture-inline-note">{transparentVeneer ? '透明贴面仍受基材底色、层线和热床纹理影响；请先打小样，不保证整板透视。' : '大理石、金属视觉和闪粉料共用贴面流程；磨料或颗粒是否需要更大喷嘴，请以实际料卷说明为准。'}</p>
            <details className="texture-advanced-settings"><summary className="texture-section-title"><b>查看料卷制造参数</b></summary>
              <div className="texture-material-grid texture-calibration-grid">
                <label><span>料卷厂牌</span><input type="text" value={texture.surfaceFilamentVendor} maxLength={80} placeholder="未填写：Generic" onChange={event => setTexture({ surfaceFilamentVendor: event.target.value })} /></label>
                {!transparentVeneer && <label><span>喷嘴 °C · 220–270</span><input key={`nozzle-${texture.surfacePrintOverrides.nozzleTempC ?? ''}`} type="number" min="220" max="270" step="1" defaultValue={texture.surfacePrintOverrides.nozzleTempC ?? ''} placeholder="沿用 245" onBlur={event => setSurfaceOverride('nozzleTempC', event.currentTarget, 220, 270)} /></label>}
                <label><span>流量倍率 · 0.85–1.15</span><input key={`flow-${texture.surfacePrintOverrides.flowRatio ?? ''}`} type="number" min="0.85" max="1.15" step="0.01" defaultValue={texture.surfacePrintOverrides.flowRatio ?? ''} placeholder="沿用 0.95" onBlur={event => setSurfaceOverride('flowRatio', event.currentTarget, 0.85, 1.15)} /></label>
                <label><span>最大体积流量 mm³/s · 3–30</span><input key={`maxflow-${texture.surfacePrintOverrides.maxFlowMm3s ?? ''}`} type="number" min="3" max="30" step="0.5" defaultValue={texture.surfacePrintOverrides.maxFlowMm3s ?? ''} placeholder={transparentVeneer && texture.surfacePrintGoal !== 'standard' ? '预设 15' : '沿用 21'} onBlur={event => setSurfaceOverride('maxFlowMm3s', event.currentTarget, 3, 30)} /></label>
                {!transparentVeneer && <label><span>风扇 % · 0–100</span><input key={`fan-${texture.surfacePrintOverrides.fanPercent ?? ''}`} type="number" min="0" max="100" step="1" defaultValue={texture.surfacePrintOverrides.fanPercent ?? ''} placeholder="沿用料卷" onBlur={event => setSurfaceOverride('fanPercent', event.currentTarget, 0, 100)} /></label>}
              </div>
              <p>结构层仍为 0.28mm；贴面层高：{transparentVeneer && texture.surfacePrintGoal === 'clear-experimental' ? '0.10' : transparentVeneer && texture.surfacePrintGoal === 'frosted' ? '0.20' : '0.28'}mm。导出后请在切片器核对真实料卷、有效温度、冷却、预计时间与孔位公差。</p>
            </details>
          </>}
          <><h3 className="texture-group-heading">厚度分配</h3>
          <p className="texture-thickness-summary">总厚度 {splitConfig.thickness.toFixed(1)} mm（在板材工作区调整） · 结构基材 {structuralCoreMm.toFixed(1)} mm（自动计算） · {storedTexture.backEnabled ? '正反各' : '表层'} {texture.textureThickness.toFixed(1)} mm</p>
          {structuralCoreMm < (storedTexture.backEnabled ? 2.5 : 0.2) && <p className="texture-profile-warning" role="alert">{storedTexture.backEnabled ? '双面映射需要至少 2.5 mm 结构芯；请增加总板厚或减薄两面表层。' : '当前表层超过可用厚度，请在板材工作区增加总厚度，或缩小表层厚度。'}</p>}
          {texture.surfaceMode === 'snapcolor' && <p className="texture-inline-note">彩色表层：承托 {Math.max(0, texture.textureThickness - opticalThickness).toFixed(2)} mm + 光学 {opticalThickness.toFixed(2)} mm（档案决定）</p>}
          <TextureRange label="基材填充" value={texture.baseInfillDensity} min={5} max={50} step={1} unit="%" onChange={baseInfillDensity => setTexture({ baseInfillDensity })} />
          <button type="button" className="texture-minor-action" onClick={() => setTexture({ baseInfillDensity: 10 })}>设为 10% 填充</button>
          {studioMode === 'image' && <TextureRange label="彩色纹理层" value={texture.textureThickness} min={opticalThickness + 0.08}
            max={Math.max(opticalThickness + 0.08, Math.min(2, storedTexture.backEnabled ? (splitConfig.thickness - 2.5) / 2 : splitConfig.thickness - 0.2))} step={0.01} unit=" mm"
            onChange={textureThickness => setTexture({ textureThickness })} />}
          {texture.surfaceMode === 'snapcolor' && <div className="texture-edge-seal-control">
            <label className="texture-enable texture-edge-seal-toggle">
              <input type="checkbox" checked={texture.edgeSealEnabled} onChange={event => setTexture({ edgeSealEnabled: event.target.checked })} />
              <span>基材单线封边墙</span>
            </label>
            <p>在外轮廓、长孔、圆孔和其他孔边，用1号基材耗材包住全部彩色光学层，减少边缘短线段、换色毛边和悬空料头。</p>
            {texture.edgeSealEnabled && <TextureRange label="封边宽度" value={texture.edgeSealWidth} min={0.3} max={1.2} step={0.05} unit=" mm"
              onChange={edgeSealWidth => setTexture({ edgeSealWidth })} />}
          </div>}
          <div className="texture-layer-bar">
            {storedTexture.backEnabled && <span className="art" style={{ flex: texture.textureThickness }}><b>{texture.textureThickness.toFixed(1)} mm</b><small>背面彩色层</small></span>}
            <span style={{ flex: structuralThickness }}><b>{structuralThickness.toFixed(1)} mm</b><small>结构板体</small></span>
            <span className="art" style={{ flex: texture.textureThickness }}><b>{texture.textureThickness.toFixed(1)} mm</b><small>{storedTexture.backEnabled ? '正面彩色层' : texture.surfaceMode === 'snapcolor' ? `${Math.max(0, texture.textureThickness - opticalThickness).toFixed(2)} 承托 + ${opticalThickness.toFixed(2)} 光学` : texture.surfaceMaterialName}</small></span>
          </div>
          <details className="texture-advanced-settings"><summary className="texture-section-title"><b>查看制造参数</b></summary>
            {texture.surfaceMode==='woodgrain'&&<p>1 号普通料打印低填充基材；2 号仿木料仅打印 {texture.textureThickness.toFixed(1)}mm 质感层，0.08mm 细层高。修改器只改变质感层。</p>}
            <p>结构基材：0.28mm 层高、2 壁、{Math.round(texture.baseInfillDensity)}% 填充；顶部 4 层、0.6mm。稀疏／内部实心线宽 0.8mm，外墙／内墙／顶面 0.42mm。</p>
            <p>{texture.surfaceFinish === 'textured-pei' ? '装饰面朝下，基材底部 0 层、0mm。' : '装饰面朝上，基材底部 3 层、0.6mm。'}{texture.surfaceMode === 'snapcolor' ? '承托和光学层 100% 实心；0.10mm 级自适应采样，大板自动调整精度。' : '贴面层 100% 实心；具体料卷参数在上方查看。'}</p>
            {texture.surfaceMode==='snapcolor'&&<p>叠色层：首层轮廓 30、填充 80mm/s；后续外墙 60、内墙 100、内部填充 140、顶面 100mm/s。彩色线宽仍为 0.42mm，承托顶面使用 0.8mm 宽线、180mm/s。实际速度受体积流量和加速度限制。</p>}
          </details></>
        </section>
        </details>
        <AssemblyMarkingPanel />
  </div>

  return (
    <aside className={`texture-studio${minimized && !docked ? ' is-minimized' : ''}${docked ? ' is-docked' : ''}`} role={docked ? 'region' : 'dialog'} aria-label="外观素材"
      data-dragging={imageDrop.dragging || undefined} {...imageDrop.dropProps}>
      <input ref={inputRef} hidden type="file" multiple disabled={uploading || imageDrop.loading} accept={SNAPCOLOR_IMAGE_ACCEPT} onChange={event => { void importFiles(event.target.files ?? undefined); event.target.value = '' }} />
      <header className="texture-studio-head">
        <div>
          <span className="texture-studio-kicker">SNAPCOLOR STUDIO</span>
          <strong>纹理工作室</strong>
          <small>选择图案来源，再在右侧调整属性</small>
        </div>
        <label className="texture-enable" title="保留参数但暂时关闭纹理">
          <input type="checkbox" checked={texture.enabled} onChange={event => setRootTexture({ enabled: event.target.checked })} />
          <span>{texture.enabled ? '已启用' : '已关闭'}</span>
        </label>
        {!docked && <button className="texture-minimize" type="button" onClick={() => setMinimized(value => !value)}
          aria-label={minimized ? '展开纹理工作室' : '最小化纹理工作室'} title={minimized ? '展开纹理工作室' : '最小化纹理工作室'}>{minimized ? '⌄' : '⌃'}</button>}
        {!docked && <button className="texture-close" type="button" onClick={() => setUI({ textureStudioOpen: false, occlusionAnalysisOpen: false, partsOpen: docked })} aria-label="关闭纹理工作室">×</button>}
      </header>

      <div className="texture-source-tabs texture-side-mode-tabs" role="group" aria-label="纹理映射模式">
        <button type="button" className={!storedTexture.backEnabled && studioMode !== 'material' ? 'on' : ''} onClick={() => { setRootTexture({ backEnabled: false, surfaceMode: 'snapcolor' }); rootSetUI({ textureEditSide: 'front' }); setSourcePicker(null); setError('') }}>单面映射</button>
        <button type="button" className={storedTexture.backEnabled ? 'on' : ''}
          title="正面和背面分别设置图片；自动切换到彩色映射"
          onClick={() => { setRootTexture({ backEnabled: true }); rootSetUI({ textureEditSide: 'front' }); setSourcePicker(null); setError('') }}>双面映射</button>
      </div>
      {storedTexture.backEnabled && <div className="texture-source-tabs texture-edit-side-tabs" role="group" aria-label="编辑映射面">
        <button type="button" className={editSide === 'front' ? 'on' : ''} onClick={() => { rootSetUI({ textureEditSide: 'front' }); setSourcePicker(null) }}>正面</button>
        <button type="button" className={editSide === 'back' ? 'on' : ''} onClick={() => { rootSetUI({ textureEditSide: 'back' }); setSourcePicker(null) }}>背面</button>
      </div>}
      <div className="texture-primary-import" {...imageDrop.dropProps}>
        <button type="button" className="texture-import-primary texture-dropzone" disabled={uploading || imageDrop.loading}
          onClick={() => { setRootTexture({ surfaceMode: 'snapcolor' }); setReplaceLayerId(null); inputRef.current?.click() }}>
          <span className="texture-drop-icon" aria-hidden="true">＋</span>
          <span><b>{uploading || imageDrop.loading ? '正在导入…' : composition.layers.some(l => l.kind === 'image') ? '添加图片 / SVG' : '导入' + (editSide === 'front' ? '正面' : '背面') + '图片 / SVG'}</b>
            <small>{imageDrop.dragging ? '松开即可导入' : '点击选择，或拖到这里'}</small></span>
        </button>
        <small>当前编辑{editSide === 'front' ? '正面' : '背面'} · 本地文件或网页图片 · 单张默认铺满</small>
        {selectedAsset && <div className="texture-current-image"><img src={selectedAsset.dataUrl} alt="当前图片" /><span title={selectedAsset.name} data-i18n-ignore="true">{selectedAsset.name}</span>
          <button type="button" disabled={uploading || imageDrop.loading} onClick={() => { setRootTexture({ surfaceMode: 'snapcolor' }); setReplaceLayerId(selectedLayer?.id ?? null); inputRef.current?.click() }}>更换图片</button></div>}
        {storedTexture.backEnabled && <button className="texture-copy-face" type="button"
          disabled={!hasBoardTextureSource(boardTextureForSide(storedTexture, editSide === 'front' ? 'back' : 'front'))}
          title="复制另一面的内容，之后独立编辑；空白面不能覆盖当前面" onClick={() => {
          const other = editSide === 'front' ? 'back' : 'front'
          const from = boardTextureForSide(storedTexture, other)
          const { backEnabled: _enabled, backTexture: _back, backImageDataUrl: _oldImage, backImageName: _oldName, backImageAspect: _oldAspect, ...appearance } = from
          setTexture({ ...appearance, composition: structuredClone(editableTextureComposition(from, texturePanelsForSide(splitResult?.panels ?? [], other))), source: 'composition', opacity: 1 })
        }}>复制{editSide === 'front' ? '背面到正面' : '正面到背面'}</button>}
      </div>
      <div className="texture-source-tabs texture-source-shortcuts" aria-label="其他纹理来源">
        <button type="button" className={sourcePicker === 'preset' ? 'on' : ''} onClick={() => { setRootTexture({ surfaceMode: 'snapcolor' }); setSourcePicker(sourcePicker === 'preset' ? null : 'preset'); setError('') }}>内置图案</button>
        <button type="button" className={sourcePicker === 'pattern' ? 'on' : ''} onClick={() => { setRootTexture({ surfaceMode: 'snapcolor' }); setSourcePicker(sourcePicker === 'pattern' ? null : 'pattern'); setError('') }}>数学纹样</button>
        <button type="button" className={studioMode === 'material' ? 'on' : ''}
          onClick={() => { setRootTexture({ enabled: true, surfaceMode: texture.surfaceMode === 'woodgrain' ? 'woodgrain' : 'veneer' }); setSourcePicker(null); setError('') }}>材质贴面</button>
      </div>
      <div className="texture-studio-scroll">
        {sourcePicker && <section className="texture-source-picker" aria-label="添加素材">
          <header><b>{sourcePicker === 'library' ? '素材库' : '添加素材'}</b><button type="button" onClick={() => setSourcePicker(null)} aria-label="关闭素材选择">×</button></header>
          {sourcePicker === 'preset' && <div className="texture-preset-grid">{BOARD_TEXTURE_PRESETS.map(preset =>
            <button type="button" key={preset.id} onClick={() => addProcedural('preset', preset.id)}>
              <span className="texture-preset-preview" style={{ background: preset.preview }} /><span><b>{preset.name}</b><small>{preset.description}</small></span>
            </button>)}</div>}
          {sourcePicker === 'pattern' && <div className="texture-pattern-grid">{MATHEMATICAL_PATTERNS.map(pattern =>
            <button type="button" key={pattern.id} onClick={() => addProcedural('pattern', pattern.id)}><b>{pattern.label}</b><small>{pattern.hint}</small></button>)}</div>}
          {sourcePicker === 'library' && <div className="texture-asset-tray">{composition.assets.map(asset =>
            <button type="button" key={asset.id} onClick={() => { activateAsset(asset.id); setSourcePicker(null) }}><img src={asset.dataUrl} alt="" /><span data-i18n-ignore="true">{asset.name}</span></button>)}</div>}
        </section>}
        {!panels.length && <div className="texture-empty"><b>尚无板件</b><span>先在板材设计中生成板件，素材和图层会保留。</span></div>}
        <section className="texture-section texture-main-layers">
          <header className="texture-section-title"><span><b>{studioMode === 'material' ? '材质贴面' : `${editSide === 'front' ? '正面' : '背面'}图层`}</b><small>在右侧调整参数</small></span>
            {composition.assets.length > 1 && !composition.layers.some(l => l.kind === 'panel-sequence') && <button type="button" className="texture-minor-action" onClick={distributeImagesToPanels}>每板一张</button>}</header>
          {studioMode === 'material' ? <p className="texture-inline-note">在右侧选择耗材并调整参数。</p> : <>
            {!composition.layers.length && <p className="texture-empty-layer-note">点击上方“导入图片”，或直接拖入图片。</p>}
            <div className="texture-layer-list" aria-label="当前面图层">
              {[...composition.layers].reverse().filter(layer => !composition.layers.some(s => s.kind === 'panel-sequence' && s.visible && s.restoreVisibility && layer.id in s.restoreVisibility)).map(layer =>
                <article key={layer.id} className={layer.id === selectedLayer?.id ? 'on' : ''} onClick={() => setUI({ selectedTextureLayerId: layer.id })}>
                  <label><input type="checkbox" checked={layer.visible} aria-label={'显示 ' + layer.name} onChange={e => { e.stopPropagation(); updateLayer(layer.id, l => ({ ...l, visible: e.target.checked })) }} /></label>
                  <div><b title={layer.name} data-i18n-ignore="true">{layer.name}</b><small>{layer.kind === 'panel-sequence' ? '每板分配' : layer.kind === 'pattern' ? '数学纹样' : layer.kind === 'preset' ? '内置图案' : '图片'}</small></div>
                  <button type="button" onClick={e => { e.stopPropagation(); moveLayer(layer.id, 1) }} aria-label={'上移 ' + layer.name}>↑</button>
                  <button type="button" onClick={e => { e.stopPropagation(); moveLayer(layer.id, -1) }} aria-label={'下移 ' + layer.name}>↓</button>
                  <button type="button" onClick={e => { e.stopPropagation(); removeLayer(layer.id) }} aria-label={'删除 ' + layer.name}>×</button>
                </article>)}
            </div>
          </>}
          {error && <p className="texture-import-error" role="alert">{error}</p>}
        </section>
        <details className="texture-advanced-actions"><summary>素材库与高级操作</summary><div>
          <button type="button" onClick={() => setSourcePicker('library')}>打开素材库（{composition.assets.length}）</button>
          <button type="button" onClick={() => setComposition(createDefaultTextureComposition(), '')}>清空当前面</button>
          <button type="button" disabled={resetProgress !== null} onClick={resetTexture}>重置全部纹理…</button>
        </div></details>
        {!inspectorTarget && inspector}

      </div>

      <footer className="texture-studio-foot">
        <span className="texture-solve-info" role="status">{!storedTexture.enabled ? '纹理已暂停' : texture.surfaceMode === 'woodgrain' ? '木纹走线示意 · 实际效果请查看切片' : studioMode === 'material' ? '材质贴面 · 实际质感以料卷为准' : !hasBoardTextureSource(storedTexture) ? '请为正面添加素材' : storedTexture.backEnabled && !backBoardTexture(storedTexture) ? '请为背面添加素材'
          : !panels.length ? '等待分割结果'
          : textureSolve.status === 'solving' ? '正在更新配色预览…布局仍可编辑'
          : colorReady ? storedTexture.backEnabled ? '正背面配色已更新' : '配色结果已更新'
          : textureSolve.status === 'error' ? `配色更新失败：${textureSolve.error}`
          : '排版预览 · 配色待更新'}</span>
        {texture.surfaceMode === 'snapcolor' && <button type="button" className="texture-solve-button" disabled={!texture.enabled || !hasBoardTextureSource(storedTexture) || (!!storedTexture.backEnabled && !backBoardTexture(storedTexture)) || !panels.length || textureSolve.status === 'solving' || colorReady}
          onClick={() => void runTextureSolve()}>更新配色</button>}
        {resetProgress !== null && <span className="texture-reset-progress" role="status">
          {resetProgress === 100 ? '纹理已重置' : '正在重置纹理…'}
          <progress aria-label="纹理重置进度" value={resetProgress} max={100} />
        </span>}
      </footer>
      <small className="texture-source-mini">校色数据：<a href="https://github.com/lumina-layer-studio/Lumina-Layers" target="_blank" rel="noopener noreferrer">Lumina v1.6.9（GPLv3）</a> · SnapColor 接入</small>
      {inspectorTarget && createPortal(inspector, inspectorTarget)}
    </aside>
  )
}
