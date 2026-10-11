import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'vite'
import { textureFrame } from './native-project-frame.mjs'

const [projectPath, rasterPath, panelId, outputPath, pitchArg] = process.argv.slice(2)
const pitchMm = Number(pitchArg)
if (!projectPath || !rasterPath || !panelId || !outputPath || !Number.isFinite(pitchMm)) throw new Error('Usage: benchmark-native-3mf.mjs <project.snapboard> <recipe-grid.int16> <panel-id|--all> <new-output.3mf> <pitch-mm>')
const target = resolve(outputPath), allowed = resolve('output/benchmarks')
if (!target.startsWith(allowed + '\\') || !target.endsWith('.3mf') || existsSync(target)) throw new Error('Output must be a new 3MF under output/benchmarks')
const workspace = JSON.parse(readFileSync(projectPath, 'utf8')).workspace
const allPanels = workspace.splitResult.panels
// --all = 整单 11 板共用一张世界格点配方网格，一次导出全部板件。
const panels = panelId === '--all' ? allPanels : [allPanels.find(panel => panel.id === panelId)]
if (!panels[0]) throw new Error(`No such panel: ${panelId}`)
const frame = panelId === '--all' ? textureFrame(allPanels) : panels[0]
const width = Math.ceil(frame.w / pitchMm) + 1, height = Math.ceil(frame.h / pitchMm) + 1
const bytes = readFileSync(rasterPath)
if (bytes.byteLength !== width * height * 2) throw new Error('Recipe grid size does not match panel bounds')
const recipeIds = new Uint16Array(bytes.buffer, bytes.byteOffset, width * height)
const originalFetch = globalThis.fetch
globalThis.fetch = async input => {
  const asset = String(input)
  if (!asset.startsWith('/snapcolor/luts/') || asset.includes('..')) throw new Error(`Unexpected asset request: ${asset}`)
  return new Response(readFileSync(join(process.cwd(), 'public', asset)), { status: 200 })
}
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { createManufacturing3MF } = await server.ssrLoadModule('/src/utils/export3mf.ts')
  const start = performance.now()
  const result = await createManufacturing3MF({
    panels, cfg: workspace.splitConfig, placedParts: [],
    projectName: 'Longliang native raster feasibility test',
    boardTexture: workspace.boardTexture,
    assemblyMarking: workspace.assemblyMarking,
    nativeRecipeRaster: { width, height, pitchMm, recipeIds },
    onProgress: (message, progress) => console.log(JSON.stringify({ progress, message, elapsedSeconds: Math.round((performance.now() - start) / 10) / 100 })),
  })
  if (!result.data?.byteLength) throw new Error('Native 3MF did not return a package')
  writeFileSync(target, result.data)
  console.log(JSON.stringify({ output: target, bytes: result.data.byteLength,
    elapsedSeconds: Math.round((performance.now() - start) / 10) / 100,
    panels: result.panelCount, plates: result.plateCount, warnings: result.warnings }))
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}
