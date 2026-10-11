// Read-only: node scripts/probe-native-vector-regions.mjs "已保存项目/长亮.snapboard"
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import { installNativeSvgDom } from './native-svg-dom.mjs'

const input = process.argv[2]
if (!input) throw new Error('Pass a .snapboard project path')
installNativeSvgDom()
const workspace = JSON.parse(readFileSync(input, 'utf8')).workspace
const layerCount = Number(process.argv[3] || 0)
const texture = layerCount > 0 ? { ...workspace.boardTexture, composition: {
  ...workspace.boardTexture.composition,
  layers: workspace.boardTexture.composition.layers.slice(0, layerCount),
} } : workspace.boardTexture
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { buildTextureVectorRegions } = await server.ssrLoadModule('/src/utils/textureVectorRegions.ts')
  const { getSplitPanelTextureBounds } = await server.ssrLoadModule('/src/utils/boardTexture.ts')
  const panels = workspace.splitResult.panels
  const started = performance.now()
  const result = await buildTextureVectorRegions(texture, getSplitPanelTextureBounds(panels), panels)
  console.log(JSON.stringify({ eligible: result.eligible, reason: result.reason,
    regions: result.eligible ? result.regions.length : 0,
    vertices: result.eligible ? result.regions.reduce((sum, region) => sum + region.polygons.reduce((n, polygon) =>
      n + polygon.reduce((m, ring) => m + ring.length, 0), 0), 0) : 0,
    milliseconds: Math.round(performance.now() - started), rssMB: Math.round(process.memoryUsage().rss / 1e6) }))
} finally { await server.close() }
