import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourceRoot = path.join(root, '装配资源包')
const outputRoot = path.join(root, 'public', 'assemblyLibrary')
const outputFile = path.join(outputRoot, 'index.json')
const allowedKinds = new Set(['hole-pattern', 'rail-clip', 't-slot', 'surface-pad'])
const allowedStatuses = new Set(['available', 'experimental', 'planned'])

const exists = file => fs.access(file).then(() => true, () => false)
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const posix = value => value.split(path.sep).join('/')

async function directories(dir) {
  if (!(await exists(dir))) return []
  return (await fs.readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory())
}

async function findHostFiles(dir) {
  const files = []
  if (!(await exists(dir))) return files
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await findHostFiles(full))
    else if (entry.name === 'host.json') files.push(full)
  }
  return files
}

function validatePack(pack, folder) {
  if (!pack || typeof pack !== 'object') throw new Error(`${folder}: pack.json 不是对象`)
  if (pack.kind !== 'assembly-host-pack') throw new Error(`${folder}: kind 必须为 assembly-host-pack`)
  for (const key of ['id', 'name', 'version']) {
    if (typeof pack[key] !== 'string' || !pack[key].trim()) throw new Error(`${folder}: 缺少 ${key}`)
  }
}

function validateHost(host, source) {
  if (!host || typeof host !== 'object') throw new Error(`${source}: host.json 不是对象`)
  for (const key of ['id', 'label', 'kind', 'summary', 'family', 'compatibilityKey', 'systemKey']) {
    if (typeof host[key] !== 'string' || !host[key].trim()) throw new Error(`${source}: 缺少 ${key}`)
  }
  if (!allowedKinds.has(host.kind)) throw new Error(`${source}: 不支持的 kind ${host.kind}`)
  if (!allowedStatuses.has(host.status)) throw new Error(`${source}: 不支持的 status ${host.status}`)
  if (!host.occupancy || typeof host.occupancy !== 'object') throw new Error(`${source}: 缺少 occupancy`)
  if (!Array.isArray(host.recipe) || host.recipe.length === 0) throw new Error(`${source}: recipe 不能为空`)
  if (!host.validation || typeof host.validation !== 'object') throw new Error(`${source}: 缺少 validation`)
  if (!host.interchangeability || typeof host.interchangeability !== 'object') throw new Error(`${source}: 缺少 interchangeability`)
  if (!Array.isArray(host.sources)) throw new Error(`${source}: sources 必须为数组`)
}

await fs.mkdir(sourceRoot, { recursive: true })
await fs.mkdir(outputRoot, { recursive: true })

const packages = []
const hosts = []
const warnings = []
const hostIds = new Set()
const compatibilityKeys = new Set()

for (const entry of await directories(sourceRoot)) {
  if (entry.name.startsWith('_') || entry.name === 'schema') continue
  const packageDir = path.join(sourceRoot, entry.name)
  const packFile = path.join(packageDir, 'pack.json')
  if (!(await exists(packFile))) {
    warnings.push(`${entry.name}: 缺少 pack.json，已忽略`)
    continue
  }
  let pack
  try {
    pack = await readJson(packFile)
    validatePack(pack, entry.name)
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error))
    continue
  }

  const declared = Array.isArray(pack.hosts) ? pack.hosts.filter(item => typeof item === 'string') : []
  const discovered = declared.length
    ? declared.map(relative => path.resolve(packageDir, relative))
    : await findHostFiles(path.join(packageDir, 'hosts'))
  const packageHostIds = []

  for (const hostFile of discovered) {
    const resolved = path.resolve(hostFile)
    if (!(resolved === packageDir || resolved.startsWith(packageDir + path.sep))) {
      warnings.push(`${entry.name}: host 路径越出资源包，已拒绝`)
      continue
    }
    try {
      const host = await readJson(resolved)
      const source = `${entry.name}/${posix(path.relative(packageDir, resolved))}`
      validateHost(host, source)
      if (hostIds.has(host.id)) throw new Error(`${source}: host id 重复 ${host.id}`)
      if (compatibilityKeys.has(host.compatibilityKey)) throw new Error(`${source}: compatibilityKey 重复 ${host.compatibilityKey}`)
      hostIds.add(host.id)
      compatibilityKeys.add(host.compatibilityKey)
      packageHostIds.push(host.id)
      hosts.push({ ...host, packageId: pack.id, packageVersion: pack.version })
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }

  packages.push({
    schemaVersion: Number(pack.schemaVersion) || 1,
    kind: 'assembly-host-pack',
    id: pack.id,
    name: pack.name,
    version: pack.version,
    author: String(pack.author ?? 'Unknown'),
    license: String(pack.license ?? 'All-Rights-Reserved'),
    description: typeof pack.description === 'string' ? pack.description : undefined,
    hostIds: packageHostIds,
  })
}

packages.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
hosts.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packages,
  hosts,
  warnings,
}
await fs.writeFile(outputFile, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`装配资源同步完成：${packages.length} 个包，${hosts.length} 个宿主，${warnings.length} 个警告`)
if (warnings.length) warnings.forEach(warning => console.warn(`- ${warning}`))
