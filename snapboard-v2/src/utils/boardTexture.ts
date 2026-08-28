import * as THREE from 'three'
import type { BoardTextureConfig, SplitPanel } from '../types/geometry'
import { loadLuminaLut, luminaMeasuredColor, matchLuminaColor, type LuminaRgb } from './luminaLut'

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
    source: 'preset',
    presetId: BOARD_TEXTURE_PRESETS[0].id,
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
    lutId: 'aliz-petg-rybw',
    quantizeColors: 48,
    hueWeight: 0.35,
    cleanup: true,
    textureThickness: 1,
    pixelSize: 1.2,
    surfaceMode: 'lumina',
    baseMaterialName: '普通白色 PETG',
    surfaceMaterialName: '浅绿色 PETG 大理石',
    baseColor: '#F3F3EE',
    surfaceColor: '#A8CDBA',
    surfaceFinish: 'textured-pei',
    baseInfillDensity: 15,
  }
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

const loadImage = (source: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('自定义纹理图片读取失败'))
  image.src = source
})

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

type TextureRgb = LuminaRgb
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
 * Lumina 高保真预览：先把图像降噪量化为少量设计色，再通过实测 LUT 变成
 * 可由 5 个 0.08mm 光学层合成的观看颜色。基础耗材数由 LUT 决定，不再把
 * 每个观看颜色错误地当作一卷耗材。
 */
async function applyLuminaPalette(canvas: HTMLCanvasElement, config: BoardTextureConfig): Promise<void> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const samples: TextureRgb[] = []
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(canvas.width * canvas.height / 24000)))
  for (let y = 0; y < canvas.height; y += sampleStep) for (let x = 0; x < canvas.width; x += sampleStep) {
    const offset = (y * canvas.width + x) * 4
    if (image.data[offset + 3] > 20) samples.push([image.data[offset], image.data[offset + 1], image.data[offset + 2]])
  }
  const detail = config.modelingMode === 'pixel'
    ? Math.max(2, Math.min(24, Math.round(config.quantizeColors)))
    : Math.max(8, Math.min(96, Math.round(config.quantizeColors)))
  const designPalette = quantizedPalette(samples, Math.min(detail, samples.length || 1))
  const lut = await loadLuminaLut(config.lutId)
  const matchedPalette = designPalette.map(color => luminaMeasuredColor(lut, matchLuminaColor(color, lut, config.hueWeight)))
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const color = matchedPalette[textureNearest([image.data[offset], image.data[offset + 1], image.data[offset + 2]], designPalette)]
    image.data[offset] = color[0]; image.data[offset + 1] = color[1]; image.data[offset + 2] = color[2]
    if (offset > 0 && offset % (4 * 65_536) === 0) await yieldToBrowser()
  }
  if (config.cleanup) {
    // 3×3 多数配方清理：只消除孤立点，不模糊真实边缘。
    const copy = new Uint8ClampedArray(image.data)
    const keyAt = (x: number, y: number) => {
      const offset = (y * canvas.width + x) * 4
      return (copy[offset] << 16) | (copy[offset + 1] << 8) | copy[offset + 2]
    }
    for (let y = 1; y < canvas.height - 1; y++) for (let x = 1; x < canvas.width - 1; x++) {
      const center = keyAt(x, y)
      const counts = new Map<number, number>()
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const key = keyAt(x + ox, y + oy)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const winner = [...counts].sort((a, b) => b[1] - a[1])[0]
      if (winner && winner[0] !== center && winner[1] >= 6) {
        const r = winner[0] >> 16, g = (winner[0] >> 8) & 255, b = winner[0] & 255
        const offset = (y * canvas.width + x) * 4
        image.data[offset] = r; image.data[offset + 1] = g; image.data[offset + 2] = b
      }
      if (x === canvas.width - 2 && y % 48 === 0) await yieldToBrowser()
    }
  }
  ctx.putImageData(image, 0, 0)
}

/** 生成已经完成适配、旋转和颜色预处理的整板纹理画布。 */
async function renderBoardTextureCanvas(config: BoardTextureConfig, aspect: number): Promise<HTMLCanvasElement | null> {
  if (!config.enabled) return null
  const safeAspect = Math.max(0.15, Math.min(6, aspect || 1))
  const canvas = document.createElement('canvas')
  if (safeAspect >= 1) {
    canvas.width = 1024
    canvas.height = Math.max(256, Math.round(1024 / safeAspect))
  } else {
    canvas.height = 1024
    canvas.width = Math.max(256, Math.round(1024 * safeAspect))
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#e7eaed'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (config.surfaceMode === 'veneer') {
    ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(config.surfaceColor) ? config.surfaceColor : '#A8CDBA'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // 只做材质观感预览；制造端仍是单卷 PETG，不把这些纹路转成 Lumina 色块。
    const random = pseudoRandom(config.surfaceMaterialName.length * 7919 + 37)
    ctx.globalAlpha = 0.16
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(2, canvas.width / 360)
    for (let line = 0; line < 24; line++) {
      const y = random() * canvas.height
      ctx.beginPath()
      ctx.moveTo(-canvas.width * 0.1, y)
      ctx.bezierCurveTo(canvas.width * 0.28, y + (random() - 0.5) * 46, canvas.width * 0.7, y + (random() - 0.5) * 62, canvas.width * 1.1, y + (random() - 0.5) * 34)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    return canvas
  }

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
  ctx.filter = `brightness(${Math.max(0.2, config.brightness)}) contrast(${Math.max(0.2, config.contrast)}) saturate(${Math.max(0, config.saturation)})`
  drawSource(ctx, source, sourceWidth, sourceHeight, config, canvas.width, canvas.height)
  ctx.restore()
  reduceColors(canvas, config)
  await applyLuminaPalette(canvas, config)
  return canvas
}

let lastTextureCanvasKey = ''
let lastTextureCanvas: Promise<HTMLCanvasElement | null> | null = null

/** 3D 预览与随后执行的 3MF 导出复用同一张 Lumina 结果，避免再次跑完整 K-Means/LUT。 */
export function createBoardTextureCanvas(config: BoardTextureConfig, aspect: number): Promise<HTMLCanvasElement | null> {
  const resolved = { ...createDefaultBoardTexture(), ...config }
  const image = resolved.imageDataUrl ?? ''
  const imageSignature = `${image.length}:${image.slice(0, 48)}:${image.slice(-48)}`
  const key = JSON.stringify({
    ...resolved,
    imageDataUrl: imageSignature,
    aspect: Math.round(aspect * 10_000) / 10_000,
  })
  if (key === lastTextureCanvasKey && lastTextureCanvas) return lastTextureCanvas
  lastTextureCanvasKey = key
  lastTextureCanvas = renderBoardTextureCanvas(resolved, aspect).catch(error => {
    if (lastTextureCanvasKey === key) { lastTextureCanvasKey = ''; lastTextureCanvas = null }
    throw error
  })
  return lastTextureCanvas
}

/** 给制造网格生成基于全局 XY 的 UV；真实孔洞没有三角面，因此天然保持透明。 */
export function applyBoardTexture(
  root: THREE.Object3D,
  texture: THREE.Texture,
  bounds: ReturnType<typeof getSplitPanelTextureBounds>,
): void {
  root.traverse(object => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position') || object.userData.previewOnly) return
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const uv = new Float32Array(position.count * 2)
    for (let i = 0; i < position.count; i++) {
      uv[i * 2] = (position.getX(i) - bounds.minX) / bounds.width
      uv[i * 2 + 1] = (position.getY(i) - bounds.minY) / bounds.height
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    const decorate = (source: THREE.Material) => {
      const material = source.clone() as THREE.MeshStandardMaterial
      source.dispose()
      if (material.color) material.color.set(0xffffff)
      material.map = texture
      material.roughness = 0.62
      material.metalness = 0.04
      material.needsUpdate = true
      return material
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(decorate) : decorate(mesh.material)
  })
}
