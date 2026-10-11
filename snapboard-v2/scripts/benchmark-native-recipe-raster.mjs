import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { loadSnapColorLut, matchSnapColor } from '../src/utils/snapColorLut.ts'
import { textureFrame } from './native-project-frame.mjs'

const require = createRequire(import.meta.url)
const sharp = require('../../desktop/node_modules/sharp')
const [projectPath, panelId, pitchArg, outputPath, paletteMode, imageMode] = process.argv.slice(2)
const pitchMm = Number(pitchArg)
if (!projectPath || !panelId || !Number.isFinite(pitchMm) || !outputPath || pitchMm < 0.1 || pitchMm > 0.8) throw new Error('Usage: benchmark-native-recipe-raster.mjs <project.snapboard> <panel-id|--all> <pitch-mm> <new-output.int16> [--source-palette]')
const destination = resolve(outputPath), allowed = resolve('output/benchmarks')
if (!destination.startsWith(allowed + '\\') || !destination.endsWith('.int16') || existsSync(destination)) throw new Error('Output must be a new .int16 under output/benchmarks')
const workspace = JSON.parse(readFileSync(projectPath, 'utf8')).workspace
const allPanels = workspace.splitResult.panels
// --all = 整单范围（11 板共用的世界格点），否则只取单板范围。
const panel = panelId === '--all' ? textureFrame(allPanels) : allPanels.find(panel => panel.id === panelId)
if (!panel) throw new Error(`No such panel: ${panelId}`)
const texture = workspace.boardTexture
if (texture.brightness !== 1 || texture.contrast !== 1 || texture.saturation !== 1 || texture.opacity !== 1) throw new Error('This benchmark only supports unmodified color controls')
const width = Math.ceil(panel.w / pitchMm) + 1, height = Math.ceil(panel.h / pitchMm) + 1
const overlays = []
const sourceColors = new Set([texture.baseColor.toLowerCase()])
const start = performance.now()
const visibleLayers = texture.composition.layers.filter(layer => layer.visible && layer.kind === 'image')
for (const layer of imageMode === '--first-only' ? visibleLayers.slice(0, 1) : visibleLayers) {
  const asset = texture.composition.assets.find(asset => asset.id === layer.assetId)
  if (!asset || asset.mime !== 'image/svg+xml') throw new Error('This benchmark requires SVG image layers')
  const t = layer.placement.transform
  if (t.rotationDeg || t.flipX || t.flipY || layer.placement.mode !== 'free' || layer.placement.crop.x || layer.placement.crop.y
    || layer.placement.crop.width !== 1 || layer.placement.crop.height !== 1 || layer.opacity !== 1) throw new Error('Unsupported placement in native raster benchmark')
  const left = Math.round((t.xMm - t.widthMm / 2 - panel.x) / pitchMm)
  const top = Math.round((panel.y + panel.h - t.yMm - t.heightMm / 2) / pitchMm)
  const imageWidth = Math.ceil(t.widthMm / pitchMm), imageHeight = Math.ceil(t.heightMm / pitchMm)
  const x0 = Math.max(0, left), y0 = Math.max(0, top)
  const x1 = Math.min(width, left + imageWidth), y1 = Math.min(height, top + imageHeight)
  if (x1 <= x0 || y1 <= y0) continue
  const source = Buffer.from(asset.dataUrl.split(',')[1], 'base64')
  if (paletteMode === '--source-palette') {
    for (const match of source.toString('utf8').matchAll(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g)) sourceColors.add(match[0].toLowerCase())
  }
  const density = 72 * Math.max(imageWidth / asset.width, imageHeight / asset.height)
  const raw = await sharp(source, { density, limitInputPixels: 50_000_000 })
    .resize(imageWidth, imageHeight, { fit: 'fill' }).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
    .png().toBuffer()
  overlays.push({ input: raw, left: x0, top: y0 })
  console.log(JSON.stringify({ stage: 'render', layer: layer.name, elapsedSeconds: Math.round((performance.now() - start) / 10) / 100 }))
}
const rgb = await sharp({ create: { width, height, channels: 3, background: texture.baseColor } })
  .composite(overlays).removeAlpha().raw().toBuffer()
const originalFetch = globalThis.fetch
globalThis.fetch = async input => {
  const asset = String(input)
  if (!asset.startsWith('/snapcolor/luts/') || asset.includes('..')) throw new Error(`Unexpected LUT request: ${asset}`)
  return new Response(readFileSync(join(process.cwd(), 'public', asset)), { status: 200 })
}
try {
  const lut = await loadSnapColorLut(texture.lutId)
  const cache = new Uint16Array(1 << 18).fill(65535)
  const recipes = new Uint16Array(width * height)
  const palette = paletteMode === '--source-palette' ? [...sourceColors].map(color => {
    const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
    return { rgb, recipe: matchSnapColor(rgb, lut, texture.hueWeight) }
  }) : null
  let misses = 0
  for (let pixel = 0; pixel < recipes.length; pixel++) {
    const offset = pixel * 3, r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2]
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)
    let recipe = cache[key]
    if (recipe === 65535) {
      if (palette) {
        let bestDistance = Infinity, bestRecipe = 0
        for (const entry of palette) {
          const distance = (r - entry.rgb[0]) ** 2 + (g - entry.rgb[1]) ** 2 + (b - entry.rgb[2]) ** 2
          if (distance < bestDistance) { bestDistance = distance; bestRecipe = entry.recipe }
        }
        recipe = bestRecipe
      } else recipe = matchSnapColor([((r >> 2) << 2) + 2, ((g >> 2) << 2) + 2, ((b >> 2) << 2) + 2], lut, texture.hueWeight)
      cache[key] = recipe; misses++
    }
    recipes[pixel] = recipe
  }
  writeFileSync(destination, Buffer.from(recipes.buffer))
  console.log(JSON.stringify({ output: destination, raster: [width, height], uniqueColorBins: misses, sourceColors: palette?.length,
    elapsedSeconds: Math.round((performance.now() - start) / 10) / 100 }))
} finally { globalThis.fetch = originalFetch }
