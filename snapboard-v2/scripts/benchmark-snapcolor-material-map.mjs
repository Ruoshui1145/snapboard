import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { createServer } from 'vite'

const [projectPath, geojsonPath, outputPath] = process.argv.slice(2)
if (!projectPath || !geojsonPath || !outputPath) throw new Error('Usage: benchmark-snapcolor-material-map.mjs <project.snapboard> <regions.geojson> <new-output.json>')
const destination = resolve(outputPath)
const allowed = resolve('output/benchmarks')
if (!destination.startsWith(allowed + '\\') || !isAbsolute(destination) || existsSync(destination)) throw new Error('Output must be a new file under output/benchmarks')
const texture = JSON.parse(readFileSync(projectPath, 'utf8')).workspace.boardTexture
const colors = [...new Set(JSON.parse(readFileSync(geojsonPath, 'utf8')).features.map(feature => feature.properties.color))]
const originalFetch = globalThis.fetch
globalThis.fetch = async input => {
  const asset = String(input)
  if (!asset.startsWith('/snapcolor/luts/') || asset.includes('..')) throw new Error(`Unexpected asset: ${asset}`)
  return new Response(readFileSync(join(process.cwd(), 'public', asset)), { status: 200 })
}
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { loadSnapColorLut, matchSnapColor, snapColorStackMaterial } = await server.ssrLoadModule('/src/utils/snapColorLut.ts')
  const lut = await loadSnapColorLut(texture.lutId)
  const recipes = {}
  const materials = Object.fromEntries(colors.map(color => {
    const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
    const recipe = matchSnapColor(rgb, lut, texture.hueWeight)
    recipes[color] = recipe
    return [color, Array.from({ length: lut.layerCount }, (_, layer) => snapColorStackMaterial(lut, recipe, layer))]
  }))
  writeFileSync(destination, JSON.stringify({ lutId: lut.id, layers: lut.layerCount, colors: materials, recipes }))
  console.log(JSON.stringify({ colors: colors.length, layers: lut.layerCount, output: destination }))
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}
