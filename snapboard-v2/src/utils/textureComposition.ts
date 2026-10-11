/**
 * 多图片纹理编排的纯数据层。
 *
 * 本模块不依赖 Canvas、Three.js 或 store。它只负责：
 * - 工程数据的严格归一化；
 * - 旧单图配置迁移；
 * - 自由摆放、矩形/错列阵列、每板贴图与板件序列的确定性解析。
 *
 * layers 数组顺序即绘制顺序：索引 0 为最底层，最后一个为最顶层。
 */

import { normalizeTexturePattern, type TexturePatternConfig } from './texturePatterns'

export const TEXTURE_COMPOSITION_SCHEMA_VERSION = 1 as const
export const MAX_TEXTURE_ASSETS = 32
export const MAX_TEXTURE_LAYERS = 64
export const MAX_TEXTURE_ASSET_BYTES = 16 * 1024 * 1024
export const MAX_TEXTURE_TOTAL_BYTES = 64 * 1024 * 1024
// Raster budgets stay unchanged; traced SVGs use their own bounded resource pool.
export const MAX_TEXTURE_SVG_ASSET_BYTES = 128 * 1024 * 1024
export const MAX_TEXTURE_SVG_TOTAL_BYTES = 256 * 1024 * 1024

export type TextureImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'

/** Shared by file import, project normalization, and legacy-image migration. */
export function textureAssetSizeError(bytes: number, mime: TextureImageMime): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return '素材大小无效'
  const vector = mime === 'image/svg+xml'
  const limit = vector ? MAX_TEXTURE_SVG_ASSET_BYTES : MAX_TEXTURE_ASSET_BYTES
  return bytes > limit ? vector ? 'SVG 文件不能超过 128 MB' : '图片不能超过 16 MB' : null
}
export type TextureImageFit = 'cover' | 'contain' | 'stretch'
export type TexturePanelOrder = 'row-major' | 'column-major' | 'manual'
export type TextureSequenceOverflow = 'cycle' | 'once' | 'ping-pong'

export interface TextureCompositionAsset {
  id: string
  name: string
  mime: TextureImageMime
  dataUrl: string
  width: number
  height: number
  aspect: number
  /** 内容或导入修订签名，用于合成缓存失效。 */
  revision: string
}

export interface TextureCompositionCrop {
  /** 原图归一化裁剪框，原点在左上角。 */
  x: number
  y: number
  width: number
  height: number
}

export interface TextureCompositionTransform {
  /** 目标坐标系中的中心与尺寸，单位均为 mm。 */
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
  rotationDeg: number
  flipX: boolean
  flipY: boolean
}

export interface TextureFreePlacement {
  mode: 'free'
  /** Whole-board shortcut follows the board bounds until the user moves or resizes it. */
  autoFit?: boolean
  transform: TextureCompositionTransform
  fit: TextureImageFit
  crop: TextureCompositionCrop
}

export interface TextureRepeatPlacement {
  mode: 'repeat'
  /** Legacy tiling rotated the grid together with each image. */
  gridRotationDeg?: number
  transform: TextureCompositionTransform
  fit: TextureImageFit
  crop: TextureCompositionCrop
  repeat: {
    kind: 'grid' | 'brick'
    gapXmm: number
    gapYmm: number
    alternateFlipX: boolean
    alternateFlipY: boolean
  }
}

export interface TexturePerPanelPlacement {
  mode: 'per-panel'
  panelIds: string[] | 'all'
  fit: TextureImageFit
  crop: TextureCompositionCrop
  insetMm: number
  rotationDeg: number
  flipX: boolean
  flipY: boolean
}

export type TextureImagePlacement = TextureFreePlacement | TextureRepeatPlacement | TexturePerPanelPlacement

interface TextureLayerBase {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
}

export interface TextureCompositionImageLayer extends TextureLayerBase {
  kind: 'image'
  assetId: string
  placement: TextureImagePlacement
}

export interface TextureCompositionPanelSequenceLayer extends TextureLayerBase {
  kind: 'panel-sequence'
  assetIds: string[]
  panelIds: string[] | 'all'
  order: TexturePanelOrder
  manualOrder?: string[]
  /** 显式板件→图片映射；未指定的板继续按序列与 overflow 自动分配。 */
  panelAssetMap?: Record<string, string>
  /** Preserve the original layers and visibility when temporarily assigning images by panel. */
  restoreVisibility?: Record<string, boolean>
  overflow: TextureSequenceOverflow
  fit: TextureImageFit
  crop: TextureCompositionCrop
  insetMm: number
  rotationDeg: number
  flipX: boolean
  flipY: boolean
}

export interface TextureCompositionPresetLayer extends TextureLayerBase {
  kind: 'preset'
  presetId: string
  placement: TextureImagePlacement
}
export interface TextureCompositionPatternLayer extends TextureLayerBase {
  kind: 'pattern'
  pattern: TexturePatternConfig
  placement: TextureImagePlacement
}
export type TextureCompositionPlacedLayer = TextureCompositionImageLayer | TextureCompositionPresetLayer | TextureCompositionPatternLayer
export type TextureCompositionLayer = TextureCompositionPlacedLayer | TextureCompositionPanelSequenceLayer

export interface TextureComposition {
  schemaVersion: typeof TEXTURE_COMPOSITION_SCHEMA_VERSION
  assets: TextureCompositionAsset[]
  layers: TextureCompositionLayer[]
}

/** SplitPanel 的最小结构，避免把纯模块绑定到分割引擎。 */
export interface TextureTargetPanel {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface TextureCompositionBounds {
  minX: number
  minY: number
  width: number
  height: number
}

export interface ResolvedTexturePlacement {
  layerId: string
  assetId: string
  /** null 表示整板全局坐标；字符串表示必须裁剪在该板件内。 */
  panelId: string | null
  transform: TextureCompositionTransform
  fit: TextureImageFit
  crop: TextureCompositionCrop
}

export interface TexturePanelSequenceAssignment {
  layerId: string
  panelId: string
  assetId: string
  sequenceIndex: number
}

export interface LegacySingleTextureInput {
  imageDataUrl?: unknown
  imageName?: unknown
  imageAspect?: unknown
  fit?: unknown
  scale?: unknown
  offsetX?: unknown
  offsetY?: unknown
  rotation?: unknown
  opacity?: unknown
}

const MIME_TYPES: TextureImageMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
const DEFAULT_BOUNDS: TextureCompositionBounds = { minX: 0, minY: 0, width: 1, height: 1 }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const cleanText = (value: unknown, fallback: string, max = 200): string => {
  if (typeof value !== 'string') return fallback
  const text = value.trim().slice(0, max)
  return text || fallback
}

const normalizeAngle = (value: unknown): number => {
  const angle = finite(value, 0)
  return ((angle + 180) % 360 + 360) % 360 - 180
}

const normalizeId = (value: unknown, fallback: string): string => {
  const raw = cleanText(value, fallback, 100)
  const safe = raw.replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || fallback
}

const uniqueId = (candidate: string, used: Set<string>): string => {
  let id = candidate
  let suffix = 2
  while (used.has(id)) id = `${candidate}-${suffix++}`
  used.add(id)
  return id
}

const uniqueStrings = (value: unknown, max = 256): string[] => {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const used = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim().slice(0, 100)
    if (!id || used.has(id)) continue
    used.add(id)
    result.push(id)
    if (result.length >= max) break
  }
  return result
}

const mimeFromDataUrl = (source: string): TextureImageMime | null => {
  const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml))(?:;[^,]*)?,/i.exec(source)
  if (!match) return null
  const mime = match[1].toLowerCase() as TextureImageMime
  return MIME_TYPES.includes(mime) ? mime : null
}

export const estimatedTextureDataUrlBytes = (source: string): number => {
  const comma = source.indexOf(',')
  if (comma < 0) return Infinity
  const header = source.slice(0, comma)
  const payloadLength = source.length - comma - 1
  if (/;base64/i.test(header)) {
    const padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0
    return Math.max(0, Math.ceil(payloadLength * 3 / 4) - padding)
  }
  try { return new TextEncoder().encode(decodeURIComponent(source.slice(comma + 1))).byteLength }
  catch { return Infinity }
}

/** 同步、确定性的 FNV-1a；用于迁移 ID/缓存签名，不作为安全哈希。 */
export function textureCompositionSignature(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export const createDefaultTextureCrop = (): TextureCompositionCrop => ({ x: 0, y: 0, width: 1, height: 1 })

export const createDefaultTextureComposition = (): TextureComposition => ({
  schemaVersion: TEXTURE_COMPOSITION_SCHEMA_VERSION,
  assets: [],
  layers: [],
})

function normalizeCrop(value: unknown): TextureCompositionCrop {
  if (!isRecord(value)) return createDefaultTextureCrop()
  const x = clamp(finite(value.x, 0), 0, 0.999)
  const y = clamp(finite(value.y, 0), 0, 0.999)
  return {
    x,
    y,
    width: clamp(finite(value.width, 1), 0.001, 1 - x),
    height: clamp(finite(value.height, 1), 0.001, 1 - y),
  }
}

function normalizeTransform(value: unknown): TextureCompositionTransform {
  const input = isRecord(value) ? value : {}
  return {
    xMm: clamp(finite(input.xMm, 0.5), -1_000_000, 1_000_000),
    yMm: clamp(finite(input.yMm, 0.5), -1_000_000, 1_000_000),
    widthMm: clamp(finite(input.widthMm, 1), 0.01, 1_000_000),
    heightMm: clamp(finite(input.heightMm, 1), 0.01, 1_000_000),
    rotationDeg: normalizeAngle(input.rotationDeg),
    flipX: input.flipX === true,
    flipY: input.flipY === true,
  }
}

const normalizeFit = (value: unknown): TextureImageFit =>
  value === 'contain' || value === 'stretch' ? value : 'cover'

const normalizePanelIds = (value: unknown): string[] | 'all' =>
  value === 'all' ? 'all' : uniqueStrings(value)

function normalizePlacement(value: unknown): TextureImagePlacement {
  const input = isRecord(value) ? value : {}
  const mode = input.mode
  if (mode === 'per-panel') {
    return {
      mode,
      panelIds: normalizePanelIds(input.panelIds),
      fit: normalizeFit(input.fit),
      crop: normalizeCrop(input.crop),
      insetMm: clamp(finite(input.insetMm, 0), 0, 100_000),
      rotationDeg: normalizeAngle(input.rotationDeg),
      flipX: input.flipX === true,
      flipY: input.flipY === true,
    }
  }
  if (mode === 'repeat') {
    const repeat = isRecord(input.repeat) ? input.repeat : {}
    return {
      mode,
      ...(isFinite(Number(input.gridRotationDeg)) && input.gridRotationDeg !== undefined ? { gridRotationDeg: normalizeAngle(input.gridRotationDeg) } : {}),
      transform: normalizeTransform(input.transform),
      fit: normalizeFit(input.fit),
      crop: normalizeCrop(input.crop),
      repeat: {
        kind: repeat.kind === 'brick' ? 'brick' : 'grid',
        gapXmm: clamp(finite(repeat.gapXmm, 0), 0, 1_000_000),
        gapYmm: clamp(finite(repeat.gapYmm, 0), 0, 1_000_000),
        alternateFlipX: repeat.alternateFlipX === true,
        alternateFlipY: repeat.alternateFlipY === true,
      },
    }
  }
  return {
    mode: 'free',
    ...(input.autoFit === true ? { autoFit: true } : {}),
    transform: normalizeTransform(input.transform),
    fit: normalizeFit(input.fit),
    crop: normalizeCrop(input.crop),
  }
}

function normalizeLayerBase(value: Record<string, unknown>, fallbackId: string, used: Set<string>) {
  const id = uniqueId(normalizeId(value.id, fallbackId), used)
  return {
    id,
    name: cleanText(value.name, `图片图层 ${used.size}`, 200),
    visible: value.visible !== false,
    locked: value.locked === true,
    opacity: clamp(finite(value.opacity, 1), 0, 1),
  }
}

/**
 * 严格读取不可信工程数据。无效资源/悬空图层会被丢弃；顺序保持不变。
 */
export function normalizeTextureComposition(value: unknown): TextureComposition {
  const result = createDefaultTextureComposition()
  if (!isRecord(value) || (value.schemaVersion !== undefined && value.schemaVersion !== TEXTURE_COMPOSITION_SCHEMA_VERSION)) return result

  const usedAssetIds = new Set<string>()
  let imageBytes = 0, svgBytes = 0
  if (Array.isArray(value.assets)) for (const [index, item] of value.assets.slice(0, MAX_TEXTURE_ASSETS).entries()) {
    if (!isRecord(item) || typeof item.dataUrl !== 'string') continue
    const mime = mimeFromDataUrl(item.dataUrl)
    const bytes = estimatedTextureDataUrlBytes(item.dataUrl)
    if (!mime || textureAssetSizeError(bytes, mime)) continue
    const vector = mime === 'image/svg+xml'
    if (vector ? svgBytes + bytes > MAX_TEXTURE_SVG_TOTAL_BYTES : imageBytes + bytes > MAX_TEXTURE_TOTAL_BYTES) continue
    const id = uniqueId(normalizeId(item.id, `texture-asset-${index + 1}`), usedAssetIds)
    const width = clamp(Math.round(finite(item.width, 0)), 0, 32_768)
    const height = clamp(Math.round(finite(item.height, 0)), 0, 32_768)
    const inferredAspect = width > 0 && height > 0 ? width / height : 1
    result.assets.push({
      id,
      name: cleanText(item.name, `图片 ${index + 1}`, 200),
      mime,
      dataUrl: item.dataUrl,
      width,
      height,
      aspect: clamp(finite(item.aspect, inferredAspect), 0.01, 100),
      revision: cleanText(item.revision, typeof item.revision === 'string' && item.revision.trim() ? '' : textureCompositionSignature(item.dataUrl), 128),
    })
    if (vector) svgBytes += bytes
    else imageBytes += bytes
  }

  const assetIds = new Set(result.assets.map(asset => asset.id))
  const usedLayerIds = new Set<string>()
  if (!Array.isArray(value.layers)) return result
  for (const [index, item] of value.layers.entries()) {
    if (result.layers.length >= MAX_TEXTURE_LAYERS) break
    if (!isRecord(item)) continue
    const base = normalizeLayerBase(item, `texture-layer-${index + 1}`, usedLayerIds)
    if (item.kind === 'panel-sequence') {
      const sequenceAssetIds = uniqueStrings(item.assetIds).filter(id => assetIds.has(id))
      if (!sequenceAssetIds.length) continue
      const order: TexturePanelOrder = item.order === 'column-major' || item.order === 'manual' ? item.order : 'row-major'
      const overflow: TextureSequenceOverflow = item.overflow === 'once' || item.overflow === 'ping-pong' ? item.overflow : 'cycle'
      const panelAssetMap = isRecord(item.panelAssetMap)
        ? Object.fromEntries(Object.entries(item.panelAssetMap).flatMap(([panelId, assetId]) => {
            const cleanPanelId = panelId.trim().slice(0, 100)
            return cleanPanelId && typeof assetId === 'string' && sequenceAssetIds.includes(assetId)
              ? [[cleanPanelId, assetId]]
              : []
          }).slice(0, 256))
        : undefined
      result.layers.push({
        ...base,
        kind: 'panel-sequence',
        assetIds: sequenceAssetIds,
        panelIds: normalizePanelIds(item.panelIds),
        order,
        manualOrder: order === 'manual' ? uniqueStrings(item.manualOrder) : undefined,
        ...(panelAssetMap && Object.keys(panelAssetMap).length ? { panelAssetMap } : {}),
        ...(isRecord(item.restoreVisibility) ? { restoreVisibility: Object.fromEntries(Object.entries(item.restoreVisibility)
          .filter(([id, visible]) => id.length <= 100 && typeof visible === 'boolean').slice(0, MAX_TEXTURE_LAYERS)) as Record<string, boolean> } : {}),
        overflow,
        fit: normalizeFit(item.fit),
        crop: normalizeCrop(item.crop),
        insetMm: clamp(finite(item.insetMm, 0), 0, 100_000),
        rotationDeg: normalizeAngle(item.rotationDeg),
        flipX: item.flipX === true,
        flipY: item.flipY === true,
      })
      continue
    }
    if (item.kind === 'preset' && typeof item.presetId === 'string') {
      result.layers.push({ ...base, kind: 'preset', presetId: item.presetId.slice(0, 80), placement: normalizePlacement(item.placement) })
      continue
    }
    if (item.kind === 'pattern') {
      result.layers.push({ ...base, kind: 'pattern', pattern: normalizeTexturePattern(isRecord(item.pattern) ? item.pattern : {}), placement: normalizePlacement(item.placement) })
      continue
    }
    if (item.kind !== 'image' || typeof item.assetId !== 'string' || !assetIds.has(item.assetId)) continue
    result.layers.push({ ...base, kind: 'image', assetId: item.assetId, placement: normalizePlacement(item.placement) })
  }
  return result
}

const normalizedBounds = (value?: Partial<TextureCompositionBounds>): TextureCompositionBounds => ({
  minX: finite(value?.minX, DEFAULT_BOUNDS.minX),
  minY: finite(value?.minY, DEFAULT_BOUNDS.minY),
  width: Math.max(0.01, finite(value?.width, DEFAULT_BOUNDS.width)),
  height: Math.max(0.01, finite(value?.height, DEFAULT_BOUNDS.height)),
})

/** 把旧 imageDataUrl + 全局 transform 变成一个资源和一个图层。 */
export function migrateLegacySingleImageTexture(
  value: LegacySingleTextureInput,
  targetBounds?: Partial<TextureCompositionBounds>,
): TextureComposition {
  const result = createDefaultTextureComposition()
  if (typeof value.imageDataUrl !== 'string') return result
  const mime = mimeFromDataUrl(value.imageDataUrl)
  const bytes = estimatedTextureDataUrlBytes(value.imageDataUrl)
  if (!mime || textureAssetSizeError(bytes, mime)) return result
  const bounds = normalizedBounds(targetBounds)
  const aspect = clamp(finite(value.imageAspect, bounds.width / bounds.height), 0.01, 100)
  const signature = textureCompositionSignature(value.imageDataUrl)
  const assetId = `legacy-asset-${signature}`
  const name = cleanText(value.imageName, '导入图片', 200)
  result.assets.push({ id: assetId, name, mime, dataUrl: value.imageDataUrl, width: 0, height: 0, aspect, revision: signature })

  const scale = clamp(finite(value.scale, 100), 10, 400) / 100
  const offsetX = clamp(finite(value.offsetX, 0), -100, 100) / 100 * bounds.width
  const offsetY = clamp(finite(value.offsetY, 0), -100, 100) / 100 * bounds.height
  const transform: TextureCompositionTransform = {
    xMm: bounds.minX + bounds.width / 2 + offsetX,
    yMm: bounds.minY + bounds.height / 2 + offsetY,
    widthMm: bounds.width * scale,
    heightMm: bounds.height * scale,
    rotationDeg: normalizeAngle(value.rotation),
    flipX: false,
    flipY: false,
  }
  const common = {
    id: 'legacy-image-layer',
    kind: 'image' as const,
    name,
    assetId,
    visible: true,
    locked: false,
    opacity: clamp(finite(value.opacity, 1), 0, 1),
  }
  if (value.fit === 'tile') {
    result.layers.push({
      ...common,
      placement: {
        mode: 'repeat', transform: { ...transform, widthMm: bounds.width * 0.34 * scale, heightMm: bounds.width * 0.34 / aspect * scale },
        fit: 'stretch', crop: createDefaultTextureCrop(),
        repeat: { kind: 'grid', gapXmm: 0, gapYmm: 0, alternateFlipX: false, alternateFlipY: false },
      },
    })
  } else {
    result.layers.push({
      ...common,
      placement: {
        mode: 'free', transform,
        fit: normalizeFit(value.fit), crop: createDefaultTextureCrop(),
      },
    })
  }
  return result
}

const selectedPanels = (selection: string[] | 'all', panels: TextureTargetPanel[]): TextureTargetPanel[] => {
  if (selection === 'all') return [...panels]
  const ids = new Set(selection)
  return panels.filter(panel => ids.has(panel.id))
}

/** 每板模式的目标框。结果沿输入 panels 顺序返回。 */
export function resolvePerPanelPlacements(
  layerId: string,
  assetId: string,
  placement: TexturePerPanelPlacement,
  panels: TextureTargetPanel[],
): ResolvedTexturePlacement[] {
  return selectedPanels(placement.panelIds, panels).map(panel => {
    const maxInset = Math.max(0, Math.min(panel.w, panel.h) / 2 - 0.005)
    const inset = Math.min(placement.insetMm, maxInset)
    return {
      layerId,
      assetId,
      panelId: panel.id,
      transform: {
        xMm: panel.x + panel.w / 2,
        yMm: panel.y + panel.h / 2,
        widthMm: Math.max(0.01, panel.w - inset * 2),
        heightMm: Math.max(0.01, panel.h - inset * 2),
        rotationDeg: placement.rotationDeg,
        flipX: placement.flipX,
        flipY: placement.flipY,
      },
      fit: placement.fit,
      crop: placement.crop,
    }
  })
}

/**
 * 解析足以覆盖整板 bounds 的矩形或错列实例。transform.x/y 是阵列原点单元中心。
 */
export function resolveRepeatPlacements(
  layerId: string,
  assetId: string,
  placement: TextureRepeatPlacement,
  inputBounds: TextureCompositionBounds,
): ResolvedTexturePlacement[] {
  let bounds = normalizedBounds(inputBounds)
  const radians = (placement.gridRotationDeg ?? 0) * Math.PI / 180
  const co = Math.cos(radians), si = Math.sin(radians), origin = placement.transform
  if (radians) {
    const corners = [[bounds.minX, bounds.minY], [bounds.minX + bounds.width, bounds.minY],
      [bounds.minX + bounds.width, bounds.minY + bounds.height], [bounds.minX, bounds.minY + bounds.height]]
      .map(([x, y]) => ({ x: origin.xMm + (x - origin.xMm) * co + (y - origin.yMm) * si,
        y: origin.yMm - (x - origin.xMm) * si + (y - origin.yMm) * co }))
    const minX = Math.min(...corners.map(p => p.x)), minY = Math.min(...corners.map(p => p.y))
    bounds = { minX, minY, width: Math.max(...corners.map(p => p.x)) - minX, height: Math.max(...corners.map(p => p.y)) - minY }
  }
  const cellWidth = Math.max(0.01, placement.transform.widthMm)
  const cellHeight = Math.max(0.01, placement.transform.heightMm)
  const stepX = Math.max(0.01, cellWidth + placement.repeat.gapXmm)
  const stepY = Math.max(0.01, cellHeight + placement.repeat.gapYmm)
  const minRow = Math.floor((bounds.minY - cellHeight / 2 - placement.transform.yMm) / stepY) - 1
  const maxRow = Math.ceil((bounds.minY + bounds.height + cellHeight / 2 - placement.transform.yMm) / stepY) + 1
  const result: ResolvedTexturePlacement[] = []
  for (let row = minRow; row <= maxRow; row++) {
    const brickOffset = placement.repeat.kind === 'brick' && Math.abs(row % 2) === 1 ? stepX / 2 : 0
    const minColumn = Math.floor((bounds.minX - cellWidth / 2 - placement.transform.xMm - brickOffset) / stepX) - 1
    const maxColumn = Math.ceil((bounds.minX + bounds.width + cellWidth / 2 - placement.transform.xMm - brickOffset) / stepX) + 1
    for (let column = minColumn; column <= maxColumn; column++) {
      result.push({
        layerId,
        assetId,
        panelId: null,
        transform: {
          ...placement.transform,
          xMm: placement.transform.xMm + (column * stepX + brickOffset) * co - row * stepY * si,
          yMm: placement.transform.yMm + (column * stepX + brickOffset) * si + row * stepY * co,
          flipX: placement.transform.flipX !== (placement.repeat.alternateFlipX && Math.abs(column % 2) === 1),
          flipY: placement.transform.flipY !== (placement.repeat.alternateFlipY && Math.abs(row % 2) === 1),
        },
        fit: placement.fit,
        crop: placement.crop,
      })
    }
  }
  return result
}

function orderedPanels(layer: TextureCompositionPanelSequenceLayer, panels: TextureTargetPanel[]): TextureTargetPanel[] {
  const targets = selectedPanels(layer.panelIds, panels)
  if (layer.order === 'manual') {
    const byId = new Map(targets.map(panel => [panel.id, panel]))
    const ordered = (layer.manualOrder ?? []).flatMap(id => {
      const panel = byId.get(id)
      if (!panel) return []
      byId.delete(id)
      return [panel]
    })
    return [...ordered, ...targets.filter(panel => byId.has(panel.id))]
  }
  return [...targets].sort(layer.order === 'column-major'
    ? (a, b) => a.x - b.x || b.y - a.y || a.id.localeCompare(b.id)
    : (a, b) => b.y - a.y || a.x - b.x || a.id.localeCompare(b.id))
}

const sequenceAssetIndex = (index: number, count: number, overflow: TextureSequenceOverflow): number | null => {
  if (count <= 0) return null
  if (overflow === 'once') return index < count ? index : null
  if (overflow === 'ping-pong' && count > 1) {
    const period = count * 2 - 2
    const cursor = index % period
    return cursor < count ? cursor : period - cursor
  }
  return index % count
}

/** 板件序列映射。row-major 为上→下、左→右；column-major 为左→右、上→下。 */
export function resolvePanelSequenceAssignments(
  layer: TextureCompositionPanelSequenceLayer,
  panels: TextureTargetPanel[],
): TexturePanelSequenceAssignment[] {
  return orderedPanels(layer, panels).flatMap((panel, sequenceIndex) => {
    const explicit = layer.panelAssetMap?.[panel.id]
    if (explicit && layer.assetIds.includes(explicit)) return [{ layerId: layer.id, panelId: panel.id, assetId: explicit, sequenceIndex }]
    const assetIndex = sequenceAssetIndex(sequenceIndex, layer.assetIds.length, layer.overflow)
    return assetIndex === null ? [] : [{ layerId: layer.id, panelId: panel.id, assetId: layer.assetIds[assetIndex], sequenceIndex }]
  })
}

/** 供合成器消费的统一实例解析；隐藏层返回空数组。 */
export function resolveTextureLayerPlacements(
  layer: TextureCompositionLayer,
  panels: TextureTargetPanel[],
  bounds: TextureCompositionBounds,
): ResolvedTexturePlacement[] {
  if (!layer.visible) return []
  if (layer.kind === 'panel-sequence') {
    const panelMap = new Map(panels.map(panel => [panel.id, panel]))
    return resolvePanelSequenceAssignments(layer, panels).flatMap(assignment => {
      const panel = panelMap.get(assignment.panelId)
      if (!panel) return []
      const maxInset = Math.max(0, Math.min(panel.w, panel.h) / 2 - 0.005)
      const inset = Math.min(layer.insetMm, maxInset)
      return [{
        layerId: layer.id,
        assetId: assignment.assetId,
        panelId: panel.id,
        transform: {
          xMm: panel.x + panel.w / 2,
          yMm: panel.y + panel.h / 2,
          widthMm: Math.max(0.01, panel.w - inset * 2),
          heightMm: Math.max(0.01, panel.h - inset * 2),
          rotationDeg: layer.rotationDeg,
          flipX: layer.flipX,
          flipY: layer.flipY,
        },
        fit: layer.fit,
        crop: layer.crop,
      }]
    })
  }
  const assetId = layer.kind === 'image' ? layer.assetId : layer.id
  if (layer.placement.mode === 'per-panel') return resolvePerPanelPlacements(layer.id, assetId, layer.placement, panels)
  if (layer.placement.mode === 'repeat') return resolveRepeatPlacements(layer.id, assetId, layer.placement, bounds)
  return [{
    layerId: layer.id,
    assetId,
    panelId: null,
    transform: layer.placement.autoFit ? { ...layer.placement.transform, xMm: bounds.minX + bounds.width / 2,
      yMm: bounds.minY + bounds.height / 2, widthMm: bounds.width, heightMm: bounds.height } : layer.placement.transform,
    fit: layer.placement.fit,
    crop: layer.placement.crop,
  }]
}

export function distributeTextureImages(composition: TextureComposition, panels: TextureTargetPanel[], id: string): TextureComposition {
  if (!composition.assets.length || composition.layers.some(layer => layer.kind === 'panel-sequence')) return composition
  const sequence: TextureCompositionPanelSequenceLayer = { id, kind: 'panel-sequence', name: '每板图片分配',
    visible: true, locked: false, opacity: 1, assetIds: composition.assets.map(asset => asset.id), panelIds: 'all',
    order: 'row-major', overflow: 'cycle', fit: 'cover', crop: createDefaultTextureCrop(), insetMm: 0,
    rotationDeg: 0, flipX: false, flipY: false,
    panelAssetMap: Object.fromEntries(panels.map((panel, index) => [panel.id, composition.assets[index % composition.assets.length].id])),
    restoreVisibility: Object.fromEntries(composition.layers.map(layer => [layer.id, layer.visible])) }
  return { ...composition, layers: [...composition.layers.map(layer => ({ ...layer, visible: false })), sequence] }
}

export function restoreTextureLayers(composition: TextureComposition, id: string): TextureComposition {
  const sequence = composition.layers.find(layer => layer.id === id && layer.kind === 'panel-sequence')
  if (sequence?.kind !== 'panel-sequence' || !sequence.restoreVisibility) return composition
  return { ...composition, layers: composition.layers.filter(layer => layer.id !== id).map(layer => ({ ...layer,
    visible: sequence.restoreVisibility![layer.id] ?? layer.visible })) }
}
