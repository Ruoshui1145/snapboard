import { promises as fs } from 'node:fs'
import path from 'node:path'
import { zipSync } from 'fflate'

const root = process.cwd()
const resourceRoot = path.resolve(root, '配件资源包')
const requested = process.argv[2]
if (!requested) throw new Error('用法: npm run pack:export -- "资源包文件夹名"')
const source = path.resolve(resourceRoot, requested)
if (!source.startsWith(resourceRoot + path.sep)) throw new Error('资源包路径越界')
const packFile = path.join(source, 'pack.json')
const pack = JSON.parse(await fs.readFile(packFile, 'utf8'))
if (!pack.id || !pack.version) throw new Error('pack.json 缺少 id/version')

const allowed = new Set(['.json', '.md', '.txt', '.3mf', '.stl', '.glb', '.gltf', '.step', '.stp', '.sldprt', '.x_t', '.x_b', '.png', '.jpg', '.jpeg', '.webp'])
const archive = {}
async function collect(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collect(full)
    else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (!allowed.has(ext)) {
        console.warn(`已跳过不允许导出的文件: ${path.relative(source, full)}`)
        continue
      }
      archive[path.relative(source, full).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(full))
    }
  }
}
await collect(source)
const outDir = path.join(root, '资源包导出')
await fs.mkdir(outDir, { recursive: true })
const safeName = `${pack.id}-${pack.version}`.replace(/[^a-zA-Z0-9_.-]+/g, '-')
const output = path.join(outDir, `${safeName}.sbpack`)
await fs.writeFile(output, zipSync(archive, { level: 6 }))
console.log(`已导出 ${Object.keys(archive).length} 个文件: ${output}`)
