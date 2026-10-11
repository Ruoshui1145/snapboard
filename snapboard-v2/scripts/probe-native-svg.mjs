// Read-only Node feasibility probe: node scripts/probe-native-svg.mjs "已保存项目/长亮.snapboard"
import { readFileSync } from 'node:fs'
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'
import { installNativeSvgDom } from './native-svg-dom.mjs'

const input = process.argv[2]
if (!input) throw new Error('Pass a .snapboard project path')
installNativeSvgDom()

const workspace = JSON.parse(readFileSync(input, 'utf8')).workspace
const asset = workspace.boardTexture.composition.assets.find(item => item.mime === 'image/svg+xml')
if (!asset) throw new Error('Project has no SVG asset')
const dataUrl = asset.dataUrl, source = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').toString('utf8')
const start = performance.now()
const parsed = new SVGLoader().parse(source)
console.log(JSON.stringify({ asset: asset.name, sourceBytes: source.length, paths: parsed.paths.length,
  curves: parsed.paths.reduce((sum, path) => sum + path.subPaths.reduce((n, sub) => n + sub.curves.length, 0), 0),
  milliseconds: Math.round(performance.now() - start) }))
