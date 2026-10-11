import * as THREE from 'three'
import { DEFAULT_WOOD_GRAIN, drawWoodGrainPreview, normalizeWoodGrain, normalizeWoodGrainTexture } from './woodGrain'
import { cleanTextureColorIslands } from './textureColorCleanup'
import { continuousTextureRecipes } from './texturePaletteContinuity'
import { buildTextureVectorRegions } from './textureVectorRegions'
import type { BoardTextureAvoidZone, BoardTextureConfig, SplitPanel } from '../types/geometry'
import { loadSnapColorLut, matchSnapColor, snapColorMeasuredColor, type SnapColorRgb } from './snapColorLut'
import {
  createDefaultTextureComposition,
  migrateLegacySingleImageTexture,
  normalizeTextureComposition,
  resolveTextureLayerPlacements,
  textureCompositionSignature,
  type ResolvedTexturePlacement,
  type TextureComposition,
  type TextureCompositionAsset,
  type TextureCompositionPlacedLayer,
} from './textureComposition'
import { createDefaultTexturePattern, normalizeTexturePattern, renderTexturePatternToContext } from './texturePatterns'
import { assemblyMarkCavityPolygons, buildSurfaceMarkingPlan, type AssemblyMarkingConfig } from './assemblyMarking'
import type { SplitConfig } from '../types/geometry'

export interface TexturePreset {
  id: string
  name: string
  description: string
  preview: string
  colors: string[]
}

export const BOARD_TEXTURE_PRESETS: TexturePreset[] = [
  {
    id: 'mono-checker', name: '黑白棋盘', description: '高对比像素马赛克',
    preview: 'conic-gradient(#f3f1e9 25%,#15171c 0 50%,#f3f1e9 0 75%,#15171c 0) 0/26px 26px',
    colors: ['#f3f1e9', '#15171c'],
  },
  {
    id: 'jade-terrazzo', name: '青金碎瓷', description: '低饱和矿石颗粒',
    preview: 'radial-gradient(circle at 20% 30%,#e8d9a9 0 5%,transparent 6%),radial-gradient(circle at 72% 65%,#123f4a 0 7%,transparent 8%),radial-gradient(circle at 58% 18%,#77b8a6 0 4%,transparent 5%),#194e57',
    colors: ['#194e57', '#77b8a6', '#e8d9a9', '#123f4a'],
  },
  {
    id: 'sunset-wave', name: '夕照波纹', description: '暖色渐变与层叠曲线',
    preview: 'repeating-radial-gradient(ellipse at 20% 110%,transparent 0 11px,rgba(255,255,255,.42) 12px 14px),linear-gradient(145deg,#3d2a68,#d94f70 48%,#f3ad68)',
    colors: ['#3d2a68', '#d94f70', '#f3ad68', '#ffe3a8'],
  },
  {
    id: 'carbon-night', name: '深海碳纤', description: '细密斜纹，适合工具墙',
    preview: 'repeating-linear-gradient(45deg,#111824 0 8px,#20324b 8px 16px,#0c111a 16px 24px)',
    colors: ['#0c111a', '#111824', '#20324b', '#42678b'],
  },
  {
    id: 'mint-confetti', name: '薄荷纸屑', description: '柔和底色与彩色短片',
    preview: 'radial-gradient(ellipse at 18% 20%,#ffba69 0 5%,transparent 6%),radial-gradient(ellipse at 72% 62%,#6aaee8 0 5%,transparent 6%),radial-gradient(ellipse at 45% 82%,#e77c9d 0 5%,transparent 6%),#d8efe4',
    colors: ['#d8efe4', '#ffba69', '#6aaee8', '#e77c9d'],
  },
  {
    id: 'neon-grid', name: '霓虹矩阵', description: '深色底上的彩色方格',
    preview: 'linear-gradient(90deg,rgba(0,229,255,.48) 1px,transparent 1px),linear-gradient(rgba(238,82,255,.45) 1px,transparent 1px),linear-gradient(135deg,#101226,#26194a)',
    colors: ['#101226', '#00e5ff', '#ee52ff', '#6bffb8'],
  },
]

export function createDefaultBoardTexture(): BoardTextureConfig {
  return {
    enabled: false,
    source: 'composition',
    presetId: BOARD_TEXTURE_PRESETS[0].id,
    backEnabled: false,
    backFit: 'cover', backScale: 100, backOffsetX: 0, backOffsetY: 0, backRotation: 0,
    composition: createDefaultTextureComposition(),
    pattern: createDefaultTexturePattern('square'),
    avoidZones: [],
    fit: 'cover',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    opacity: 1,
    brightness: 1,
    contrast: 1,
    saturation: 1,
    colorMode: 'original',
    colorCount: 4,
    modelingMode: 'high-fidelity',
    manufacturingContours: true,
    manufacturingEdgeQuality: 'standard',
    lutId: 'snapcolor-petg-rybw',
    quantizeColors: 48,
    hueWeight: 0.35,
    cleanup: true,
    textureThickness: 1,
    edgeSealEnabled: true,
    edgeSealWidth: 0.5,
    pixelSize: 1.2,
    samplingDetail: 1,
    manufacturingOutput: 'single',
    surfaceMode: 'snapcolor',
    woodGrain: { ...DEFAULT_WOOD_GRAIN },
    baseMaterialName: '普通白色 PETG',
    surfaceMaterialName: '浅绿色 PETG 大理石',
    surfaceMaterialKind: 'decorative-petg',
    surfacePrintGoal: 'standard',
    surfaceProfileVersion: 1,
    surfaceFilamentVendor: '',
    surfacePrintOverrides: {},
    baseColor: '#F3F3EE',
    surfaceColor: '#A8CDBA',
    surfaceFinish: 'textured-pei',
    baseInfillDensity: 10,
  }
}

// Both faces share the physical print settings; images, placement and colour adjustments stay independent.
const sharedFaceFields = ['enabled', 'surfaceMode', 'textureThickness', 'lutId', 'baseColor', 'baseMaterialName',
  'baseInfillDensity', 'surfaceFinish', 'manufacturingOutput', 'samplingDetail', 'manufacturingContours',
  'manufacturingEdgeQuality', 'edgeSealEnabled', 'edgeSealWidth'] as const

export function boardTextureForSide(config: BoardTextureConfig, side: 'front' | 'back'): BoardTextureConfig {
  if (side === 'front') return config
  const back: BoardTextureConfig = config.backTexture ? { ...config.backTexture } : {
    ...createDefaultBoardTexture(), source: 'image', imageDataUrl: config.backImageDataUrl,
    imageName: config.backImageName, imageAspect: config.backImageAspect,
    fit: config.backFit ?? 'cover', scale: config.backScale ?? 100,
    offsetX: config.backOffsetX ?? 0, offsetY: config.backOffsetY ?? 0, rotation: config.backRotation ?? 0,
  }
  Object.assign(back, Object.fromEntries(sharedFaceFields.map(key => [key, config[key]])))
  back.backEnabled = false
  back.backTexture = undefined
  return back
}

export function boardTextureSidePatch(config: BoardTextureConfig, side: 'front' | 'back', partial: Partial<BoardTextureConfig>): Partial<BoardTextureConfig> {
  // Clearing the last layer on one face must not disable the other face.
  if (config.backEnabled && partial.enabled === false) {
    const { enabled: _enabled, ...appearance } = partial
    partial = appearance
  }
  if (side === 'front') return partial
  const shared = Object.fromEntries(sharedFaceFields.filter(key => key in partial).map(key => [key, partial[key]]))
  return { ...shared, backTexture: { ...boardTextureForSide(config, 'back'), ...partial, backEnabled: false, backTexture: undefined } }
}

export function hasBoardTextureSource(config: BoardTextureConfig): boolean {
  if (config.surfaceMode === 'woodgrain') return true
  if (config.surfaceMode === 'veneer') return true
  return config.source === 'image' ? Boolean(config.imageDataUrl)
    : config.source === 'composition' ? config.composition.layers.some(layer => layer.visible)
    : true
}

export function backBoardTexture(config: BoardTextureConfig): BoardTextureConfig | null {
  const back = boardTextureForSide(config, 'back')
  return config.backEnabled && hasBoardTextureSource(back) ? back : null
}

/** Explicitly reserved back marks erase artwork only inside their own safe placement boxes. */
export function backTextureForRendering(config: BoardTextureConfig, panels: SplitPanel[], cfg: SplitConfig,
  marking: AssemblyMarkingConfig, projectName?: string): BoardTextureConfig | null {
  const back = backBoardTexture(config)
  if (!back || !marking.reserveBackMarking) return back
  const plan = buildSurfaceMarkingPlan(panels, cfg, marking, config, projectName)
  const bounds = getSplitPanelTextureBounds(panels)
  const zones = plan.panels.flatMap(panel => assemblyMarkCavityPolygons(panel).map((ring, index) => {
    const x0 = Math.min(...ring.map(p => p.x)), x1 = Math.max(...ring.map(p => p.x))
    const y0 = Math.min(...ring.map(p => p.y)), y1 = Math.max(...ring.map(p => p.y))
    return { id: `mark-${panel.panelId}-${index}`, name: '背面标识留白', enabled: true,
      x: (bounds.maxX - x1) / bounds.width, y: (y0 - bounds.minY) / bounds.height,
      width: (x1 - x0) / bounds.width, height: (y1 - y0) / bounds.height }
  }))
  return { ...back, avoidZones: [...back.avoidZones, ...zones] }
}

/** The back editor's X increases to the right when looking at the back, across the whole assembly. */
export function texturePanelsForSide(panels: SplitPanel[], side: 'front' | 'back'): SplitPanel[] {
  if (side === 'front' || !panels.length) return panels
  const { minX, maxX } = getSplitPanelTextureBounds(panels)
  return panels.map(panel => ({ ...panel, x: minX + maxX - panel.x - panel.w,
    contour: panel.contour?.map(point => ({ ...point, x: minX + maxX - point.x })).reverse() }))
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Old sources use a layer editor adapter; their saved renderer stays unchanged until edited. */
export function editableTextureComposition(config: BoardTextureConfig, panels: SplitPanel[]): TextureComposition {
  if (config.source === 'composition') {
    const bounds = getSplitPanelTextureBounds(panels)
    const composition = normalizeTextureComposition(config.composition)
    composition.layers = composition.layers.map(layer => layer.kind !== 'panel-sequence' && layer.placement.mode === 'free' && layer.placement.autoFit
      ? { ...layer, placement: { ...layer.placement, transform: { ...layer.placement.transform,
        xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2, widthMm: bounds.width, heightMm: bounds.height } } } : layer)
    return config.opacity === 1 ? composition : { ...composition, layers: composition.layers.map(layer => ({ ...layer, opacity: layer.opacity * config.opacity })) }
  }
  const bounds = getSplitPanelTextureBounds(panels)
  if (config.source === 'image') {
    const composition = migrateLegacySingleImageTexture(config, bounds)
    const layer = composition.layers[0]
    if (layer?.kind === 'image' && layer.placement.mode === 'free') {
      const aspect = config.imageAspect ?? bounds.width / bounds.height
      const transform = layer.placement.transform
      if (config.fit !== 'stretch') {
        const useWidth = config.fit === 'cover' ? aspect < bounds.width / bounds.height : aspect > bounds.width / bounds.height
        if (useWidth) transform.heightMm = transform.widthMm / aspect
        else transform.widthMm = transform.heightMm * aspect
      }
      layer.placement.fit = 'stretch'
    }
    if (layer?.kind === 'image' && layer.placement.mode !== 'per-panel') layer.placement.transform.rotationDeg = -config.rotation
    if (layer?.kind === 'image' && layer.placement.mode === 'repeat') {
      const t = layer.placement.transform, angle = -config.rotation * Math.PI / 180
      layer.placement.gridRotationDeg = -config.rotation
      t.xMm += Math.cos(angle) * t.widthMm / 2 + Math.sin(angle) * t.heightMm / 2
      t.yMm += Math.sin(angle) * t.widthMm / 2 - Math.cos(angle) * t.heightMm / 2
    }
    return composition
  }
  const placement = { mode: 'free' as const, fit: 'stretch' as const, crop: { x: 0, y: 0, width: 1, height: 1 },
    transform: { xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2,
      widthMm: bounds.width, heightMm: bounds.height, rotationDeg: 0, flipX: false, flipY: false } }
  const layer: TextureCompositionPlacedLayer = config.source === 'pattern'
    ? { id: 'legacy-pattern', kind: 'pattern', name: '数学纹样', visible: true, locked: false, opacity: 1, pattern: config.pattern, placement }
    : { id: 'legacy-preset', kind: 'preset', name: BOARD_TEXTURE_PRESETS.find(item => item.id === config.presetId)?.name ?? '内置图案',
      visible: true, locked: false, opacity: config.opacity, presetId: config.presetId, placement: { ...placement,
        transform: { ...placement.transform, xMm: placement.transform.xMm + config.offsetX / 100 * bounds.width,
          yMm: placement.transform.yMm + config.offsetY / 100 * bounds.height,
          widthMm: bounds.width * config.scale / 100, heightMm: bounds.height * config.scale / 100, rotationDeg: -config.rotation } } }
  return { schemaVersion: 1, assets: [], layers: [layer] }
}

const textureAvoidZonePixelRect = (zone: BoardTextureAvoidZone, width: number, height: number) => {
  const x0 = Math.max(0, Math.min(width, Math.floor(clamp01(zone.x) * width)))
  const x1 = Math.max(x0, Math.min(width, Math.ceil(clamp01(zone.x + zone.width) * width)))
  // 业务坐标原点在左下角，Canvas 像素原点在左上角。
  const y0 = Math.max(0, Math.min(height, Math.floor((1 - clamp01(zone.y + zone.height)) * height)))
  const y1 = Math.max(y0, Math.min(height, Math.ceil((1 - clamp01(zone.y)) * height)))
  return { x0, x1, y0, y1 }
}

const hexRgb = (color: string): [number, number, number] => {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return [243, 243, 238]
  const value = Number.parseInt(match[1], 16)
  return [value >> 16, (value >> 8) & 255, value & 255]
}

/**
 * 纯像素内核，供浏览器 Canvas 与 node 回归测试共用。
 * 数据为标准 RGBA 行优先缓冲区；启用的避让区会被不透明基材色覆盖。
 */
export function paintTextureAvoidZonesRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  zones: BoardTextureAvoidZone[],
  baseColor: string,
): void {
  if (data.length < width * height * 4) return
  const [r, g, b] = hexRgb(baseColor)
  for (const zone of zones) {
    if (!zone.enabled) continue
    const { x0, x1, y0, y1 } = textureAvoidZonePixelRect(zone, width, height)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
}

function applyTextureAvoidZones(canvas: HTMLCanvasElement, config: BoardTextureConfig): void {
  if (!config.avoidZones.some(zone => zone.enabled)) return
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  paintTextureAvoidZonesRgba(image.data, canvas.width, canvas.height, config.avoidZones, config.baseColor)
  ctx.putImageData(image, 0, 0)
}

export function getSplitPanelTextureBounds(panels: SplitPanel[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const panel of panels) {
    const points = panel.contour?.length ? panel.contour : [
      { x: panel.x, y: panel.y },
      { x: panel.x + panel.w, y: panel.y + panel.h },
    ]
    for (const point of points) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

const textureImageCache = new Map<string, Promise<HTMLImageElement>>()
// Revisions may come from imported projects. Equal lengths/header/footer are not image identity.
const textureImageCacheKey = (source: string, _revision?: string) => source

/** 大型 SVG 只解码一次；拖动尺寸和切换图层继续复用同一个 Image。 */
const loadImage = (source: string, revision?: string): Promise<HTMLImageElement> => {
  const key = textureImageCacheKey(source, revision)
  const cached = textureImageCache.get(key)
  if (cached) return cached
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('自定义纹理图片读取失败'))
    image.src = source
  })
  textureImageCache.set(key, pending)
  void pending.catch(() => { if (textureImageCache.get(key) === pending) textureImageCache.delete(key) })
  // 避免长期编辑许多大图时无限保留解码位图；最近8项足够覆盖多图工作区。
  while (textureImageCache.size > 8) {
    const oldest = textureImageCache.keys().next().value as string | undefined
    if (!oldest || oldest === key) break
    textureImageCache.delete(oldest)
  }
  return pending
}

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function renderPreset(canvas: HTMLCanvasElement, presetId: string): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  const preset = BOARD_TEXTURE_PRESETS.find(item => item.id === presetId) ?? BOARD_TEXTURE_PRESETS[0]
  const colors = preset.colors

  if (preset.id === 'mono-checker') {
    const cell = Math.max(28, Math.round(Math.min(width, height) / 10))
    for (let y = 0; y < height; y += cell) for (let x = 0; x < width; x += cell) {
      ctx.fillStyle = colors[(Math.floor(x / cell) + Math.floor(y / cell)) % 2]
      ctx.fillRect(x, y, cell, cell)
    }
    return
  }

  if (preset.id === 'jade-terrazzo' || preset.id === 'mint-confetti') {
    ctx.fillStyle = colors[0]
    ctx.fillRect(0, 0, width, height)
    const random = pseudoRandom(preset.id === 'jade-terrazzo' ? 7201 : 4109)
    for (let i = 0; i < 170; i++) {
      const x = random() * width, y = random() * height
      const radius = (5 + random() * 22) * Math.min(width, height) / 800
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(random() * Math.PI)
      ctx.fillStyle = colors[1 + Math.floor(random() * (colors.length - 1))]
      ctx.beginPath()
      ctx.ellipse(0, 0, radius * (0.55 + random()), radius * 0.45, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    return
  }

  if (preset.id === 'sunset-wave') {
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color))
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = 'rgba(255,255,255,.46)'
    ctx.lineWidth = Math.max(2, width / 380)
    for (let band = -3; band < 18; band++) {
      ctx.beginPath()
      for (let x = -20; x <= width + 20; x += 8) {
        const y = height * 0.12 + band * height / 16 + Math.sin(x / width * Math.PI * 3 + band * 0.55) * height * 0.035
        if (x < 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    return
  }

  if (preset.id === 'carbon-night') {
    ctx.fillStyle = colors[0]
    ctx.fillRect(0, 0, width, height)
    const size = Math.max(18, Math.round(Math.min(width, height) / 28))
    ctx.lineWidth = size * 0.48
    for (let i = -height; i < width + height; i += size) {
      ctx.strokeStyle = colors[(Math.floor((i + height) / size) % 3) + 1]
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - height, height); ctx.stroke()
    }
    return
  }

  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[colors.length - 1])
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  const grid = Math.max(36, Math.round(Math.min(width, height) / 12))
  ctx.lineWidth = Math.max(2, grid / 18)
  for (let x = 0; x <= width; x += grid) {
    ctx.strokeStyle = colors[1 + Math.floor(x / grid) % (colors.length - 1)]
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
  }
  for (let y = 0; y <= height; y += grid) {
    ctx.strokeStyle = colors[1 + Math.floor(y / grid) % (colors.length - 1)]
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
  }
}

function drawSource(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  config: BoardTextureConfig,
  width: number,
  height: number,
): void {
  ctx.save()
  ctx.translate(width / 2 + config.offsetX / 100 * width, height / 2 - config.offsetY / 100 * height)
  ctx.rotate(config.rotation * Math.PI / 180)
  const userScale = Math.max(0.1, config.scale / 100)
  ctx.scale(userScale, userScale)

  if (config.fit === 'tile') {
    const tileWidth = Math.max(32, width * 0.34)
    const tileHeight = tileWidth * sourceHeight / Math.max(1, sourceWidth)
    const tile = document.createElement('canvas')
    tile.width = Math.max(1, Math.round(tileWidth))
    tile.height = Math.max(1, Math.round(tileHeight))
    tile.getContext('2d')?.drawImage(source, 0, 0, tile.width, tile.height)
    const pattern = ctx.createPattern(tile, 'repeat')
    if (pattern) {
      ctx.fillStyle = pattern
      ctx.fillRect(-width * 2, -height * 2, width * 4, height * 4)
    }
    ctx.restore()
    return
  }

  const targetAspect = width / height
  const sourceAspect = sourceWidth / Math.max(1, sourceHeight)
  let drawWidth = width, drawHeight = height
  if (config.fit !== 'stretch') {
    const useWidth = config.fit === 'cover' ? sourceAspect < targetAspect : sourceAspect > targetAspect
    if (useWidth) drawHeight = width / sourceAspect
    else drawWidth = height * sourceAspect
  }
  ctx.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.restore()
}

const textureWorldToCanvas = (
  x: number,
  y: number,
  bounds: ReturnType<typeof getSplitPanelTextureBounds>,
  width: number,
  height: number,
) => ({
  x: (x - bounds.minX) / bounds.width * width,
  y: (bounds.maxY - y) / bounds.height * height,
})

function clipTexturePanel(
  ctx: CanvasRenderingContext2D,
  panel: SplitPanel,
  bounds: ReturnType<typeof getSplitPanelTextureBounds>,
  width: number,
  height: number,
): void {
  const contour = panel.contour?.length ? panel.contour : [
    { x: panel.x, y: panel.y }, { x: panel.x + panel.w, y: panel.y },
    { x: panel.x + panel.w, y: panel.y + panel.h }, { x: panel.x, y: panel.y + panel.h },
  ]
  if (!contour.length) return
  const first = textureWorldToCanvas(contour[0].x, contour[0].y, bounds, width, height)
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let index = 1; index < contour.length; index++) {
    const point = textureWorldToCanvas(contour[index].x, contour[index].y, bounds, width, height)
    ctx.lineTo(point.x, point.y)
  }
  ctx.closePath()
  ctx.clip()
}

function drawCompositionPlacement(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLCanvasElement,
  placement: ResolvedTexturePlacement,
  opacity: number,
  bounds: ReturnType<typeof getSplitPanelTextureBounds>,
  panels: SplitPanel[],
  canvasWidth: number,
  canvasHeight: number,
): void {
  const sourceWidth = 'naturalWidth' in image ? image.naturalWidth : image.width
  const sourceHeight = 'naturalHeight' in image ? image.naturalHeight : image.height
  const transform = placement.transform
  const center = textureWorldToCanvas(transform.xMm, transform.yMm, bounds, canvasWidth, canvasHeight)
  const pxPerMmX = canvasWidth / bounds.width
  const pxPerMmY = canvasHeight / bounds.height
  const targetWidth = Math.max(1, transform.widthMm * pxPerMmX)
  const targetHeight = Math.max(1, transform.heightMm * pxPerMmY)
  const crop = placement.crop
  const sx = crop.x * sourceWidth
  const sy = crop.y * sourceHeight
  const sw = Math.max(1, crop.width * sourceWidth)
  const sh = Math.max(1, crop.height * sourceHeight)
  const sourceAspect = sw / sh
  const targetAspect = targetWidth / targetHeight
  let drawWidth = targetWidth, drawHeight = targetHeight
  if (placement.fit !== 'stretch') {
    const useWidth = placement.fit === 'cover' ? sourceAspect < targetAspect : sourceAspect > targetAspect
    if (useWidth) drawHeight = targetWidth / sourceAspect
    else drawWidth = targetHeight * sourceAspect
  }

  ctx.save()
  if (placement.panelId) {
    const panel = panels.find(item => item.id === placement.panelId)
    if (panel) clipTexturePanel(ctx, panel, bounds, canvasWidth, canvasHeight)
  }
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.translate(center.x, center.y)
  ctx.rotate(-transform.rotationDeg * Math.PI / 180)
  ctx.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1)
  ctx.beginPath()
  ctx.rect(-targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight)
  ctx.clip()
  ctx.drawImage(image, sx, sy, sw, sh, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.restore()
}

async function renderTextureComposition(
  canvas: HTMLCanvasElement,
  config: BoardTextureConfig,
  panels: SplitPanel[],
  bounds: ReturnType<typeof getSplitPanelTextureBounds>,
): Promise<boolean> {
  let composition: TextureComposition = normalizeTextureComposition(config.composition)
  if (!composition.layers.length && config.imageDataUrl) composition = migrateLegacySingleImageTexture(config, bounds)
  if (!composition.layers.length) return false
  const targets = panels.map(panel => ({ id: panel.id, x: panel.x, y: panel.y, w: panel.w, h: panel.h }))
  const planned = composition.layers.flatMap(layer => {
    if (!layer.visible) return []
    return [{ layer, placements: resolveTextureLayerPlacements(layer, targets, bounds) }]
  })
  const requiredAssetIds = new Set(planned.flatMap(item => item.placements.map(placement => placement.assetId)))
  const loaded = new Map<string, { asset: TextureCompositionAsset; image: HTMLImageElement }>()
  const failures: string[] = []
  await Promise.all(composition.assets.filter(asset => requiredAssetIds.has(asset.id)).map(async asset => {
    try { loaded.set(asset.id, { asset, image: await loadImage(asset.dataUrl, asset.revision) }) }
    catch { failures.push(asset.name) }
  }))
  if (failures.length) throw new Error(`纹理资源解码失败：${failures.join('、')}`)
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const proceduralSources = new Map<string, HTMLCanvasElement>()
  for (const item of planned) {
    for (const placement of item.placements) {
      let image: HTMLImageElement | HTMLCanvasElement
      if (item.layer.kind === 'pattern' || item.layer.kind === 'preset') {
        const key = `${item.layer.id}:${placement.transform.widthMm}:${placement.transform.heightMm}`
        let source = proceduralSources.get(key)
        if (!source) {
          source = document.createElement('canvas')
          source.width = Math.max(32, Math.min(2048, Math.round(canvas.width * placement.transform.widthMm / bounds.width)))
          source.height = Math.max(32, Math.min(2048, Math.round(canvas.height * placement.transform.heightMm / bounds.height)))
          if (item.layer.kind === 'preset') renderPreset(source, item.layer.presetId)
          else renderTexturePatternToContext(source.getContext('2d')!, source.width, source.height, item.layer.pattern,
            { minX: 0, minY: 0, width: placement.transform.widthMm, height: placement.transform.heightMm })
          proceduralSources.set(key, source)
        }
        image = source
      } else {
        const entry = loaded.get(placement.assetId)
        if (!entry) throw new Error(`纹理图层缺少资源：${item.layer.name}`)
        image = entry.image
      }
      drawCompositionPlacement(ctx, image, placement, config.opacity * item.layer.opacity, bounds, panels, canvas.width, canvas.height)
    }
  }
  return true
}

function reduceColors(canvas: HTMLCanvasElement, config: BoardTextureConfig): void {
  if (config.colorMode === 'original') return
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const levels = Math.max(2, Math.min(8, Math.round(config.colorCount)))
  const step = 255 / (levels - 1)
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2]
    if (config.colorMode === 'mono') {
      const light = Math.round((r * 0.2126 + g * 0.7152 + b * 0.0722) / step) * step
      image.data[i] = light; image.data[i + 1] = light; image.data[i + 2] = light
    } else {
      image.data[i] = Math.round(r / step) * step
      image.data[i + 1] = Math.round(g / step) * step
      image.data[i + 2] = Math.round(b / step) * step
    }
  }
  ctx.putImageData(image, 0, 0)
}

type TextureRgb = SnapColorRgb
const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const textureColorDistance = (a: TextureRgb, b: TextureRgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
const textureNearest = (color: TextureRgb, palette: TextureRgb[]) => {
  let best = 0, distance = Infinity
  palette.forEach((candidate, index) => {
    const next = textureColorDistance(color, candidate)
    if (next < distance) { best = index; distance = next }
  })
  return best
}

function quantizedPalette(samples: TextureRgb[], count: number): TextureRgb[] {
  if (!samples.length) return [[255, 255, 255]]
  const ordered = [...samples].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]))
  let palette = Array.from({ length: count }, (_, index) => ordered[Math.min(ordered.length - 1, Math.floor((index + 0.5) * ordered.length / count))])
  for (let iteration = 0; iteration < 8; iteration++) {
    const sums = Array.from({ length: count }, () => [0, 0, 0, 0])
    for (const sample of samples) {
      const index = textureNearest(sample, palette)
      sums[index][0] += sample[0]; sums[index][1] += sample[1]; sums[index][2] += sample[2]; sums[index][3]++
    }
    palette = palette.map((center, index) => sums[index][3]
      ? [sums[index][0] / sums[index][3], sums[index][1] / sums[index][3], sums[index][2] / sums[index][3]] as TextureRgb
      : center)
  }
  return palette
}

/**
 * SnapColor 高保真预览：先把图像降噪量化为少量设计色，再通过实测 LUT 变成
 * 可由 5 个 0.08mm 光学层合成的观看颜色。基础耗材数由 LUT 决定，不再把
 * 每个观看颜色错误地当作一卷耗材。
 */
async function applySnapColorPalette(canvas: HTMLCanvasElement, config: BoardTextureConfig, recipeIds?: Uint16Array): Promise<void> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const designPalette = await stableSourcePalette(config)
  const sourcePixels = config.cleanup ? new Uint8ClampedArray(image.data) : null
  const lut = await loadSnapColorLut(config.lutId)
  const recipes = config.cleanup && config.modelingMode !== 'pixel'
    ? continuousTextureRecipes(designPalette, lut, config.hueWeight)
    : designPalette.map(color => matchSnapColor(color, lut, config.hueWeight))
  const matchedPalette = recipes.map(recipe => snapColorMeasuredColor(lut, recipe))
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const paletteIndex = textureNearest([image.data[offset], image.data[offset + 1], image.data[offset + 2]], designPalette)
    const color = matchedPalette[paletteIndex]
    if (recipeIds) recipeIds[offset / 4] = recipes[paletteIndex]
    image.data[offset] = color[0]; image.data[offset + 1] = color[1]; image.data[offset + 2] = color[2]
    if (offset > 0 && offset % (4 * 65_536) === 0) await yieldToBrowser()
  }
  if (sourcePixels) cleanTextureColorIslands(sourcePixels, image.data, canvas.width, canvas.height)
  if (sourcePixels && recipeIds) {
    const byColor = new Map(matchedPalette.map((color, index) => [color.join(','), recipes[index]]))
    const byRecipe = new Map(recipes.map((recipe, index) => [recipe, matchedPalette[index]]))
    for (let pixel = 0; pixel < recipeIds.length; pixel++) {
      const offset = pixel * 4
      const color = byRecipe.get(recipeIds[pixel])!
      if (color[0] !== image.data[offset] || color[1] !== image.data[offset + 1] || color[2] !== image.data[offset + 2]) {
        recipeIds[pixel] = byColor.get([image.data[offset], image.data[offset + 1], image.data[offset + 2]].join(',')) ?? recipeIds[pixel]
      }
    }
  }
  ctx.putImageData(image, 0, 0)
}

const sourcePaletteCache = new Map<string, Promise<TextureRgb[]>>()

/** Palette depends on source colors, not image position, crop, panel layout or visible area. */
async function stableSourcePalette(config: BoardTextureConfig): Promise<TextureRgb[]> {
  const composition = normalizeTextureComposition(config.composition)
  const used = new Set(composition.layers.filter(layer => layer.visible).flatMap(layer => layer.kind === 'image' ? [layer.assetId] : layer.kind === 'panel-sequence' ? layer.assetIds : []))
  const procedural = config.source === 'composition' ? composition.layers.filter(layer => layer.visible && (layer.kind === 'preset' || layer.kind === 'pattern')) : []
  const sources = config.source === 'composition'
    ? composition.assets.filter(asset => used.has(asset.id)).map(asset => asset.dataUrl)
    : config.source === 'image' && config.imageDataUrl ? [config.imageDataUrl] : []
  const key = JSON.stringify({ sources, procedural, source: config.source, preset: config.presetId, pattern: config.pattern,
    brightness: config.brightness, contrast: config.contrast, saturation: config.saturation,
    colorMode: config.colorMode, colorCount: config.colorCount, quantizeColors: config.quantizeColors,
    modelingMode: config.modelingMode, baseColor: config.baseColor })
  const cached = sourcePaletteCache.get(key)
  if (cached) return cached
  const pending = (async () => {
    const samples: TextureRgb[] = []
    const sample = document.createElement('canvas')
    sample.width = 96; sample.height = 96
    const ctx = sample.getContext('2d', { willReadFrequently: true })!
    const collect = () => {
      reduceColors(sample, config)
      const data = ctx.getImageData(0, 0, sample.width, sample.height).data
      for (let i = 0; i < data.length; i += 16) {
        if (data[i + 3] > 20) samples.push([data[i], data[i + 1], data[i + 2]])
      }
    }
    for (const source of sources) {
      ctx.clearRect(0, 0, 96, 96)
      ctx.filter = `brightness(${Math.max(0.2, config.brightness)}) contrast(${Math.max(0.2, config.contrast)}) saturate(${Math.max(0, config.saturation)})`
      ctx.drawImage(await loadImage(source), 0, 0, 96, 96)
      ctx.filter = 'none'
      collect()
    }
    for (const layer of procedural) {
      ctx.clearRect(0, 0, 96, 96)
      ctx.filter = `brightness(${Math.max(0.2, config.brightness)}) contrast(${Math.max(0.2, config.contrast)}) saturate(${Math.max(0, config.saturation)})`
      if (layer.kind === 'preset') renderPreset(sample, layer.presetId)
      else if (layer.kind === 'pattern') renderTexturePatternToContext(ctx, 96, 96, layer.pattern, { minX: 0, minY: 0, width: 100, height: 100 })
      ctx.filter = 'none'
      collect()
    }
    if (!sources.length && !procedural.length) {
      if (config.source === 'pattern') renderTexturePatternToContext(ctx, 96, 96, normalizeTexturePattern(config.pattern), { minX: 0, minY: 0, width: 100, height: 100 })
      else renderPreset(sample, config.presetId)
      collect()
    }
    // Background contributes a fixed swatch, never a position-dependent number of samples.
    ctx.clearRect(0, 0, 96, 96); ctx.fillStyle = config.baseColor; ctx.fillRect(0, 0, 96, 96)
    const bg = ctx.getImageData(0, 0, 1, 1).data
    const detail = config.modelingMode === 'pixel'
      ? Math.max(2, Math.min(24, Math.round(config.quantizeColors)))
      : Math.max(8, Math.min(96, Math.round(config.quantizeColors)))
    return [...quantizedPalette(samples, Math.min(detail, samples.length || 1)), [bg[0], bg[1], bg[2]] as TextureRgb]
  })()
  sourcePaletteCache.set(key, pending)
  void pending.catch(() => { if (sourcePaletteCache.get(key) === pending) sourcePaletteCache.delete(key) })
  while (sourcePaletteCache.size > 4) sourcePaletteCache.delete(sourcePaletteCache.keys().next().value!)
  return pending
}

/** 生成已经完成适配、旋转和颜色预处理的整板纹理画布。 */
async function renderBoardTextureCanvas(config: BoardTextureConfig, aspect: number, panels: SplitPanel[] = [], resolution?: { width: number; height: number }, recipeIds?: Uint16Array, layoutOnly = false): Promise<HTMLCanvasElement | null> {
  if (!config.enabled) return null
  const safeAspect = Math.max(0.15, Math.min(6, aspect || 1))
  const canvas = document.createElement('canvas')
  if (resolution) {
    canvas.width = resolution.width
    canvas.height = resolution.height
  } else if (safeAspect >= 1) {
    canvas.width = 1024
    canvas.height = Math.max(256, Math.round(1024 / safeAspect))
  } else {
    canvas.height = 1024
    canvas.width = Math.max(256, Math.round(1024 * safeAspect))
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  if (resolution) ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(config.baseColor) ? config.baseColor : '#e7eaed'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const bounds = panels.length ? getSplitPanelTextureBounds(panels) : {
    minX: 0, minY: 0, maxX: safeAspect * 100, maxY: 100,
    width: safeAspect * 100, height: 100,
  }

  if (config.surfaceMode === 'woodgrain') {
    drawWoodGrainPreview(ctx, canvas.width, canvas.height, config.woodGrain, bounds, config.surfaceColor, panels)
    return canvas
  }
  if (!layoutOnly && config.modelingMode === 'vector' && config.manufacturingContours !== false && config.surfaceMode !== 'veneer') {
    const vector = await buildTextureVectorRegions(config, bounds, panels)
    if (vector.eligible) {
      const lut = await loadSnapColorLut(config.lutId)
      for (const region of vector.regions) {
        const measured = snapColorMeasuredColor(lut, matchSnapColor(hexRgb(region.color), lut, config.hueWeight))
        ctx.fillStyle = `rgb(${measured[0]},${measured[1]},${measured[2]})`
        for (const polygon of region.polygons) {
          ctx.beginPath()
          for (const ring of polygon) {
            ring.forEach(([x, y], index) => {
              const px = (x - bounds.minX) / bounds.width * canvas.width
              const py = (1 - (y - bounds.minY) / bounds.height) * canvas.height
              if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
            })
            ctx.closePath()
          }
          ctx.fill('evenodd')
        }
      }
      applyTextureAvoidZones(canvas, config)
      return canvas
    }
  }

  if (config.surfaceMode === 'veneer') {
    ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(config.surfaceColor) ? config.surfaceColor : '#A8CDBA'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    applyTextureAvoidZones(canvas, config)
    return canvas
  }

  ctx.filter = `brightness(${Math.max(0.2, config.brightness)}) contrast(${Math.max(0.2, config.contrast)}) saturate(${Math.max(0, config.saturation)})`

  if (config.source === 'pattern') {
    renderTexturePatternToContext(ctx, canvas.width, canvas.height, normalizeTexturePattern(config.pattern), bounds)
  } else if (config.source === 'composition') {
    await renderTextureComposition(canvas, config, panels, bounds)
  } else {
    let source: CanvasImageSource
    let sourceWidth: number
    let sourceHeight: number
    if (config.source === 'image' && config.imageDataUrl) {
      const image = await loadImage(config.imageDataUrl)
      source = image
      sourceWidth = image.naturalWidth
      sourceHeight = image.naturalHeight
    } else {
      const presetCanvas = document.createElement('canvas')
      presetCanvas.width = canvas.width
      presetCanvas.height = canvas.height
      renderPreset(presetCanvas, config.presetId)
      source = presetCanvas
      sourceWidth = presetCanvas.width
      sourceHeight = presetCanvas.height
    }

    ctx.save()
    ctx.globalAlpha = Math.max(0.05, Math.min(1, config.opacity))
    drawSource(ctx, source, sourceWidth, sourceHeight, config, canvas.width, canvas.height)
    ctx.restore()
  }
  ctx.filter = 'none'
  if (layoutOnly) {
    applyTextureAvoidZones(canvas, config)
    return canvas
  }
  reduceColors(canvas, config)
  await applySnapColorPalette(canvas, config.source === 'pattern' ? { ...config, cleanup: false } : config, recipeIds)
  if (config.modelingMode === 'pixel') applyPixelGrid(canvas, bounds, config.pixelSize)
  applyTextureAvoidZones(canvas, config)
  if (recipeIds && config.avoidZones.some(zone => zone.enabled)) {
    const lut = await loadSnapColorLut(config.lutId)
    const baseRecipe = matchSnapColor(hexRgb(config.baseColor), lut, config.hueWeight)
    for (const zone of config.avoidZones) {
      if (!zone.enabled) continue
      const { x0, x1, y0, y1 } = textureAvoidZonePixelRect(zone, canvas.width, canvas.height)
      for (let y = y0; y < y1; y++) recipeIds.fill(baseRecipe, y * canvas.width + x0, y * canvas.width + x1)
    }
  }
  return canvas
}

/** Fast source-layout image; uses the same placement math, without LUT or SVG manufacturing. */
export function createLayoutTextureCanvas(config: BoardTextureConfig, aspect: number, panels: SplitPanel[] = []): Promise<HTMLCanvasElement | null> {
  if (import.meta.env.DEV) performance.mark('snapboard:layout-preview')
  const ratio = Math.max(0.15, Math.min(6, aspect || 1))
  const resolution = ratio >= 1
    ? { width: 512, height: Math.max(128, Math.round(512 / ratio)) }
    : { width: Math.max(128, Math.round(512 * ratio)), height: 512 }
  return renderBoardTextureCanvas(config, aspect, panels, resolution, undefined, true)
}

/** Manufacture from a separate physical-resolution canvas; preview remains fixed at 1024. */
export async function createBoardTextureManufacturingData(config: BoardTextureConfig, panels: SplitPanel[], pitchMm: number): Promise<{ canvas: HTMLCanvasElement; recipeIds: Uint16Array | null } | null> {
  if (!Number.isFinite(pitchMm) || pitchMm <= 0) throw new Error('Invalid manufacturing texture pitch')
  const bounds = getSplitPanelTextureBounds(panels)
  const scale = Math.max(1, bounds.width / (pitchMm * 8192), bounds.height / (pitchMm * 8192), Math.sqrt(bounds.width * bounds.height) / (pitchMm * 2000))
  const width = Math.max(1, Math.ceil(bounds.width / (pitchMm * scale)))
  const height = Math.max(1, Math.ceil(bounds.height / (pitchMm * scale)))
  const recipeIds = config.modelingMode === 'pixel' || config.modelingMode === 'vector' ? null : new Uint16Array(width * height)
  const canvas = await renderBoardTextureCanvas(config, bounds.width / bounds.height, panels, { width, height }, recipeIds ?? undefined)
  return canvas ? { canvas, recipeIds } : null
}

/** Match the manufacturing grid anchored at the global lower-left panel bound. */
function applyPixelGrid(canvas: HTMLCanvasElement, bounds: { width: number; height: number }, pitch: number): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const input = new Uint8ClampedArray(image.data)
  const cell = Math.max(0.4, Math.min(6, pitch))
  for (let y = 0; y < canvas.height; y++) {
    const centerY = (Math.floor((1 - y / (canvas.height - 1)) * bounds.height / cell) + .5) * cell
    const sy = Math.max(0, Math.min(canvas.height - 1, Math.round((1 - centerY / bounds.height) * (canvas.height - 1))))
    for (let x = 0; x < canvas.width; x++) {
      const centerX = (Math.floor(x / (canvas.width - 1) * bounds.width / cell) + .5) * cell
      const sx = Math.max(0, Math.min(canvas.width - 1, Math.round(centerX / bounds.width * (canvas.width - 1))))
      const src = (sy * canvas.width + sx) * 4, dst = (y * canvas.width + x) * 4
      image.data.set(input.subarray(src, src + 4), dst)
    }
  }
  ctx.putImageData(image, 0, 0)
}

const textureCanvases = new Map<string, Promise<HTMLCanvasElement | null>>()
const imageSignatures = new Map<string, string>()

/** Colour work depends on the visible face, not physical print settings or the other face. */
export function textureCanvasKey(config: BoardTextureConfig, aspect: number, panels: SplitPanel[] = []): string {
  if (config.surfaceMode === 'woodgrain') config = normalizeWoodGrainTexture(config)
  let imageSignature = ''
  if (config.source === 'image' && config.imageDataUrl) {
    imageSignature = imageSignatures.get(config.imageDataUrl) ?? textureCompositionSignature(config.imageDataUrl)
    imageSignatures.set(config.imageDataUrl, imageSignature)
    while (imageSignatures.size > 8) imageSignatures.delete(imageSignatures.keys().next().value!)
  }
  const composition = normalizeTextureComposition(config.composition)
  const layers = composition.layers.filter(layer => layer.visible).map(layer => layer.kind === 'panel-sequence' ? { ...layer, restoreVisibility: undefined } : layer)
  const used = new Set(layers.flatMap(layer => layer.kind === 'image' ? [layer.assetId] : layer.kind === 'panel-sequence' ? layer.assetIds : []))
  return JSON.stringify({ enabled: config.enabled, source: config.source, surfaceMode: config.surfaceMode,
    woodGrain: normalizeWoodGrain(config.woodGrain),
    imageSignature, imageAspect: config.imageAspect,
    composition: config.source === 'composition' ? { layers, assets: composition.assets.filter(asset => used.has(asset.id)).map(({ dataUrl: _data, ...asset }) => asset) } : undefined,
    preset: config.source === 'preset' ? config.presetId : undefined, pattern: config.source === 'pattern' ? config.pattern : undefined,
    fit: config.fit, scale: config.scale, offsetX: config.offsetX, offsetY: config.offsetY, rotation: config.rotation,
    opacity: config.opacity, brightness: config.brightness, contrast: config.contrast, saturation: config.saturation,
    colorMode: config.colorMode, colorCount: config.colorCount, modelingMode: config.modelingMode,
    lutId: config.lutId, quantizeColors: config.quantizeColors, hueWeight: config.hueWeight, cleanup: config.cleanup,
    manufacturingContours: config.manufacturingContours, pixelSize: config.pixelSize, baseColor: config.baseColor,
    surfaceColor: config.surfaceColor, avoidZones: config.avoidZones.filter(zone => zone.enabled),
    panels: panels.map(panel => ({ id: panel.id, x: panel.x, y: panel.y, w: panel.w, h: panel.h, contour: panel.contour })),
    aspect: Math.round(aspect * 10_000) / 10_000 })
}

/** Keep both faces cached so editing or exporting one does not recalculate the other. */
export function createBoardTextureCanvas(config: BoardTextureConfig, aspect: number, panels: SplitPanel[] = []): Promise<HTMLCanvasElement | null> {
  if (import.meta.env.DEV) performance.mark('snapboard:color-solve')
  const merged = { ...createDefaultBoardTexture(), ...config }
  const resolved = merged.surfaceMode === 'woodgrain' ? normalizeWoodGrainTexture(merged) : merged
  const key = textureCanvasKey(resolved, aspect, panels)
  const cached = textureCanvases.get(key)
  if (cached) return cached
  const pending = renderBoardTextureCanvas(resolved, aspect, panels).catch(error => { textureCanvases.delete(key); throw error })
  textureCanvases.set(key, pending)
  while (textureCanvases.size > 4) textureCanvases.delete(textureCanvases.keys().next().value!)
  return pending
}

/** 给制造网格生成基于全局 XY 的 UV；真实孔洞没有三角面，因此天然保持透明。 */
export function applyBoardTexture(
  root: THREE.Object3D,
  texture: THREE.Texture,
  bounds: ReturnType<typeof getSplitPanelTextureBounds>,
  viewedFromBack = false,
): void {
  root.traverse(object => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position') || object.userData.previewOnly) return
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const uv = new Float32Array(position.count * 2)
    for (let i = 0; i < position.count; i++) {
      uv[i * 2] = viewedFromBack
        ? (bounds.maxX - position.getX(i)) / bounds.width
        : (position.getX(i) - bounds.minX) / bounds.width
      uv[i * 2 + 1] = (position.getY(i) - bounds.minY) / bounds.height
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    const decorate = (source: THREE.Material) => {
      const material = source.clone() as THREE.MeshStandardMaterial
      const previousMap = material.map
      source.dispose()
      if (material.color) material.color.set(0xffffff)
      material.map = texture
      material.roughness = 0.62
      material.metalness = 0.04
      material.needsUpdate = true
      // 换贴图时释放旧图, 防止网格复用路径上的贴图泄漏 (同一张图重复 dispose 无害)。
      if (previousMap?.userData.snapboardTexture && previousMap !== texture) previousMap.dispose()
      return material
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(decorate) : decorate(mesh.material)
  })
}
