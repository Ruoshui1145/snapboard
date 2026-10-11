import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, extname } from 'node:path'

const require = createRequire(import.meta.url)
const sharp = require('../../desktop/node_modules/sharp')
const [projectPath, pitchArg, previewPath] = process.argv.slice(2)
const pitch = Number(pitchArg)
if (!projectPath || !Number.isFinite(pitch) || pitch < 0.05 || pitch > 0.5) throw new Error('Usage: benchmark-native-svg-raster.mjs <project.snapboard> <pitch-mm>')
const composition = JSON.parse(readFileSync(projectPath, 'utf8')).workspace.boardTexture.composition
for (const layer of composition.layers.filter(layer => layer.visible && layer.kind === 'image')) {
  const asset = composition.assets.find(asset => asset.id === layer.assetId)
  if (!asset || asset.mime !== 'image/svg+xml') continue
  const source = Buffer.from(asset.dataUrl.split(',')[1], 'base64')
  const width = Math.ceil(layer.placement.transform.widthMm / pitch)
  const height = Math.ceil(layer.placement.transform.heightMm / pitch)
  const density = 72 * Math.max(width / asset.width, height / asset.height)
  const start = performance.now()
  const { data, info } = await sharp(source, { density, limitInputPixels: 50_000_000 })
    .resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (previewPath && layer === composition.layers.find(candidate => candidate.visible && candidate.kind === 'image' && composition.assets.find(asset => asset.id === candidate.assetId)?.mime === 'image/svg+xml')) {
    const destination = resolve(previewPath), allowed = resolve('output/benchmarks')
    if (!destination.startsWith(allowed + '\\') || existsSync(destination)) throw new Error('Preview must be a new file under output/benchmarks')
    if (extname(destination).toLowerCase() !== '.jpg') throw new Error('Preview filename must end with .jpg')
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .flatten({ background: '#ffffff' }).resize({ width: 800 }).jpeg({ quality: 84 }).toFile(destination)
  }
  console.log(JSON.stringify({ name: asset.name, sourceBytes: source.length, density,
    raster: [info.width, info.height], outputBytes: data.length,
    elapsedSeconds: Math.round((performance.now() - start) / 10) / 100 }))
}
