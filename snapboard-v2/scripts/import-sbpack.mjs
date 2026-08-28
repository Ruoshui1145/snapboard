import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { strFromU8, unzipSync } from 'fflate'

const root = process.cwd()
const resourceRoot = path.resolve(root, '配件资源包')
const requested = process.argv[2]
if (!requested) throw new Error('用法: npm run pack:import -- "D:/下载/资源包.sbpack"')
const source = path.resolve(root, requested)
const compressed = new Uint8Array(await fs.readFile(source))
const archive = unzipSync(compressed)
const names = Object.keys(archive)
if (names.length > 1000) throw new Error('资源包文件数量超过 1000，拒绝导入')
const allowed = new Set(['.json', '.md', '.txt', '.3mf', '.stl', '.glb', '.gltf', '.step', '.stp', '.sldprt', '.x_t', '.x_b', '.png', '.jpg', '.jpeg', '.webp'])
let totalSize = 0
for (const [name, data] of Object.entries(archive)) {
  const normalized = name.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`资源包含越界路径: ${name}`)
  if (normalized.endsWith('/')) continue
  if (!allowed.has(path.extname(normalized).toLowerCase())) throw new Error(`资源包含不允许的文件: ${name}`)
  totalSize += data.byteLength
}
if (totalSize > 500 * 1024 * 1024) throw new Error('资源包解压后超过 500MB，拒绝导入')
if (!archive['pack.json']) throw new Error('资源包根目录缺少 pack.json')
const pack = JSON.parse(strFromU8(archive['pack.json']))
if (!pack.id || !pack.name || !pack.version) throw new Error('pack.json 缺少 id/name/version')
const folderName = Array.from(String(pack.name).replace(/[<>:"/\\|?*]/g, '-'))
  .map(char => char.charCodeAt(0) < 32 ? '-' : char).join('').trim() || String(pack.id)
const target = path.resolve(resourceRoot, folderName)
if (!target.startsWith(resourceRoot + path.sep)) throw new Error('导入目标路径越界')
try {
  await fs.access(target)
  throw new Error(`同名资源包已经存在，未覆盖: ${target}`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
for (const [name, data] of Object.entries(archive)) {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.endsWith('/')) continue
  const output = path.resolve(target, ...normalized.split('/'))
  if (!output.startsWith(target + path.sep)) throw new Error(`资源包含越界路径: ${name}`)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, data)
}
const sync = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-part-library.mjs')], { cwd: root, stdio: 'inherit' })
if (sync.status !== 0) throw new Error('资源包已导入，但目录同步失败')
console.log(`已导入资源包 ${pack.name} v${pack.version}: ${target}`)
