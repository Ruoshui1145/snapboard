import { promises as fs } from 'node:fs'
import path from 'node:path'
import { categoryFromDirName } from './part-category-rules.mjs'

const root = process.cwd()
const sourceRoot = path.join(root, '配件资源包')
const libraryDir = path.join(root, 'public', 'partLibrary')
const assetRoot = path.join(libraryDir, 'community-assets')
const library = JSON.parse(await fs.readFile(path.join(libraryDir, 'library.json'), 'utf8'))
const previewExts = ['.glb', '.gltf', '.3mf', '.stl']
const printExts = ['.3mf', '.stl']
const sourceExts = ['.step', '.stp', '.sldprt', '.x_t', '.x_b']
const imageExts = ['.png', '.jpg', '.jpeg', '.webp']
const allowedExts = new Set([...previewExts, ...printExts, ...sourceExts, ...imageExts])
const warnings = []

const posix = value => value.split(path.sep).join('/')
const cleanId = value => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_.-]+/g, '-').replace(/^-+|-+$/g, '')
const exists = async file => fs.access(file).then(() => true, () => false)
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const safeSegment = value => cleanId(value).replace(/\.+/g, '.') || 'unnamed'

async function childDirectories(dir) {
  if (!(await exists(dir))) return []
  return (await fs.readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory())
}

async function findPartDirectories(dir) {
  const result = []
  if (!(await exists(dir))) return result
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  const hasManifest = files.includes('part.json')
  const hasModel = files.some(file => previewExts.includes(path.extname(file).toLowerCase()))
  if (hasManifest || hasModel) result.push(dir)
  for (const entry of entries) {
    if (entry.isDirectory()) result.push(...await findPartDirectories(path.join(dir, entry.name)))
  }
  return result
}

async function copyAsset(source, packageId, partId) {
  const targetDir = path.join(assetRoot, safeSegment(packageId), safeSegment(partId))
  await fs.mkdir(targetDir, { recursive: true })
  const target = path.join(targetDir, path.basename(source))
  await fs.copyFile(source, target)
  return posix(path.relative(libraryDir, target))
}

function chooseFile(files, given, extensions) {
  const explicit = given ? files.find(file => file === path.basename(given)) : undefined
  if (explicit) return explicit
  const preferred = ['preview.glb', 'preview.gltf', 'model.3mf', 'model.glb', 'model.gltf', 'model.stl']
  return preferred.find(file => files.includes(file) && extensions.includes(path.extname(file).toLowerCase()))
    ?? files.find(file => extensions.includes(path.extname(file).toLowerCase()))
}

await fs.mkdir(sourceRoot, { recursive: true })
await fs.mkdir(assetRoot, { recursive: true })

const packages = []
const parts = []
const designs = []
for (const entry of await childDirectories(sourceRoot)) {
  if (entry.name.startsWith('_')) continue
  const packageDir = path.join(sourceRoot, entry.name)
  const packFile = path.join(packageDir, 'pack.json')
  // 大类目录规则:
  //  - 无 pack.json 的顶层目录 = “大类目录”(模型拖入即可自动收录, 首次发现零件补 pack.json)
  //  - 已有 pack.json 但没有 parts/ 子目录 → 同样按大类目录处理, 扫描根目录的散放模型
  //    (修复: 自动包生成后再次同步会漏掉根目录模型的问题)
  const hadPackFile = await exists(packFile)
  const partsSubDir = path.join(packageDir, 'parts')
  const hasPartsSub = await exists(partsSubDir)
  let pack
  let dirCategory = 'custom'
  const inferredRootCategory = categoryFromDirName(entry.name)
  // 8 个命名大类即使误留了空 parts/ 也必须继续按“大类根”扫描，避免网页导入后零件消失。
  let categoryMode = !hadPackFile || !hasPartsSub || inferredRootCategory !== 'custom'
  if (hadPackFile) {
    try { pack = await readJson(packFile) }
    catch (error) {
      warnings.push(`${entry.name}: pack.json 解析失败 (${error.message})`)
      continue
    }
    if (!pack.id || !pack.version || !pack.name) {
      warnings.push(`${entry.name}: pack.json 必须包含 id/name/version`)
      continue
    }
  } else {
    dirCategory = inferredRootCategory
    pack = {
      schemaVersion: 1,
      id: `snapboard.category-${cleanId(entry.name)}`,
      name: entry.name,
      version: '1.0.0',
      author: 'Local User',
      license: 'Private',
      description: `“${entry.name}”大类目录：把模型文件拖入本文件夹（或子文件夹）即可自动收录。`,
    }
    // pack.json 延迟写入: 只有该目录真的出现了零件才创建 (空目录不产生垃圾包)
  }
  if (categoryMode) dirCategory = inferredRootCategory

  // 散放模型归一化: 目录根部没有 part.json 却有一批模型文件 → 每个文件各成一个零件
  // (自动建同名子目录并移入; 修复"整个大类目录被当成一个零件, 只取第一个模型"的问题)
  {
    const rootEntries = (await fs.readdir(packageDir, { withFileTypes: true }))
    const rootFiles = rootEntries.filter(f => f.isFile()).map(f => f.name)
    const rootModels = rootFiles.filter(f => previewExts.includes(path.extname(f).toLowerCase()))
    let canNormalizeRootModels = categoryMode && rootModels.length > 0
    if (canNormalizeRootModels && rootFiles.includes('part.json')) {
      try {
        const rootManifest = await readJson(path.join(packageDir, 'part.json'))
        // 显式引用根部模型的 manifest 视为用户有意采用“包根即零件”，不自动移动。
        if (rootManifest?.model?.preview) canNormalizeRootModels = false
        else await fs.rm(path.join(packageDir, 'part.json'), { force: true })
      } catch (error) {
        warnings.push(`${entry.name}: 根目录 part.json 解析失败，未移动散模型 (${error.message})`)
        canNormalizeRootModels = false
      }
    }
    if (canNormalizeRootModels) {
      // 根部存在空槽位 part.json (无模型引用) → 移除, 让散文件各自成零件
      const remaining = (await fs.readdir(packageDir, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name)
      const stemCounts = new Map()
      for (const file of remaining.filter(file => previewExts.includes(path.extname(file).toLowerCase()))) {
        const stem = safeSegment(file.slice(0, file.length - path.extname(file).length))
        stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1)
      }
      for (const file of remaining) {
        if (!previewExts.includes(path.extname(file).toLowerCase())) continue
        const stem = safeSegment(file.slice(0, file.length - path.extname(file).length))
        const extensionTag = path.extname(file).slice(1).toLowerCase()
        const folderName = stemCounts.get(stem) > 1 ? `${stem}-${extensionTag}` : stem
        const targetDir = path.join(packageDir, folderName)
        try {
          await fs.mkdir(targetDir, { recursive: true })
          const target = path.join(targetDir, file)
          if (!(await exists(target))) await fs.rename(path.join(packageDir, file), target).catch(() => undefined)
        } catch { /* 文件被占用/锁定: 跳过, 下次同步再归一化 */ }
      }
    }
  }
  const packageInfo = {
    schemaVersion: pack.schemaVersion ?? 1,
    id: String(pack.id),
    name: String(pack.name),
    version: String(pack.version),
    author: String(pack.author ?? 'Unknown'),
    license: String(pack.license ?? 'All-Rights-Reserved'),
    description: pack.description ? String(pack.description) : undefined,
  }
  // 大类目录: 先记下来, 确有零件时才进入包列表 (空目录不产生垃圾包)
  const pendingCategoryPackage = categoryMode ? packageInfo : null
  if (!categoryMode) packages.push(packageInfo)

  let packagePartCount = 0

  for (const dir of await findPartDirectories(categoryMode ? packageDir : path.join(packageDir, 'parts'))) {
    const files = (await fs.readdir(dir, { withFileTypes: true })).filter(file => file.isFile()).map(file => file.name)
    let manifest = {}
    if (files.includes('part.json')) {
      try { manifest = await readJson(path.join(dir, 'part.json')) }
      catch (error) {
        warnings.push(`${entry.name}/${path.basename(dir)}: part.json 解析失败 (${error.message})`)
        continue
      }
    } else {
      // 直接拖入的裸模型：自动生成 part.json 槽位（待标定），标定器即可写回锚点。
      const fallbackId = cleanId(path.basename(dir)) || 'part'
      manifest = {
        id: fallbackId,
        name: path.basename(dir),
        category: dirCategory,
        description: '从大类文件夹拖入自动收录；请标定吸附面与默认朝向',
        kind: 'fixed',
        params: [],
        model: {},
        mount: { mode: 'free', anchors: [], calibrationRequired: true },
        defaultRotation: 0,
      }
      await fs.writeFile(path.join(dir, 'part.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
    if (!Number.isFinite(Number(manifest.sortOrder))) {
      manifest.sortOrder = (packagePartCount + 1) * 10
      await fs.writeFile(path.join(dir, 'part.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
    const explicit = manifest.model ?? {}
    const preview = chooseFile(files, explicit.preview, previewExts)
    // 预建上传槽位没有模型时安静等待，不把它当成坏包。
    if (!preview) continue
    const printable = chooseFile(files, explicit.print, printExts)
    const source = chooseFile(files, explicit.source, sourceExts)
    const thumbnail = manifest.thumbnail && files.includes(path.basename(manifest.thumbnail))
      ? path.basename(manifest.thumbnail)
      : files.find(file => imageExts.includes(path.extname(file).toLowerCase()))
    const localId = String(manifest.id || cleanId(path.basename(dir)))
    const id = `${packageInfo.id}:${localId}`
    const ext = path.extname(preview).slice(1).toLowerCase()
    const defaultUp = ext === 'glb' || ext === 'gltf' ? 'y' : 'z'
    const defaultUnit = ext === 'glb' || ext === 'gltf' ? 'meter' : 'millimeter'
    const copiedPreview = await copyAsset(path.join(dir, preview), packageInfo.id, localId)
    const copiedPrint = printable ? await copyAsset(path.join(dir, printable), packageInfo.id, localId) : undefined
    const copiedSource = source ? await copyAsset(path.join(dir, source), packageInfo.id, localId) : undefined
    const copiedThumbnail = thumbnail ? await copyAsset(path.join(dir, thumbnail), packageInfo.id, localId) : undefined
    for (const file of files) {
      const fileExt = path.extname(file).toLowerCase()
      if (fileExt && !allowedExts.has(fileExt) && file !== 'part.json') {
        warnings.push(`${entry.name}/${path.basename(dir)}: 已忽略不允许的文件 ${file}`)
      }
    }
    parts.push({
      id,
      localId,
      pack: entry.name,
      packageId: packageInfo.id,
      packageVersion: packageInfo.version,
      author: packageInfo.author,
      category: manifest.category ?? dirCategory,
      ...(Number.isFinite(Number(manifest.sortOrder)) ? { sortOrder: Number(manifest.sortOrder) } : {}),
      name: manifest.name ?? path.basename(dir),
      description: manifest.description ?? (Object.keys(manifest).length ? '' : '自动收录；尚未配置装配锚点'),
      kind: manifest.kind ?? 'fixed',
      params: manifest.params ?? [],
      model: {
        preview: copiedPreview,
        ...(copiedPrint ? { print: copiedPrint } : {}),
        ...(copiedSource ? { source: copiedSource } : {}),
        format: ext,
        unit: explicit.unit ?? defaultUnit,
        upAxis: explicit.upAxis ?? defaultUp,
        scale: explicit.scale ?? 1,
        ...(Array.isArray(explicit.orientation) ? { orientation: explicit.orientation } : {}),
      },
      mount: manifest.mount ?? { mode: 'free', anchors: [] },
      defaultRotation: manifest.defaultRotation ?? 0,
      ...(copiedThumbnail ? { thumbnail: copiedThumbnail } : {}),
    })
    packagePartCount++
  }

  // 大类目录: 确有零件时才补写 pack.json 并进入包列表 (空目录不产生垃圾包)
  if (categoryMode && packagePartCount > 0 && !(await exists(packFile))) {
    await fs.writeFile(packFile, JSON.stringify(pack, null, 2) + '\n', 'utf8')
  }
  if (categoryMode && packagePartCount > 0 && pendingCategoryPackage) {
    packages.push(pendingCategoryPackage)
  }

  for (const designDir of await childDirectories(path.join(packageDir, 'designs'))) {
    const manifestFile = path.join(packageDir, 'designs', designDir.name, 'design.json')
    if (!(await exists(manifestFile))) continue
    try {
      const design = await readJson(manifestFile)
      designs.push({
        id: String(design.id ?? cleanId(designDir.name)),
        packageId: packageInfo.id,
        name: String(design.name ?? designDir.name),
        description: design.description ? String(design.description) : undefined,
        author: String(design.author ?? packageInfo.author),
        manifest: posix(path.relative(root, manifestFile)),
      })
    } catch (error) {
      warnings.push(`${entry.name}/${designDir.name}: design.json 解析失败 (${error.message})`)
    }
  }
}

const packageIds = new Set()
for (const pack of packages) {
  if (packageIds.has(pack.id)) throw new Error(`重复资源包 ID: ${pack.id}`)
  packageIds.add(pack.id)
}
const scopedPartIds = new Set()
for (const part of parts) {
  if (scopedPartIds.has(part.id)) throw new Error(`资源包内重复零件 ID: ${part.id}`)
  scopedPartIds.add(part.id)
}

const index = { ...library, generatedAt: new Date().toISOString(), packages, parts, designs, warnings }
await fs.writeFile(path.join(libraryDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`资源包同步完成：${packages.length} 个包，${parts.length} 个零件，${designs.length} 个方案${warnings.length ? `，${warnings.length} 条提示` : ''}`)
for (const warning of warnings) console.warn(`- ${warning}`)
