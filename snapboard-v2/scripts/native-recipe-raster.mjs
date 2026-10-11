import { readFileSync, realpathSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import { loadSnapColorLut, matchSnapColor } from '../src/utils/snapColorLut.ts'

// 原生渲染：sharp 把可见图片图层（SVG 矢量 / PNG·JPG·WebP 位图）按世界格点渲染成像素，
// 再把每个像素归回源图色卡对应的 SnapColor 配方。抗锯齿混色因此不会自己变成新颜色
// （那是 0.2mm 试验里面数反而变多的原因）。像素画模式先按 pixelSize 把画面咬合成
// 大方格再匹配配方，与浏览器端 applyPixelGrid 同口径。共享轮廓与最终拉伸仍由导出器完成。
const require = createRequire(import.meta.url)
let sharpModule
const loadSharp = () => {
  if (!sharpModule) {
    try {
      sharpModule = require('../../desktop/node_modules/sharp')
    } catch (error) {
      throw new Error(`原生制造需要 sharp：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return sharpModule
}

/**
 * 制造进程没有浏览器来源，而导出器用 /snapcolor/luts/... 与 /partLibrary/... 这类
 * 相对或"以页面为原点"的地址取资产。这里统一从 public 直接读，按 pathname 匹配，
 * 因此 http://任何origin/partLibrary/x.glb 都能命中。
 *
 * 其余请求必须原样透传——dev server 进程里还有别的接口在发请求，吞掉它们会连带弄坏别的功能。
 */
const NATIVE_ASSET_PREFIXES = ['/snapcolor/luts/', '/partLibrary/']
export const nativeFetchScope = new AsyncLocalStorage()

/** three 的 FileLoader 会用 ProgressEvent 报进度；Node 没有这个全局，缺失时会抛出未捕获异常直接结束进程。 */
class NativeProgressEvent {
  constructor(type, init = {}) {
    this.type = type
    this.lengthComputable = Boolean(init.lengthComputable)
    this.loaded = init.loaded ?? 0
    this.total = init.total ?? 0
  }
}

/** 制造进程缺的浏览器全局都在这里补，避免散落在各处。 */
export function installNativeRuntime(root) {
  if (typeof globalThis.ProgressEvent === 'undefined') globalThis.ProgressEvent = NativeProgressEvent
  const publicRoot = resolve(root, 'public')
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    // three 的 FileLoader 传的是 Request 对象，只认字符串会把配件模型透传给真实网络。
    const raw = typeof input === 'string' ? input
      : input instanceof URL ? input.href
        : input && typeof input === 'object' && typeof input.url === 'string' ? input.url : ''
    if (raw && !raw.startsWith('data:') && !raw.startsWith('blob:')) {
      let pathname = ''
      try { pathname = new URL(raw, 'http://snapboard.local').pathname } catch { pathname = '' }
      if (pathname && NATIVE_ASSET_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
        // URL.pathname 对中文等非 ASCII 字符是百分号编码的；必须先还原一次再拼磁盘路径，
        // 否则配件库里的中文名模型会全部 404（诊断 SNAPCOLOR_NATIVE_MANUFACTURE_BUG_DIAGNOSIS_20260924）。
        let decoded = ''
        try { decoded = decodeURIComponent(pathname) } catch {
          return Promise.resolve(new Response(`资产地址的百分号编码无效：${raw}`, { status: 400 }))
        }
        // 先校验再读文件：拒绝 ..、反斜杠与越出 public 根目录的路径。
        const file = resolve(publicRoot, `.${decoded}`)
        if (decoded.includes('..') || /[\\\u0000:]/.test(decoded) || !file.startsWith(publicRoot + sep)) {
          return Promise.resolve(new Response(`拒绝越界的资产地址：${decoded}`, { status: 403 }))
        }
        try {
          const base = realpathSync(publicRoot), actual = realpathSync(file)
          if (!actual.startsWith(base + sep)) return Promise.resolve(new Response('资产实际路径越界', { status: 403 }))
          return Promise.resolve(new Response(readFileSync(actual), { status: 200 }))
        } catch {
          return Promise.resolve(new Response(`本地资产不存在：${decoded}`, { status: 404 }))
        }
      }
    }
    // Untrusted design assets may use only bundled assets and in-memory image data.
    // Background licence/order requests retain their independent async context.
    if (nativeFetchScope.getStore() && !raw.startsWith('data:') && !raw.startsWith('blob:'))
      return Promise.resolve(new Response('制造素材不能读取任意网络地址；请先导入素材', { status: 403 }))
    return original(input, init)
  }
  return () => { globalThis.fetch = original }
}

/**
 * 配方网格边缘清理（实施日志 §8/§13.2 的"真正对症"一步）。
 *
 * 抗锯齿边缘像素被独立量化后，会在色块里留下只占一两格的孤立配方——切片时每个都变成
 * 一次微型挤出加一次换料，机器一直"点点点"，进而堆料起球、打印失败。这里做连通域清理：
 * 4-连通的同配方区域，格子数不超过 maxIsolatedCells 就整体改判为邻域里的主配方。
 * 细长线条虽然窄但连通域很大，不受影响；只有真正的孤立碎斑会被归并。
 *
 * @returns {{ mergedComponents: number, mergedCells: number }} 归并统计
 */
export function despeckleRecipeGrid(recipeIds, width, height, maxIsolatedCells) {
  if (maxIsolatedCells <= 0 || !width || !height) return { mergedComponents: 0, mergedCells: 0 }
  const size = width * height
  const visited = new Uint8Array(size)
  const queue = new Int32Array(size)
  let mergedComponents = 0
  let mergedCells = 0
  for (let seed = 0; seed < size; seed++) {
    if (visited[seed]) continue
    const recipe = recipeIds[seed]
    let head = 0
    let tail = 0
    queue[tail++] = seed
    visited[seed] = 1
    while (head < tail) {
      const cell = queue[head++]
      const x = cell % width
      if (x > 0 && !visited[cell - 1] && recipeIds[cell - 1] === recipe) { visited[cell - 1] = 1; queue[tail++] = cell - 1 }
      if (x + 1 < width && !visited[cell + 1] && recipeIds[cell + 1] === recipe) { visited[cell + 1] = 1; queue[tail++] = cell + 1 }
      if (cell >= width && !visited[cell - width] && recipeIds[cell - width] === recipe) { visited[cell - width] = 1; queue[tail++] = cell - width }
      if (cell + width < size && !visited[cell + width] && recipeIds[cell + width] === recipe) { visited[cell + width] = 1; queue[tail++] = cell + width }
    }
    if (tail > maxIsolatedCells) continue
    // 小连通域：统计四周（区域外）邻居的配方票數，改判给票数最多的主配方。
    const votes = new Map()
    for (let index = 0; index < tail; index++) {
      const cell = queue[index]
      const x = cell % width
      const neighbors = []
      if (x > 0) neighbors.push(cell - 1)
      if (x + 1 < width) neighbors.push(cell + 1)
      if (cell >= width) neighbors.push(cell - width)
      if (cell + width < size) neighbors.push(cell + width)
      for (const neighbor of neighbors) {
        if (recipeIds[neighbor] === recipe) continue
        // 只投给"大区域"的配方：邻居本身如果也属于待定小区域，先不投，避免碎斑互相投票。
        votes.set(recipeIds[neighbor], (votes.get(recipeIds[neighbor]) ?? 0) + 1)
      }
    }
    if (!votes.size) continue
    let winner = -1
    let winnerVotes = 0
    for (const [candidate, count] of votes) if (count > winnerVotes) { winner = candidate; winnerVotes = count }
    for (let index = 0; index < tail; index++) recipeIds[queue[index]] = winner
    mergedComponents++
    mergedCells += tail
  }
  return { mergedComponents, mergedCells }
}

/** 原生渲染能直接光栅化的图片格式。其余格式报清楚错误，由前端回退浏览器导出。 */
const SUPPORTED_IMAGE_MIMES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'])

/** 与 boardTexture.ts 的 textureNearest 同算法：找色卡里欧氏距离最近的颜色下标。 */
function textureNearest(color, palette) {
  let best = 0
  let bestDistance = Infinity
  for (let index = 0; index < palette.length; index++) {
    const entry = palette[index]
    const distance = (color[0] - entry[0]) ** 2 + (color[1] - entry[1]) ** 2 + (color[2] - entry[2]) ** 2
    if (distance < bestDistance) { bestDistance = distance; best = index }
  }
  return best
}

/** 与 boardTexture.ts 的 quantizedPalette 同算法：位图源没有可读文本色卡，采样后 k-means 聚出设计色。 */
function quantizedPalette(samples, count) {
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
      ? [sums[index][0] / sums[index][3], sums[index][1] / sums[index][3], sums[index][2] / sums[index][3]]
      : center)
  }
  return palette
}

/** 位图调色板：96×96 抽样后聚类，色数与浏览器 stableSourcePalette 同口径（像素模式更少）。 */
async function sampleBitmapPalette(sharp, source, texture) {
  const raw = await sharp(source, { limitInputPixels: 50_000_000 })
    .resize(96, 96, { fit: 'fill' })
    .flatten({ background: texture.baseColor })
    .removeAlpha().raw().toBuffer()
  const samples = []
  for (let offset = 0; offset + 2 < raw.length; offset += 12) samples.push([raw[offset], raw[offset + 1], raw[offset + 2]])
  const detail = texture.modelingMode === 'pixel'
    ? Math.max(2, Math.min(24, Math.round(texture.quantizeColors ?? 48)))
    : Math.max(8, Math.min(96, Math.round(texture.quantizeColors ?? 48)))
  return quantizedPalette(samples, Math.min(detail, samples.length || 1))
}

/** Canvas drawCompositionPlacement: crop/fit inside the local box, then flip and rotate about its centre. */
async function transformedFreeOverlay(sharp, source, asset, layer, frame, pitchMm, width, height) {
  const { transform: t, crop } = layer.placement
  const targetWidth = Math.max(1, Math.ceil(t.widthMm / pitchMm))
  const targetHeight = Math.max(1, Math.ceil(t.heightMm / pitchMm))
  if (targetWidth * targetHeight > 25_000_000) {
    throw new Error(`图层“${layer.name}”的变换尺寸超过原生制造单图预算；请缩小图片尺寸或改用浏览器导出`)
  }
  const density = 72 * Math.max(targetWidth / Math.max(1, asset.width * crop.width),
    targetHeight / Math.max(1, asset.height * crop.height))
  const image = sharp(source, { density, limitInputPixels: 50_000_000 })
  const meta = await image.metadata()
  const left = Math.max(0, Math.min(meta.width - 1, Math.floor(crop.x * meta.width)))
  const top = Math.max(0, Math.min(meta.height - 1, Math.floor(crop.y * meta.height)))
  const croppedWidth = Math.max(1, Math.min(meta.width - left, Math.ceil(crop.width * meta.width)))
  const croppedHeight = Math.max(1, Math.min(meta.height - top, Math.ceil(crop.height * meta.height)))
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 }
  const fit = layer.placement.fit === 'cover' || layer.placement.fit === 'contain'
    ? layer.placement.fit : 'fill'
  const tile = await image.extract({ left, top, width: croppedWidth, height: croppedHeight })
    .ensureAlpha().resize(targetWidth, targetHeight, { fit, position: 'centre', background: transparent }).png().toBuffer()
  let adjusted = sharp(tile)
  if (t.flipY) adjusted = adjusted.flip()
  if (t.flipX) adjusted = adjusted.flop()
  if (t.rotationDeg) adjusted = adjusted.rotate(-t.rotationDeg, { background: transparent })
  let { data, info } = await adjusted.png().toBuffer({ resolveWithObject: true })
  const opacity = Math.max(0, Math.min(1, layer.opacity))
  if (opacity < 1) {
    const raw = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let i = 3; i < raw.data.length; i += raw.info.channels) raw.data[i] = Math.round(raw.data[i] * opacity)
    data = await sharp(raw.data, { raw: raw.info }).png().toBuffer()
    info = raw.info
  }
  const cx = (t.xMm - frame.x) / pitchMm
  const cy = (frame.y + frame.h - t.yMm) / pitchMm
  const imageLeft = Math.round(cx - info.width / 2)
  const imageTop = Math.round(cy - info.height / 2)
  const x0 = Math.max(0, imageLeft), y0 = Math.max(0, imageTop)
  const x1 = Math.min(width, imageLeft + info.width), y1 = Math.min(height, imageTop + info.height)
  if (x1 <= x0 || y1 <= y0) return null
  if (x0 !== imageLeft || y0 !== imageTop || x1 !== imageLeft + info.width || y1 !== imageTop + info.height) {
    data = await sharp(data).extract({ left: x0 - imageLeft, top: y0 - imageTop,
      width: x1 - x0, height: y1 - y0 }).png().toBuffer()
  }
  return { input: data, left: x0, top: y0 }
}

/**
 * 与浏览器 applyPixelGrid 同口径：每个制造格点的颜色取自所属像素块的块中心，
 * 整幅画面先咬合成 pixelSize 大方格，再做配方匹配。cell 夹紧范围与浏览器一致。
 */
function snapToPixelGrid(rgb, width, height, pitchMm, pixelSizeMm) {
  const cell = Math.max(0.4, Math.min(6, pixelSizeMm))
  const snapped = Buffer.alloc(rgb.length)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(height - 1, Math.round((Math.floor(y * pitchMm / cell) + 0.5) * cell / pitchMm))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.round((Math.floor(x * pitchMm / cell) + 0.5) * cell / pitchMm))
      const src = (sy * width + sx) * 3
      const dst = (y * width + x) * 3
      snapped[dst] = rgb[src]; snapped[dst + 1] = rgb[src + 1]; snapped[dst + 2] = rgb[src + 2]
    }
  }
  return snapped
}

/**
 * @param texture 工程里的 boardTexture（含 composition.assets[].dataUrl）
 * @param frame   纹理范围 { x, y, w, h }（世界 mm），与 getSplitPanelTextureBounds 同口径
 * @param pitchMm 制造间距，来自 computeManufacturingBudget
 * @param minFeatureMm 最小可制造色块尺寸（mm）。小于它的孤立配方碎斑会被归并进邻域主配方；
 *                     传 0/缺省则不清理（仅用于对照实验）。
 */
export async function buildRecipeRaster(texture, frame, pitchMm, minFeatureMm = 0) {
  if (texture.brightness !== 1 || texture.contrast !== 1 || texture.saturation !== 1 || texture.opacity !== 1) {
    throw new Error('原生制造只支持未调整亮度/对比度/饱和度的纹理')
  }
  const unsupportedLayer = texture.composition.layers
    .filter(layer => layer.visible && layer.kind === 'image')
    .find(layer => {
      const asset = texture.composition.assets.find(item => item.id === layer.assetId)
      return !asset || !SUPPORTED_IMAGE_MIMES.has(asset.mime)
    })
  if (unsupportedLayer) {
    throw new Error(`原生制造暂不支持图层“${unsupportedLayer.name}”的图片格式（支持 SVG / PNG / JPG / WebP）`)
  }
  const sharp = loadSharp()
  const width = Math.ceil(frame.w / pitchMm) + 1
  const height = Math.ceil(frame.h / pitchMm) + 1
  const overlays = []
  const sourceColors = new Set([texture.baseColor.toLowerCase()])
  const bitmapClusters = []
  const visibleLayers = texture.composition.layers.filter(layer => layer.visible && layer.kind === 'image')
  for (const layer of visibleLayers) {
    const asset = texture.composition.assets.find(item => item.id === layer.assetId)
    const t = layer.placement.transform
    if (layer.placement.mode !== 'free') throw new Error(`原生制造暂不支持图层“${layer.name}”的非自由摆放模式`)
    const crop = layer.placement.crop
    if (![t.xMm, t.yMm, t.widthMm, t.heightMm, t.rotationDeg,
      crop.x, crop.y, crop.width, crop.height, layer.opacity].every(Number.isFinite)
      || t.widthMm <= 0 || t.heightMm <= 0 || crop.width <= 0 || crop.height <= 0) {
      throw new Error(`图层“${layer.name}”的图片变换参数无效`)
    }
    const source = Buffer.from(asset.dataUrl.split(',')[1], 'base64')
    if (asset.mime === 'image/svg+xml') {
      for (const match of source.toString('utf8').matchAll(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g)) sourceColors.add(match[0].toLowerCase())
    } else bitmapClusters.push(...await sampleBitmapPalette(sharp, source, texture))
    if (t.rotationDeg || t.flipX || t.flipY || crop.x || crop.y || crop.width !== 1 || crop.height !== 1
      || layer.opacity !== 1 || (layer.placement.fit && layer.placement.fit !== 'stretch')) {
      const overlay = await transformedFreeOverlay(sharp, source, asset, layer, frame, pitchMm, width, height)
      if (overlay) overlays.push(overlay)
      continue
    }
    const left = Math.round((t.xMm - t.widthMm / 2 - frame.x) / pitchMm)
    const top = Math.round((frame.y + frame.h - t.yMm - t.heightMm / 2) / pitchMm)
    const imageWidth = Math.ceil(t.widthMm / pitchMm), imageHeight = Math.ceil(t.heightMm / pitchMm)
    const x0 = Math.max(0, left), y0 = Math.max(0, top)
    const x1 = Math.min(width, left + imageWidth), y1 = Math.min(height, top + imageHeight)
    if (x1 <= x0 || y1 <= y0) continue
    const density = 72 * Math.max(imageWidth / asset.width, imageHeight / asset.height)
    const raw = await sharp(source, { density, limitInputPixels: 50_000_000 })
      .resize(imageWidth, imageHeight, { fit: 'fill' })
      .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
      .png().toBuffer()
    overlays.push({ input: raw, left: x0, top: y0 })
  }
  let rgb = await sharp({ create: { width, height, channels: 3, background: texture.baseColor } })
    .composite(overlays).removeAlpha().raw().toBuffer()
  if (texture.modelingMode === 'pixel') rgb = snapToPixelGrid(rgb, width, height, pitchMm, texture.pixelSize ?? 1.2)

  const lut = await loadSnapColorLut(texture.lutId)
  const palette = [...sourceColors].map(color => {
    const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
    return { channels, recipe: matchSnapColor(channels, lut, texture.hueWeight) }
  })
  for (const channels of bitmapClusters) palette.push({ channels, recipe: matchSnapColor(channels, lut, texture.hueWeight) })
  const cache = new Uint16Array(1 << 18).fill(65535)
  const recipeIds = new Uint16Array(width * height)
  let uniqueColorBins = 0
  for (let pixel = 0; pixel < recipeIds.length; pixel++) {
    const offset = pixel * 3, r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2]
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)
    let recipe = cache[key]
    if (recipe === 65535) {
      let bestDistance = Infinity, bestRecipe = 0
      for (const entry of palette) {
        const distance = (r - entry.channels[0]) ** 2 + (g - entry.channels[1]) ** 2 + (b - entry.channels[2]) ** 2
        if (distance < bestDistance) { bestDistance = distance; bestRecipe = entry.recipe }
      }
      recipe = bestRecipe
      cache[key] = recipe
      uniqueColorBins++
    }
    recipeIds[pixel] = recipe
  }
  // 孤立碎斑归并：阈值按物理尺寸折算成格子数（不足一格按一格算，保证单格碎斑总是被清理）。
  const maxIsolatedCells = minFeatureMm > 0 ? Math.max(1, Math.ceil((minFeatureMm / pitchMm) ** 2)) : 0
  const despeckle = despeckleRecipeGrid(recipeIds, width, height, maxIsolatedCells)
  if (texture.avoidZones?.some(zone => zone.enabled)) {
    // 与 boardTexture 的 Canvas 后处理同口径：业务 Y 自下向上，网格行自上向下。
    // 在去色斑后写入，避让区必须是准确的基材配方，不能再被邻域票数改掉。
    const base = [1, 3, 5].map(offset => Number.parseInt(texture.baseColor.slice(offset, offset + 2), 16))
    const baseRecipe = matchSnapColor(base, lut, texture.hueWeight)
    const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
    for (const zone of texture.avoidZones) {
      if (!zone.enabled) continue
      const x0 = Math.floor(clamp(zone.x) * width)
      const x1 = Math.max(x0, Math.ceil(clamp(zone.x + zone.width) * width))
      const y0 = Math.floor((1 - clamp(zone.y + zone.height)) * height)
      const y1 = Math.max(y0, Math.ceil((1 - clamp(zone.y)) * height))
      for (let y = y0; y < y1; y++) recipeIds.fill(baseRecipe, y * width + x0, y * width + x1)
    }
  }
  return { width, height, pitchMm, recipeIds, uniqueColorBins, sourceColors: palette.length,
    layers: visibleLayers.length, minFeatureMm, maxIsolatedCells, despeckle }
}
