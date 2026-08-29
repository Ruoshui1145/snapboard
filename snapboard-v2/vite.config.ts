import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { categoryFromDirName } from './scripts/part-category-rules.mjs'

let partSyncQueue: Promise<void> = Promise.resolve()

/**
 * 资源包同步会写回 part.json/pack.json。所有 API 和文件监听都必须走同一
 * 个队列，否则大量模型同时进入时会并发写 index.json，最终把 Vite 进程打死，
 * 前端看到的就是保存请求 Failed to fetch。
 */
const runPartSync = (root: string) => {
  const task = partSyncQueue.then(() => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(root, 'scripts', 'sync-part-library.mjs')], {
      cwd: root,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`配件库同步失败 (${code})`)))
  }))
  partSyncQueue = task.catch(() => undefined)
  return task
}

const userPackId = 'snapboard.user-imports'
const importModelExtensions = new Set(['.3mf', '.stl', '.glb', '.gltf'])
const usageImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const partCategories = new Set(['hook', 'bracket', 'shelf', 'bin', 'organizer', 'fastener', 'base', 'cable', 'custom'])

const safeFileSegment = (value: string, fallback: string) => {
  const cleaned = Array.from(value.replace(/[<>:"/\\|?*]/g, '-'))
    .map(char => char.charCodeAt(0) < 32 ? '-' : char)
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned || fallback
}

const parseDimensionsMm = (value: string | null): [number, number, number] | undefined => {
  if (!value) return undefined
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every(item => Number.isFinite(Number(item)) && Number(item) >= 0)) {
    throw new Error('模型尺寸元数据无效')
  }
  return parsed.map(Number) as [number, number, number]
}

const readRequestBuffer = async (req: import('node:http').IncomingMessage, maxBytes: number) => {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`模型不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new Error(`模型不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    chunks.push(buffer)
  }
  if (!total) throw new Error('没有读取到模型文件')
  return Buffer.concat(chunks, total)
}

const ensureUserPack = async (root: string) => {
  const packDir = path.resolve(root, '配件资源包', '我的配件')
  const partsDir = path.join(packDir, 'parts')
  await fs.mkdir(partsDir, { recursive: true })
  const packFile = path.join(packDir, 'pack.json')
  try {
    await fs.access(packFile)
  } catch {
    await fs.writeFile(packFile, JSON.stringify({
      schemaVersion: 1,
      id: userPackId,
      name: '我的配件',
      version: '1.0.0',
      author: 'Local User',
      license: 'Private',
      description: '从 SnapBoard 网页导入的本地模型。',
    }, null, 2) + '\n', 'utf8')
  }
  return { packDir, partsDir }
}

const findPartManifest = async (root: string, packageId: string, localId: string) => {
  const packsRoot = path.resolve(root, '配件资源包')
  let manifestPath = ''
  const walk = async (dir: string): Promise<void> => {
    if (manifestPath) return
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name === 'part.json') {
        try {
          const manifest = JSON.parse(await fs.readFile(full, 'utf8'))
          // 从 part.json 所在目录向上找到最近持有 pack.json 的“包根目录”。
          // 兼容两种布局: 传统 <包>/parts/<零件>/part.json
          //           与 大类目录根部 <包根>/<零件>/part.json (散文件归一化后的自动槽位)
          let probe = dir
          let packFile = ''
          while (!packFile && probe.startsWith(packsRoot + path.sep)) {
            const candidate = path.join(probe, 'pack.json')
            try { await fs.access(candidate); packFile = candidate } catch {}
            probe = path.dirname(probe)
          }
          if (!packFile) continue
          const pack = JSON.parse(await fs.readFile(packFile, 'utf8'))
          if (String(pack.id) === packageId && String(manifest.id) === localId) manifestPath = full
        } catch {
          // 忽略无法解析的 part.json
        }
      }
      if (manifestPath) return
    }
  }
  await walk(packsRoot)
  if (!manifestPath || !path.resolve(manifestPath).startsWith(packsRoot + path.sep)) throw new Error('找不到对应的 part.json')
  return manifestPath
}

const nextPartSortOrder = async (rootDir: string): Promise<number> => {
  let maxOrder = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[] = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name === 'part.json') {
        try {
          const manifest = JSON.parse(await fs.readFile(full, 'utf8'))
          const order = Number(manifest.sortOrder)
          if (Number.isFinite(order)) maxOrder = Math.max(maxOrder, order)
        } catch {}
      }
    }
  }
  await walk(rootDir)
  return Math.max(10, Math.ceil((maxOrder + 1) / 10) * 10)
}

/** 开发期监听根目录“配件资源包”：丢入/替换模型后自动重建网页目录。 */
const partLibraryWatcher = () => ({
  name: 'snapboard-part-library-watcher',
  configureServer(server: import('vite').ViteDevServer) {
    const root = process.cwd()
    const packsRoot = path.resolve(root, '配件资源包')
    let timer: ReturnType<typeof setTimeout> | undefined
    let syncing = false
    let dirtyWhileSyncing = false
    // 只监听会影响网页索引的资产文件；同步器自动写入的 part.json/pack.json
    // 和目录事件不再触发回环。UI/API 修改 manifest 时会显式调用 runPartSync。
    const watchedExtensions = new Set(['.3mf', '.stl', '.glb', '.gltf', '.step', '.stp', '.sldprt', '.x_t', '.x_b', '.png', '.jpg', '.jpeg', '.webp'])
    const startSync = () => {
      if (syncing) {
        dirtyWhileSyncing = true
        return
      }
      syncing = true
      dirtyWhileSyncing = false
      runPartSync(root)
        .catch(error => server.config.logger.error(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          syncing = false
          if (dirtyWhileSyncing) {
            dirtyWhileSyncing = false
            clearTimeout(timer)
            timer = setTimeout(startSync, 500)
          }
        })
    }
    server.watcher.add(packsRoot)
    const schedule = (_event: string, filename: string) => {
      const resolved = path.resolve(filename)
      if (!resolved.startsWith(packsRoot + path.sep)) return
      if (!watchedExtensions.has(path.extname(resolved).toLowerCase())) return
      if (syncing) {
        dirtyWhileSyncing = true
        return
      }
      clearTimeout(timer)
      timer = setTimeout(startSync, 500)
    }
    server.watcher.on('all', schedule)
    server.httpServer?.once('close', () => {
      clearTimeout(timer)
      server.watcher.off('all', schedule)
    })
  },
})

/** 本地建模工作流：把标定器确认的端面锚点安全写回对应 part.json。 */
const partCalibrationApi = () => ({
  name: 'snapboard-part-calibration-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use('/api/part-library/calibration', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 64 * 1024) throw new Error('标定数据过大')
        }
        const body = JSON.parse(raw)
        const packageId = String(body.packageId ?? '')
        const localId = String(body.localId ?? '')
        const anchors = Array.isArray(body.anchors) ? body.anchors : []
        const orientation = Array.isArray(body.orientation) ? body.orientation : [0, 0, 0]
        if (!packageId || !localId || anchors.length < 1 || anchors.length > 32) throw new Error('零件 ID 或锚点数量无效')
        if (orientation.length !== 3 || !orientation.every(Number.isFinite)) throw new Error('默认朝向无效')
        for (const anchor of anchors) {
          if (!Array.isArray(anchor.position) || anchor.position.length !== 3 || !anchor.position.every(Number.isFinite)) {
            throw new Error('锚点坐标无效')
          }
          if (!Array.isArray(anchor.accepts) || !anchor.accepts.every((kind: string) => ['slot', 'round', 'either'].includes(kind))) {
            throw new Error('锚点孔型无效')
          }
          if (anchor.normal !== undefined && (!Array.isArray(anchor.normal) || anchor.normal.length !== 3 || !anchor.normal.every(Number.isFinite))) {
            throw new Error('锚点端面法向无效')
          }
          if (anchor.axis !== undefined) {
            if (!Array.isArray(anchor.axis) || anchor.axis.length !== 2 || !anchor.axis.every(Number.isFinite)) throw new Error('长圆孔长轴无效')
            const length = Math.hypot(anchor.axis[0], anchor.axis[1])
            if (length < 0.5) throw new Error('长圆孔长轴长度无效')
            anchor.axis = [anchor.axis[0] / length, anchor.axis[1] / length]
          }
        }
        if (body.contactZ !== null && body.contactZ !== undefined && (!Number.isFinite(body.contactZ) || Math.abs(body.contactZ) > 10000)) {
          throw new Error('接触面坐标无效')
        }

        const root = process.cwd()
        const manifestPath = await findPartManifest(root, packageId, localId)
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
        manifest.model = { ...(manifest.model ?? {}), orientation }
        manifest.mount = {
          ...(typeof manifest.mount === 'object' ? manifest.mount : {}),
          mode: anchors.length > 1 ? 'multi' : 'single',
          anchors,
          calibrationRequired: false,
        }
        delete manifest.mount.expected
        // 接触面 (标定时点选的贴合端面局部 z): 装配时接触面与板面贴合
        if (Number.isFinite(body.contactZ)) manifest.mount.contactZ = Number(body.contactZ)
        else delete manifest.mount.contactZ
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        await runPartSync(root)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, manifest: path.relative(root, manifestPath) }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  },
})

/** 普通用户导入：接收浏览器选择/拖入的模型，写入“我的配件”并支持改名。 */
const partImportApi = () => ({
  name: 'snapboard-part-import-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use('/api/part-library/import', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      let createdDir = ''
      try {
        const url = new URL(req.url ?? '/', 'http://snapboard.local')
        const originalFilename = safeFileSegment(url.searchParams.get('filename') ?? '', 'model.3mf')
        const extension = path.extname(originalFilename).toLowerCase()
        if (!importModelExtensions.has(extension)) throw new Error('仅支持 3MF、STL、GLB 和独立 GLTF 模型')
        const name = String(url.searchParams.get('name') ?? '').trim()
        if (!name || name.length > 80) throw new Error('配件名称应为 1–80 个字符')
        const description = String(url.searchParams.get('description') ?? '').trim()
        if (description.length > 240) throw new Error('配件说明不能超过 240 个字符')
        const subcategory = safeFileSegment(String(url.searchParams.get('subcategory') ?? ''), '')
        if (subcategory.length > 40) throw new Error('细分文件夹名称不能超过 40 个字符')
        const dimensionsMm = parseDimensionsMm(url.searchParams.get('dimensionsMm'))
        const renderNode = String(url.searchParams.get('renderNode') ?? '')
        if (renderNode.length > 120 || (renderNode && !/^\d+(\/\d+)*$/.test(renderNode))) throw new Error('实际渲染对象路径无效')
        const requestedCategory = String(url.searchParams.get('category') ?? 'custom')
        let category = partCategories.has(requestedCategory) ? requestedCategory : 'custom'
        const model = await readRequestBuffer(req, 200 * 1024 * 1024)

        const root = process.cwd()
        // 目标位置: 指定 folder 时写入 "配件资源包/<大类目录>/<零件>/", 否则写入“我的配件”
        const categoryFolder = safeFileSegment(String(url.searchParams.get('folder') ?? ''), '')
        let partsDir: string
        let targetPackageId = userPackId
        if (categoryFolder) {
          category = categoryFromDirName(categoryFolder)
          const targetPackDir = path.resolve(root, '配件资源包', categoryFolder)
          if (!targetPackDir.startsWith(path.resolve(root, '配件资源包') + path.sep)) throw new Error('导入路径越界')
          const categoryPackFile = path.join(targetPackDir, 'pack.json')
          try { await fs.access(categoryPackFile) } catch {
            await fs.mkdir(targetPackDir, { recursive: true })
            const dirCategory = categoryFromDirName(categoryFolder)
            await fs.writeFile(categoryPackFile, JSON.stringify({
              schemaVersion: 1,
              id: `snapboard.category-${safeFileSegment(categoryFolder.toLowerCase().replace(/\s+/g, '-'), 'category')}`,
              name: categoryFolder,
              version: '1.0.0',
              author: 'Local User',
              license: 'Private',
              description: `“${categoryFolder}”大类目录：从网页导入的 ${dirCategory} 类配件。`,
            }, null, 2) + '\n', 'utf8')
          }
          const categoryPack = JSON.parse(await fs.readFile(categoryPackFile, 'utf8'))
          targetPackageId = String(categoryPack.id)
          // 大类目录采用 <大类>/<零件>/ 布局；不要创建空 parts/，否则同步器会误判为传统包。
          partsDir = subcategory ? path.join(targetPackDir, subcategory) : targetPackDir
          if (!partsDir.startsWith(targetPackDir + path.sep) && path.resolve(partsDir) !== path.resolve(targetPackDir)) throw new Error('细分文件夹路径越界')
        } else {
          const userPack = await ensureUserPack(root)
          partsDir = subcategory ? path.join(userPack.partsDir, subcategory) : userPack.partsDir
          if (!partsDir.startsWith(userPack.partsDir + path.sep) && path.resolve(partsDir) !== path.resolve(userPack.partsDir)) throw new Error('细分文件夹路径越界')
        }
        const slug = safeFileSegment(name.toLowerCase().replace(/\s+/g, '-'), 'part')
        let localId = `${slug}-${Date.now().toString(36)}`
        createdDir = path.resolve(partsDir, localId)
        let suffix = 2
        while (true) {
          try {
            await fs.mkdir(createdDir)
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            localId = `${slug}-${Date.now().toString(36)}-${suffix++}`
            createdDir = path.resolve(partsDir, localId)
          }
        }
        if (!createdDir.startsWith(path.resolve(partsDir) + path.sep)) throw new Error('导入路径越界')
        const filename = safeFileSegment(originalFilename, `model${extension}`)
        await fs.writeFile(path.join(createdDir, filename), model)
        const format = extension.slice(1)
        const isGltf = format === 'glb' || format === 'gltf'
        const manifest = {
          id: localId,
          name,
          category,
          ...(subcategory ? { subcategory } : {}),
          sortOrder: await nextPartSortOrder(partsDir),
          description: description || '从网页导入；请设置默认朝向与装配吸附点',
          kind: 'fixed',
          params: [],
          model: {
            preview: filename,
            print: ['3mf', 'stl'].includes(format) ? filename : undefined,
            format,
            unit: isGltf ? 'meter' : 'millimeter',
            upAxis: isGltf ? 'y' : 'z',
            scale: 1,
            orientation: [0, 0, 0],
            ...(dimensionsMm ? { dimensionsMm } : {}),
            ...(renderNode ? { renderNode } : {}),
          },
          mount: { mode: 'free', anchors: [], calibrationRequired: true },
          defaultRotation: 0,
        }
        await fs.writeFile(path.join(createdDir, 'part.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        await runPartSync(root)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, id: `${targetPackageId}:${localId}`, packageId: targetPackageId, localId, category }))
      } catch (error) {
        if (createdDir) {
          const root = process.cwd()
          const allowedRoot = path.resolve(root, '配件资源包') + path.sep
          if (createdDir.startsWith(allowedRoot)) await fs.rm(createdDir, { recursive: true, force: true }).catch(() => undefined)
        }
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })

    server.middlewares.use('/api/part-library/rename', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 8 * 1024) throw new Error('请求数据过大')
        }
        const body = JSON.parse(raw)
        const packageId = String(body.packageId ?? '')
        const localId = String(body.localId ?? '')
        const name = String(body.name ?? '').trim()
        const description = String(body.description ?? '').trim()
        const subcategory = safeFileSegment(String(body.subcategory ?? ''), '')
        const sortOrder = Math.max(0, Math.min(999999, Math.round(Number(body.sortOrder) || 0)))
        if (!packageId || !localId || !name || name.length > 80) throw new Error('配件名称应为 1–80 个字符')
        if (subcategory.length > 40) throw new Error('细分文件夹名称不能超过 40 个字符')
        if (description.length > 240) throw new Error('配件说明不能超过 240 个字符')
        const root = process.cwd()
        const manifestPath = await findPartManifest(root, packageId, localId)
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
        manifest.name = name
        manifest.description = description
        if (subcategory) manifest.subcategory = subcategory
        else delete manifest.subcategory
        manifest.sortOrder = sortOrder
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        await runPartSync(root)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, name, sortOrder }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })

    server.middlewares.use('/api/part-library/usage-image', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST 或 DELETE' }))
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://snapboard.local')
        const packageId = String(url.searchParams.get('packageId') ?? '')
        const localId = String(url.searchParams.get('localId') ?? '')
        if (!packageId || !localId) throw new Error('零件 ID 无效')
        const manifestPath = await findPartManifest(process.cwd(), packageId, localId)
        const partDir = path.dirname(manifestPath)
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

        const currentImage = typeof manifest.usageImage === 'string'
          ? path.basename(manifest.usageImage)
          : ''
        const removeUsageAssets = async (keep = '') => {
          const files = await fs.readdir(partDir)
          for (const file of files) {
            const extension = path.extname(file).toLowerCase()
            const stem = path.basename(file, path.extname(file)).toLowerCase()
            const isUsageAsset = usageImageExtensions.has(extension) &&
              (file === currentImage || /^(usage|assembly|install|photo|实装|安装)(-|$)/i.test(stem))
            if (isUsageAsset && file !== keep) await fs.rm(path.join(partDir, file), { force: true })
          }
        }

        if (req.method === 'DELETE') {
          await removeUsageAssets()
          delete manifest.usageImage
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
          await runPartSync(process.cwd())
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, removed: Boolean(currentImage) }))
          return
        }

        const originalFilename = safeFileSegment(url.searchParams.get('filename') ?? '', 'usage.png')
        const extension = path.extname(originalFilename).toLowerCase()
        if (!usageImageExtensions.has(extension)) throw new Error('实装示例图仅支持 PNG、JPG 或 WebP')
        const image = await readRequestBuffer(req, 10 * 1024 * 1024)
        // 每次使用新文件名，避免浏览器/DevTools 缓存继续显示旧照片。
        const filename = `usage-${Date.now().toString(36)}${extension}`
        await fs.writeFile(path.join(partDir, filename), image)
        await removeUsageAssets(filename)
        manifest.usageImage = filename
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        await runPartSync(process.cwd())
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, filename }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })

    server.middlewares.use('/api/part-library/preview', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 16 * 1024) throw new Error('预览设置数据过大')
        }
        const body = JSON.parse(raw)
        const packageId = String(body.packageId ?? '')
        const localId = String(body.localId ?? '')
        const direction = Array.isArray(body.direction) ? body.direction.map(Number) : []
        if (!packageId || !localId || direction.length !== 3 || !direction.every(Number.isFinite)) throw new Error('缩略图视角数据无效')
        const length = Math.hypot(direction[0], direction[1], direction[2])
        if (length < .1) throw new Error('缩略图视角方向无效')
        const manifestPath = await findPartManifest(process.cwd(), packageId, localId)
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
        manifest.model = { ...(manifest.model ?? {}), previewDirection: direction.map((value: number) => value / length) }
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        await runPartSync(process.cwd())
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, direction: manifest.model.previewDirection }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  },
})

/** 开发期自控: 网页端“退出系统”按钮 → 停止 dev server (便于测试重启逻辑) */
const systemControlApi = () => ({
  name: 'snapboard-system-control-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use('/api/system/shutdown', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true, message: 'dev server 即将退出，请重新双击启动脚本' }))
      setTimeout(() => {
        console.log('[snapboard] 收到网页端“退出系统”请求，正在退出…')
        process.exit(0)
      }, 350)
    })
    server.httpServer?.once('close', () => { /* 退出即可 */ })
  },
})

const savedProjectsDirName = '已保存项目'

const projectLibraryApi = () => ({
  name: 'snapboard-project-library-api',
  configureServer(server: import('vite').ViteDevServer) {
    const root = process.cwd()
    const libraryRoot = path.resolve(root, savedProjectsDirName)
    const resolveProjectFile = (requested: string) => {
      const filename = safeFileSegment(requested, '未命名项目.snapboard')
      const normalized = filename.toLowerCase().endsWith('.snapboard') ? filename : `${filename}.snapboard`
      const target = path.resolve(libraryRoot, normalized)
      if (!target.startsWith(libraryRoot + path.sep)) throw new Error('项目文件路径越界')
      return { target, filename: normalized }
    }

    server.middlewares.use('/api/project-library/save', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://snapboard.local')
        const { target, filename } = resolveProjectFile(url.searchParams.get('filename') ?? '')
        const data = await readRequestBuffer(req, 50 * 1024 * 1024)
        const parsed = JSON.parse(data.toString('utf8'))
        if (parsed?.format !== 'snapboard-project' || parsed?.schemaVersion !== 1) throw new Error('不是有效的 SnapBoard 项目文件')
        await fs.mkdir(libraryRoot, { recursive: true })
        await fs.writeFile(target, data)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, filename, folder: savedProjectsDirName }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })

    server.middlewares.use('/api/project-library/list', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 GET' }))
        return
      }
      try {
        await fs.mkdir(libraryRoot, { recursive: true })
        const files = await Promise.all((await fs.readdir(libraryRoot, { withFileTypes: true }))
          .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.snapboard'))
          .map(async entry => {
            const stat = await fs.stat(path.join(libraryRoot, entry.name))
            return { name: entry.name, updatedAt: stat.mtime.toISOString(), size: stat.size }
          }))
        files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        res.statusCode = 200
        res.end(JSON.stringify({ files }))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })

    server.middlewares.use('/api/project-library/open', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: '仅支持 GET' }))
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://snapboard.local')
        const { target } = resolveProjectFile(url.searchParams.get('filename') ?? '')
        const data = await fs.readFile(target)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(data)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        res.statusCode = code === 'ENOENT' ? 404 : 400
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: code === 'ENOENT' ? '项目文件不存在' : error instanceof Error ? error.message : String(error) }))
      }
    })

    server.middlewares.use('/api/project-library/export', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://snapboard.local')
        const requested = safeFileSegment(url.searchParams.get('filename') ?? '', 'SnapBoard.3mf')
        const filename = requested.toLowerCase().endsWith('.3mf') ? requested : `${requested}.3mf`
        const exportRoot = path.resolve(libraryRoot, '制造导出')
        const target = path.resolve(exportRoot, filename)
        if (!target.startsWith(exportRoot + path.sep)) throw new Error('制造文件路径越界')
        const data = await readRequestBuffer(req, 500 * 1024 * 1024)
        await fs.mkdir(exportRoot, { recursive: true })
        await fs.writeFile(target, data)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, filename, folder: `${savedProjectsDirName}/制造导出` }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  },
})

/** 配件库批处理: 批量移动分类 / 批量删除 (文件管理式操作, 目录级 rename/rm + 重同步) */
const partBatchApi = () => ({
  name: 'snapboard-part-batch-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use('/api/part-library/batch', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: '仅支持 POST' }))
        return
      }
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 512 * 1024) throw new Error('请求数据过大')
        }
        const body = JSON.parse(raw)
        const action = String(body.action ?? '')
        const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : []
        if (!ids.length) throw new Error('未选择零件')
        const category = partCategories.has(String(body.category ?? '')) ? String(body.category) : ''
        const folder = safeFileSegment(String(body.folder ?? ''), '我的配件')
        const root = process.cwd()
        const packsRoot = path.resolve(root, '配件资源包')
        const moved: string[] = []
        const failed: { id: string; error: string }[] = []
        const ensureCategoryPack = async (targetPackDir: string, categoryFolder: string) => {
          const packFile = path.join(targetPackDir, 'pack.json')
          try { await fs.access(packFile) } catch {
            await fs.mkdir(targetPackDir, { recursive: true })
            const dirCategory = categoryFromDirName(categoryFolder)
            await fs.writeFile(packFile, JSON.stringify({
              schemaVersion: 1,
              id: `snapboard.category-${safeFileSegment(categoryFolder.toLowerCase().replace(/\s+/g, '-'), 'category')}`,
              name: categoryFolder,
              version: '1.0.0',
              author: 'Local User',
              license: 'Private',
              description: `“${categoryFolder}”大类目录：从网页导入的 ${dirCategory} 类配件。`,
            }, null, 2) + '\n', 'utf8')
          }
        }
        if (action === 'reorder') {
          const orderEntries = Array.isArray(body.orders) ? body.orders : []
          const orders = new Map<string, number>(orderEntries.map((entry: { id?: unknown; sortOrder?: unknown }) => [
            String(entry?.id ?? ''),
            Math.max(0, Math.min(999999, Math.round(Number(entry?.sortOrder) || 0))),
          ]))
          for (const id of ids) {
            try {
              const separator = id.indexOf(':')
              if (separator <= 0 || !orders.has(id)) throw new Error('排序数据无效')
              const manifestPath = await findPartManifest(root, id.slice(0, separator), id.slice(separator + 1))
              const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
              manifest.sortOrder = orders.get(id)
              await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
              moved.push(id)
            } catch (error) {
              failed.push({ id, error: error instanceof Error ? error.message : String(error) })
            }
          }
        } else for (const id of ids) {
          try {
            const separator = id.indexOf(':')
            if (separator <= 0) throw new Error('零件 ID 无效')
            const manifestPath = await findPartManifest(root, id.slice(0, separator), id.slice(separator + 1))
            const partDir = path.dirname(manifestPath)
            if (!partDir.startsWith(packsRoot + path.sep)) throw new Error('路径越界')
            if (action === 'move-category') {
              if (!category) throw new Error('未提供目标分类')
              const targetPackDir = path.resolve(packsRoot, folder)
              if (!targetPackDir.startsWith(packsRoot + path.sep)) throw new Error('目标路径越界')
              if (path.resolve(targetPackDir) === path.resolve(partDir)) continue
              // 我的配件 = 传统 <包>/parts/<零件> 布局; 大类目录 = 根目录直挂 <零件>
              const isUserPack = folder === '我的配件'
              if (isUserPack) await fs.mkdir(path.join(targetPackDir, 'parts'), { recursive: true })
              else await ensureCategoryPack(targetPackDir, folder)
              const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
              const targetParent = path.join(targetPackDir, isUserPack ? 'parts' : '')
              if (path.resolve(targetParent) === path.resolve(path.dirname(partDir))) {
                manifest.category = category
                await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
                moved.push(id)
                continue
              }
              let targetDir = path.join(targetParent, path.basename(partDir))
              try {
                await fs.rename(partDir, targetDir)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                let suffix = 2
                let candidate = `${targetDir}-${suffix++}`
                while (await fs.access(candidate).then(() => true).catch(() => false)) candidate = `${targetDir}-${suffix++}`
                await fs.rename(partDir, candidate)
                targetDir = candidate
              }
              manifest.category = category
              await fs.writeFile(path.join(targetDir, 'part.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
              moved.push(id)
            } else if (action === 'delete') {
              await fs.rm(partDir, { recursive: true, force: true })
              moved.push(id)
            } else {
              throw new Error(`未知操作: ${action}`)
            }
          } catch (error) {
            failed.push({ id, error: error instanceof Error ? error.message : String(error) })
          }
        }
        await runPartSync(root)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, moved, failed }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  },
})

/** 配件大类下的细分文件夹管理；GET 用于导入弹框读取已有目录，删除由客户端二次确认。 */
const partGroupApi = () => ({
  name: 'snapboard-part-group-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use('/api/part-library/group', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      try {
        const categoryFolders: Record<string, string> = {
          hook: '01-挂钩类', bracket: '02-支架托架类', shelf: '03-搁板层板类', bin: '04-收纳容器类',
          organizer: '05-整理件类', fastener: '06-紧固锁扣类', base: '07-底座安装类', cable: '08-线缆整理类', custom: '我的配件',
        }
        const requestUrl = new URL(req.url ?? '/', 'http://snapboard.local')
        const queryCategory = partCategories.has(String(requestUrl.searchParams.get('category') ?? ''))
          ? String(requestUrl.searchParams.get('category'))
          : 'custom'
        const root = process.cwd()
        const packsRoot = path.resolve(root, '配件资源包')
        const categoryRootFor = (value: string) => value === 'custom'
          ? path.resolve(packsRoot, categoryFolders[value], 'parts')
          : path.resolve(packsRoot, categoryFolders[value])
        if (req.method === 'GET') {
          const category = queryCategory
          const categoryRoot = categoryRootFor(category)
          const groups: string[] = []
          let entries: import('node:fs').Dirent[] = []
          try { entries = await fs.readdir(categoryRoot, { withFileTypes: true }) } catch { entries = [] }
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue
            const groupDir = path.join(categoryRoot, entry.name)
            let children: import('node:fs').Dirent[] = []
            try { children = await fs.readdir(groupDir, { withFileTypes: true }) } catch { continue }
            // 大类根目录下的“零件目录”不是细分文件夹；真正的细分目录通常只包含零件子目录。
            const isPartDirectory = children.some(child => child.isFile()
              && (child.name === 'part.json' || importModelExtensions.has(path.extname(child.name).toLowerCase())))
            if (!isPartDirectory) groups.push(entry.name)
          }
          groups.sort((a, b) => a.localeCompare(b, 'zh-CN'))
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, category, groups }))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: '仅支持 GET 或 POST' }))
          return
        }
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 16 * 1024) throw new Error('请求数据过大')
        }
        const body = JSON.parse(raw)
        const action = String(body.action ?? '')
        const category = partCategories.has(String(body.category ?? '')) ? String(body.category) : queryCategory
        const name = safeFileSegment(String(body.name ?? '').trim(), '')
        if (!name || name.length > 40) throw new Error('细分文件夹名称应为 1–40 个字符')
        const categoryRoot = categoryRootFor(category)
        const groupDir = path.resolve(categoryRoot, name)
        if (!groupDir.startsWith(categoryRoot + path.sep)) throw new Error('细分文件夹路径越界')
        if (action === 'create') {
          await fs.mkdir(groupDir, { recursive: true })
        } else if (action === 'delete') {
          let entries: import('node:fs').Dirent[]
          try { entries = await fs.readdir(groupDir, { withFileTypes: true }) }
          catch { throw new Error('细分文件夹不存在') }
          if (entries.length > 0 && body.force !== true) throw new Error('该细分文件夹中仍有模型或子文件夹；确认后可连同内容一起删除')
          if (entries.length > 0) await fs.rm(groupDir, { recursive: true, force: true })
          else await fs.rmdir(groupDir)
        } else {
          throw new Error(`未知操作: ${action}`)
        }
        await runPartSync(root)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, action, category, name }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), partLibraryWatcher(), partCalibrationApi(), partImportApi(), partBatchApi(), partGroupApi(), projectLibraryApi(), systemControlApi()],
  base: process.env.VITE_BASE ?? '/',
  // 官网发布只需要品牌图标和打包后的页面，不把本地配件/模型资产复制到服务器；
  // 设计器模式仍使用完整 public/，以便本地装配与 3MF 导出。
  publicDir: process.env.VITE_PUBLIC_SITE_ONLY === '1' ? 'public-site' : 'public',
  server: {
    // 统一启动脚本和文档都使用 127.0.0.1；显式绑定 IPv4，避免 Windows
    // 将 localhost 解析到 ::1 后，浏览器访问 127.0.0.1 得到 Failed to fetch。
    host: '127.0.0.1',
    watch: {
      // 忽略编辑器原子保存临时目录与本地 Edge 调试用户目录；其中 Cookies 等文件会被
      // 浏览器独占锁定，若让 chokidar 递归监听会报 EBUSY 并直接退出 dev server。
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/.*.tmp/**', '**/.edge-debug*/**'],
    },
  },
})
