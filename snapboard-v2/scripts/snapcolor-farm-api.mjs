import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createSnapColorPackage, readSnapColorNpz } from '../src/utils/snapColorPackage.ts'

const maxRequestBytes = 25 * 1024 * 1024
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const modeMap = { RYBW: 'rybw', CMYW: 'cmyw', '5-Color Extended (1444)': '5color' }
const layerCounts = { rybw: 5, cmyw: 5, '5color': 6 }
const activeTasks = new Map()
const cancelledTasks = new Set()

const readBody = async request => {
  let bytes = 0
  const chunks = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxRequestBytes) throw new Error('校色请求超过 25 MB')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('校色请求格式无效')
  return value
}

const runPython = (request, response) => new Promise((resolve, reject) => {
  if (request.taskId && activeTasks.has(request.taskId)) return reject(new Error('该校色任务正在处理，请等待或取消'))
  const localRuntime = path.resolve(process.cwd(), '../desktop/payload/python/python.exe')
  const python = process.env.SNAPBOARD_CALIBRATION_PYTHON || (existsSync(localRuntime) ? localRuntime : 'python')
  const script = process.env.SNAPBOARD_CALIBRATION_SCRIPT || path.resolve(process.cwd(), 'scripts/snapcolor_calibration_bridge.py')
  const child = spawn(python, [script], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (request.taskId) activeTasks.set(request.taskId, child)
  let output = '', errors = ''
  const timeout = setTimeout(() => { child.kill(); reject(new Error('校色任务超时')) }, 300_000)
  const disconnected = () => { if (!response.writableEnded) child.kill() }
  response.once('close', disconnected)
  child.stdout.on('data', chunk => { output += chunk; if (output.length > 2_000_000) child.kill() })
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000) })
  child.once('error', reject)
  child.once('close', code => {
    clearTimeout(timeout); response.off('close', disconnected)
    if (request.taskId) activeTasks.delete(request.taskId)
    try {
      if (request.taskId && cancelledTasks.delete(request.taskId)) throw new Error('校色任务已取消')
      if (code !== 0 || output.length > 2_000_000) throw new Error(errors || `Python 退出码 ${code}`)
      const result = JSON.parse(output)
      if (!result.ok) { if (errors) console.error(errors); throw new Error(result.error || '校色任务失败') }
      resolve(result)
    } catch (error) { reject(error) }
  })
  child.stdin.end(JSON.stringify(request))
})

const taskDirFor = async (root, id) => {
  if (!taskIdPattern.test(id || '')) throw new Error('校色任务 ID 无效')
  const directory = path.resolve(root, id)
  if (!(await fs.stat(directory).catch(() => null))?.isDirectory()) throw new Error('校色任务不存在')
  if (!(await fs.realpath(directory)).startsWith(await fs.realpath(root) + path.sep)) throw new Error('校色任务路径无效')
  return directory
}

/** Local-only Python bridge; packaged desktop passes its own runtime and vendor source paths. */
export const snapColorFarmApi = () => ({
  name: 'snapcolor-farm-calibration-api',
  configureServer(server) {
    const root = path.resolve(process.cwd(), '校色任务')
    const json = (res, status, value) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(value))
    }
    server.middlewares.use('/api/snapcolor/farm/file', async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: '仅支持 GET' })
        const query = new URL(req.url || '/', 'http://snapboard.local').searchParams
        const taskDir = await taskDirFor(root, query.get('taskId'))
        const name = query.get('name') || ''
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || name.startsWith('.')) throw new Error('文件名无效')
        const file = path.resolve(taskDir, name)
        if (!(await fs.realpath(file)).startsWith(await fs.realpath(taskDir) + path.sep)) throw new Error('文件路径无效')
        const data = await fs.readFile(file)
        res.setHeader('Content-Type', name.endsWith('.png') ? 'image/png' : name.endsWith('.3mf') ? 'model/3mf' : 'application/octet-stream')
        res.setHeader('Content-Length', data.length)
        if (!name.endsWith('.png')) res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
        res.end(data)
      } catch (error) { json(res, 400, { error: error.message }) }
    })
    server.middlewares.use('/api/snapcolor/farm', async (req, res) => {
      try {
        if (req.method === 'GET') {
          try { const result = await runPython({ action: 'status' }, res); return json(res, 200, { available: true, modes: result.modes || [] }) }
          catch (error) {
            const missing = /No module named ['"]([^'"]+)['"]/.exec(error.message)
            const reason = missing
              ? `本地校色 Python 缺少 ${missing[1]}；请使用带校色运行时的桌面包，或先构建桌面运行时。`
              : error.message
            return json(res, 200, { available: false, reason })
          }
        }
        if (req.method !== 'POST') return json(res, 405, { error: '仅支持 GET/POST' })
        const body = await readBody(req)
        const action = body.action
        if (!['create', 'generate', 'extract', 'fix', 'merge', 'package', 'cancel'].includes(action)) throw new Error('校色操作无效')
        await fs.mkdir(root, { recursive: true })
        if (action === 'create') {
          const taskId = randomUUID()
          await fs.mkdir(path.join(root, taskId))
          return json(res, 200, { taskId, message: '校色任务已创建' })
        }
        const taskId = body.taskId
        const taskDir = await taskDirFor(root, taskId)
        if (action === 'cancel') {
          const active = activeTasks.get(taskId)
          if (active) { cancelledTasks.add(taskId); active.kill() }
          return json(res, 200, { taskId, cancelled: Boolean(active), message: active ? '校色任务已取消' : '当前没有进行中的校色操作' })
        }
        const fileUrl = name => `/api/snapcolor/farm/file?taskId=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}`
        if (action === 'package') {
          if (!Object.hasOwn(modeMap, body.mode)) throw new Error('当前校色模式不能封装')
          const mode = modeMap[body.mode]
          const metadata = body.metadata || {}
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 32_000) throw new Error('校色工艺元数据无效或过大')
          const id = String(metadata.id || `farm-${taskId.slice(0, 8)}`).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
          const revision = String(metadata.revision || 'r001').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32)
          if (!id || !revision || !Array.isArray(body.materials)) throw new Error('档案 ID、修订和耗材映射缺失')
          let rgbNpy, stacksNpy
          if (mode === '5color') {
            ;({ rgbNpy, stacksNpy } = readSnapColorNpz(new Uint8Array(await fs.readFile(path.join(taskDir, 'merged-5color.npz')))))
          } else rgbNpy = new Uint8Array(await fs.readFile(path.join(taskDir, 'page-1.npy')))
          const photoHashes = {}
          for (const page of [1, 2]) {
            const photo = await fs.readFile(path.join(taskDir, `photo-page-${page}.img`)).catch(() => null)
            if (photo) photoHashes[`page${page}`] = createHash('sha256').update(photo).digest('hex')
          }
          const corrections = (await fs.readFile(path.join(taskDir, 'corrections.jsonl'), 'utf8').catch(() => ''))
            .split('\n').filter(Boolean).map(line => JSON.parse(line))
          const packaged = await createSnapColorPackage({
            manifest: {
              id, revision, name: String(metadata.name || id), mode,
              layerHeight: Number(metadata.layerHeightMm || 0.08), layerCount: layerCounts[mode],
              stackOrder: 'top-to-bottom', materials: body.materials,
              status: 'extracted', process: metadata,
              source: { taskId, generatedAt: new Date().toISOString(), photoHashes, corrections },
            },
            rgbNpy, stacksNpy,
          })
          const name = `${id}-${revision}.snapcolor`
          await fs.writeFile(path.join(taskDir, name), packaged)
          return json(res, 200, { taskId, message: 'SnapColor 档案已封装，待独立样卡验证', packageUrl: fileUrl(name), files: [{ name, url: fileUrl(name) }] })
        }
        const request = { ...body, taskDir }
        delete request.imageDataUrl
        if (action === 'extract') {
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.imageDataUrl || '')
          if (!match) throw new Error('请上传 PNG、JPG 或 WebP 校色照片')
          const image = Buffer.from(match[2], 'base64')
          if (!image.length || image.length > 16 * 1024 * 1024) throw new Error('照片不能超过 16 MB')
          const pageNumber = /2/.test(String(body.page)) ? 2 : 1
          request.imagePath = `photo-page-${pageNumber}.img`
          await fs.writeFile(path.join(taskDir, request.imagePath), image)
        }
        const result = await runPython({ ...request, action }, res)
        const files = (result.files || []).map(file => ({ name: file.name, url: fileUrl(file.name) }))
        json(res, 200, {
          taskId, message: result.message, pages: result.pages, cellCount: result.cellCount,
          invalidCells: result.invalidCells, dimensionsMm: result.dimensionsMm,
          previewUrl: result.previewFile ? fileUrl(path.basename(result.previewFile)) : undefined, files,
        })
      } catch (error) { json(res, 400, { error: error.message }) }
    })
  },
})
