import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'

export const MAX_PACK_BYTES = 100 * 1024 * 1024
const allowed = new Set(['.json', '.md', '.txt', '.3mf', '.stl', '.glb', '.gltf', '.bin', '.step', '.stp', '.sldprt', '.x_t', '.x_b', '.png', '.jpg', '.jpeg', '.webp'])
const queues = new Map()
function validatePath(name) {
  const parts = name.replace(/\/$/, '').split('/')
  if (!name || name.includes('\\') || parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new Error(`资源包路径不安全: ${name}`)
  }
}

export function validatePartResourcePack(compressed) {
  if (compressed.byteLength > MAX_PACK_BYTES) throw new Error('资源包不能超过 100 MB')
  let count = 0, bytes = 0
  const paths = new Set()
  // 在解压前检查每个 ZIP 中央目录条目的尺寸，拒绝 ZIP 炸弹与重复路径。
  const archive = unzipSync(compressed, { filter: file => {
    validatePath(file.name)
    const key = file.name.toLowerCase().replace(/\/$/, '')
    if (paths.has(key)) throw new Error(`资源包存在重复路径: ${file.name}`)
    paths.add(key)
    bytes += file.originalSize
    if (++count > 1000 || bytes > 500 * 1024 * 1024) throw new Error('资源包超过 1000 个文件或解压后超过 500 MB')
    if (file.name.endsWith('/')) return false
    if (!allowed.has(path.extname(file.name).toLowerCase())) throw new Error(`资源包文件类型不支持: ${file.name}`)
    return true
  } })
  if (!archive['pack.json']) throw new Error('资源包根目录缺少 pack.json，请选择 .sbpack 原文件')
  const json = Object.fromEntries(Object.entries(archive).filter(([name]) => name.endsWith('.json')).map(([name, data]) => [name, JSON.parse(strFromU8(data))]))
  const pack = json['pack.json']
  if (!pack || ['id', 'name', 'version'].some(key => typeof pack[key] !== 'string' || !pack[key].trim() || pack[key].length > 160)) throw new Error('pack.json 缺少有效的 id/name/version')
  const ids = new Set()
  for (const [name, part] of Object.entries(json)) {
    if (name !== 'pack.json' && name.endsWith('/pack.json')) throw new Error('不支持嵌套资源包，请分别导入 .sbpack 文件')
    if (!name.endsWith('/part.json')) continue
    if (!part || typeof part.id !== 'string' || !part.id.trim() || ids.has(part.id)) throw new Error(`配件 ID 无效或重复: ${name}`)
    ids.add(part.id)
  }
  if (!Object.keys(archive).some(name => /\.(stl|3mf|glb|gltf)$/i.test(name))) throw new Error('这个资源包没有可导入的配件模型')
  return { archive, pack }
}

export function importPartResourcePack(root, compressed, sync) {
  const key = path.resolve(root)
  const task = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const { archive, pack } = validatePartResourcePack(compressed)
    const resourceRoot = path.join(key, '配件资源包')
    await fs.mkdir(resourceRoot, { recursive: true })
    for (const entry of await fs.readdir(resourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue
      const manifest = path.join(resourceRoot, entry.name, 'pack.json')
      let installed
      try { installed = JSON.parse(await fs.readFile(manifest, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (installed.id === pack.id) throw new Error(`资源包“${installed.name}”已安装（v${installed.version}），未覆盖现有配件`)
    }
    // 保留分类目录名称，避免同步时丢失类别推断；拒绝别名与设备名。
    const folder = pack.name
    validatePath(folder)
    if (folder.includes('/') || folder.startsWith('_')) throw new Error('资源包名称不能用作目录')
    const target = path.join(resourceRoot, folder)
    try { await fs.lstat(target); throw new Error('同名资源目录已存在，未覆盖') } catch (error) { if (error.code !== 'ENOENT') throw error }
    // 下划线暂存目录不参与同步，不会把半个资源包展示给用户。
    const staging = path.join(resourceRoot, `_import-${randomUUID()}`)
    await fs.mkdir(staging)
    let installed = false
    try {
      for (const [name, data] of Object.entries(archive)) {
        const output = path.join(staging, ...name.split('/'))
        await fs.mkdir(path.dirname(output), { recursive: true })
        await fs.writeFile(output, data, { flag: 'wx' })
      }
      await fs.rename(staging, target)
      installed = true
      await sync()
      return { id: pack.id, name: pack.name, version: pack.version }
    } catch (error) {
      // 仅删除本次创建且已验证在 resourceRoot 下的目录，不触碰既有资源。
      const cleanup = installed ? target : staging
      if (!path.resolve(cleanup).startsWith(resourceRoot + path.sep)) throw error
      await fs.rm(cleanup, { recursive: true, force: true })
      if (installed) await sync().catch(() => undefined)
      throw error
    }
  })
  queues.set(key, task.catch(() => undefined))
  return task
}
