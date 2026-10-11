import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

/**
 * 方案 §4：本地制造进程。浏览器只冻结工程快照并显示进度，渲染、配方采样、共享边界与
 * 3MF 拼装都在这个 Node 进程里完成——那里没有主线程，也没有 canvas。
 *
 * 只挂 dev server（apply: 'serve'），因此不进入任何构建产物与发行包；打包留到阶段 E。
 * 用作业式接口而不是一次性请求：长操作要能报阶段、报进度、能取消。
 * 同时只允许一个作业：资产 shim 替换的是进程级 fetch，并行作业会互相拆台（见下）。
 *
 * 高精度（×4/×8）整单产物有数百 MB：绝不能把全部板件 3MF 攒在堆里再整体 zipSync，
 * 否则 dev server 的 V8 堆会被顶穿、进程直接死掉，浏览器只能看到 Failed to fetch。
 * 产物一律落盘（作业临时目录），拼包用流式存储 ZIP，回传从磁盘流式发送。
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
const JOB_TTL_MS = 30 * 60 * 1000

const readBody = async (req, maxBytes) => {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new Error(`工程快照不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    chunks.push(buffer)
  }
  if (!total) throw new Error('没有读取到工程快照')
  return Buffer.concat(chunks, total)
}

export function nativeManufactureApi() {
  return {
    name: 'snapboard-native-manufacture',
    apply: 'serve',
    configureServer(server) {
      const root = process.cwd()
      const jobs = new Map()
      const sweep = () => {
        const now = Date.now()
        for (const [id, job] of jobs) {
          if (!job.running && now - job.updatedAt > JOB_TTL_MS) {
            jobs.delete(id)
            if (job.tempDir) rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
          }
        }
      }

      const run = async (id, payload) => {
        const job = jobs.get(id)
        // 延迟加载：vite.config.ts 打包配置时不必解析 sharp 与 TS 模块。
        const { buildRecipeRaster, installNativeRuntime, nativeFetchScope } = await import('./native-recipe-raster.mjs')
        return nativeFetchScope.run(true, async () => {
        const restoreFetch = installNativeRuntime(root)
        try {
          job.stage = '正在加载制造模块…'
          const [{ createManufacturing3MF, configuredLineWidthMm }, { getSplitPanelTextureBounds }, { computeManufacturingBudget }] = await Promise.all([
            server.ssrLoadModule('/src/utils/export3mf.ts'),
            server.ssrLoadModule('/src/utils/boardTexture.ts'),
            server.ssrLoadModule('/src/utils/manufacturingBudget.ts'),
          ])
          const bounds = getSplitPanelTextureBounds(payload.panels)
          let raster
          if (payload.boardTexture?.enabled) {
          const budget = computeManufacturingBudget({
            panels: payload.panels,
            artAreaMm2: bounds.width * bounds.height,
            lineWidthMm: configuredLineWidthMm(),
            detail: payload.boardTexture?.samplingDetail,
          })
          if (!budget) throw new Error('没有可用的板件纹理范围')
          job.stage = `正在按 ${budget.pitchMm.toFixed(4)}mm 渲染纹理…`
          job.pitchMm = budget.pitchMm
          const started = Date.now()
          // 小于两个线宽的孤立色块，切片时只会变成"点点点"的微型挤出加换料
          // （堆料起球、打印失败），采样后直接归并进邻域主配方（实施日志 §8/§13.2）。
          const minFeatureMm = configuredLineWidthMm() * 2
          raster = await buildRecipeRaster(payload.boardTexture,
            { x: bounds.minX, y: bounds.minY, w: bounds.width, h: bounds.height }, budget.pitchMm, minFeatureMm)
          job.renderMs = Date.now() - started
          job.grid = [raster.width, raster.height]
          job.despeckle = raster.despeckle
          if (raster.despeckle.mergedCells > 0) {
            job.stage = `正在按 ${budget.pitchMm.toFixed(4)}mm 渲染纹理…（已归并 ${raster.despeckle.mergedComponents} 处杂色碎斑 / ${raster.despeckle.mergedCells} 格）`
          }
          } else { job.renderMs = 0 }
          const report = (message, progress) => {
            job.stage = message
            if (progress !== undefined) job.progress = Math.max(0, Math.min(1, progress))
            job.updatedAt = Date.now()
          }
          // A sample export includes both coupons and original boards in one 3MF.
          const outputMode = !payload.orderEngraving && !payload.textureSampling && payload.boardTexture?.manufacturingOutput === 'perPanel' ? 'perPanel' : 'single'
          if (outputMode === 'perPanel') {
            // 高精度下单文件会大到不好用，所以支持逐板出文件。配方网格与纹理范围仍是整单一份，
            // 每块板只是按自己的物理域裁剪——跨板颜色与接缝不会因独立取整错位（方案 §3.1/§4.2）。
            const { stablePanelIds } = await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
            const { Zip, ZipPassThrough } = await import('fflate')
            const codes = stablePanelIds(payload.panels)
            const base = String(payload.projectName || 'SnapBoard').replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, '').trim() || 'SnapBoard'
            const partCount = payload.panels.length + (payload.placedParts?.length ? 1 : 0)
            // ×8 时整包有数百 MB，攒在堆里会把 dev server 顶穿：每块板落盘即释放，最后流式拼包。
            const tempDir = await mkdtemp(join(tmpdir(), 'snapboard-native-'))
            job.tempDir = tempDir
            const entries = []
            const writeEntry = async (name, data) => {
              const target = join(tempDir, name)
              await writeFile(target, data)
              entries.push({ name, target })
            }
            const warnings = []
            let applied = 0
            let requested = 0
            const numbering={requested:0,applied:0,back:0,side:0,pocket:0,missing:[]}
            for (const [index, panel] of payload.panels.entries()) {
              const code = codes[index] ?? `P${String(index + 1).padStart(2, '0')}`
              job.stage = `正在生成第 ${index + 1}/${payload.panels.length} 块板（${code}）…`
              // 逐板文件只装这一块板：配件统一由后面的 -配件.3mf 交付，
              // 否则每块板都会带上整单全套配件，打印时全部重复。
              // 背面标识必须按整单邻接关系计算：不传 markingPanels 的话，每块板都会被
              // 刻成 P01，且完全得不到 J 接缝贴边标识。
              const single = await createManufacturing3MF({
                ...payload, panels: [panel], placedParts: [], textureBounds: bounds, nativeRecipeRaster: raster, outputMode: 'single',
                markingPanels: payload.panels,
                signal: job.controller.signal,
                onProgress: (message, fraction) => report(`${code}：${message}`, (index + (fraction ?? 0)) / partCount),
              })
              await single.cleanup?.()
              await writeEntry(`${base}-${code}.3mf`, single.data)
              applied += single.markingAppliedCount ?? 0
              requested += single.markingRequestedCount ?? 0
              if(single.numbering){for(const key of ['requested','applied','back','side','pocket'])numbering[key]+=single.numbering[key];numbering.missing.push(...single.numbering.missing)}
              for (const warning of single.warnings ?? []) {
                const message = /^J\d+ /.test(warning) ? warning : `${code}：${warning}`
                if (!warnings.includes(message)) warnings.push(message)
              }
            }
            if (payload.placedParts?.length) {
              job.stage = '正在生成配件…'
              const parts = await createManufacturing3MF({
                ...payload, panels: [], textureBounds: bounds, nativeRecipeRaster: raster, outputMode: 'single',
                signal: job.controller.signal,
                onProgress: (message, fraction) => report(`配件：${message}`, (payload.panels.length + (fraction ?? 0)) / partCount),
              })
              await parts.cleanup?.()
              if (parts.partCount !== payload.placedParts.length) throw new Error(`配件仅生成 ${parts.partCount}/${payload.placedParts.length} 件，已停止完整导出`)
              await writeEntry(`${base}-配件.3mf`, parts.data)
              warnings.push(...(parts.warnings ?? []).map(warning => `配件：${warning}`))
            }
            // 3MF 本身已是压缩包，再压一遍没有收益，用存储模式逐条流式写入：
            // 内存里同时只有当前这一条 3MF，不再出现"整包在堆里的 zipSync"。
            job.stage = '正在打包分板压缩包…'
            const bundlePath = join(tempDir, `${base}-分板.zip`)
            const output = createWriteStream(bundlePath)
            const archive = new Zip((error, chunk) => {
              if (error) { output.destroy(error); return }
              output.write(chunk)
            })
            try {
              for (const entry of entries) {
                job.controller.signal.throwIfAborted()
                const pass = new ZipPassThrough(entry.name)
                archive.add(pass)
                pass.push(await readFile(entry.target), true)
                if (output.writableLength > 16 * 1024 * 1024) await once(output, 'drain')
              }
              archive.end()
              output.end()
              await finished(output)
            } catch (error) {
              output.destroy()
              throw error
            }
            job.resultPath = bundlePath
            job.resultSize = (await stat(bundlePath)).size
            job.fileName = `${base}-分板.zip`
            job.summary = {
              plateCount: payload.panels.length, panelCount: payload.panels.length,
              uniqueObjectCount: payload.panels.length, markingRequestedCount: requested,
              markingAppliedCount: applied, numbering, sampleCount: 0, samplePlateCount: 0,
            }
            job.warnings = warnings
          } else {
          job.stage = '正在生成制造网格…'
          const result = await createManufacturing3MF({
            ...payload,
            nativeRecipeRaster: raster,
            outputMode: 'single',
            signal: job.controller.signal,
            onProgress: report,
          })
          await result.cleanup?.()
          const expectedParts = (payload.placedParts?.length ?? 0) * (payload.orderEngraving?.kitQuantity ?? 1)
          if (expectedParts && result.partCount !== expectedParts) throw new Error(`配件仅生成 ${result.partCount}/${expectedParts} 件，已停止完整导出`)
          // 单文件在高精度下约 1 GB：同样落盘回传，不让结果在堆里挂满 TTL。
          const tempDir = await mkdtemp(join(tmpdir(), 'snapboard-native-'))
          job.tempDir = tempDir
          job.resultPath = join(tempDir, 'result.3mf')
          await writeFile(job.resultPath, result.data)
          job.resultSize = (await stat(job.resultPath)).size
          job.fileName = result.fileName ?? null
          job.summary = {
            plateCount: result.plateCount, panelCount: result.panelCount, uniqueObjectCount: result.uniqueObjectCount,
            markingRequestedCount: result.markingRequestedCount, markingAppliedCount: result.markingAppliedCount, numbering: result.numbering,
            sampleCount: result.sampleCount, samplePlateCount: result.samplePlateCount,
          }
          job.warnings = result.warnings ?? []
          }
          job.stage = '完成'
          job.progress = 1
        } catch (error) {
          job.error = job.controller.signal.aborted
            ? '导出已取消'
            : (error instanceof Error ? error.message : String(error))
        } finally {
          restoreFetch()
          job.running = false
          job.updatedAt = Date.now()
          // 失败或取消的作业没有可交付产物，临时目录立刻清掉；成功的留到 sweep 过期清理。
          if (job.error && job.tempDir) {
            rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
            job.tempDir = undefined
            job.resultPath = undefined
          }
        }
        })
      }

      server.middlewares.use('/api/native-manufacture', async (req, res) => {
        const send = (code, body, type = 'application/json; charset=utf-8') => {
          res.statusCode = code
          res.setHeader('Content-Type', type)
          res.setHeader('Cache-Control', 'no-store')
          res.end(body)
        }
        try {
          const url = new URL(req.url ?? '/', 'http://snapboard.local')
          sweep()
          if (req.method === 'GET' && !url.searchParams.get('job')) {
            const active = [...jobs.values()].find(job => job.running)
            send(200, JSON.stringify({ available: true, mode: 'local-native', platform: process.platform,
              busy: Boolean(active), stage: active?.stage ?? null }))
            return
          }
          if (req.method === 'POST' && !url.searchParams.get('job')) {
            const payload = JSON.parse((await readBody(req, MAX_SNAPSHOT_BYTES)).toString('utf8'))
            if (!Array.isArray(payload.panels) || !payload.panels.length) throw new Error('快照缺少板件')
            if (payload.boardTexture?.enabled && payload.boardTexture.source !== 'composition') throw new Error('本地制造仅支持组合图层；单图和图案请使用浏览器制造')
            // installNativeRuntime 替换的是进程级 globalThis.fetch，并在结束时恢复启动时捕获的旧函数：
            // 并行作业会互相拆除对方的资产 shim（A 先结束会让仍在运行的 B 失去本地资产读取，
            // B 结束又把 A 的 shim 留在全局）。在改成不碰进程级 fetch 的作业隔离实现之前，
            // 同时只允许一个制造作业，第二个提交明确拒绝。
            const active = [...jobs.values()].find(job => job.running)
            if (active) {
              send(409, JSON.stringify({
                error: `已有制造作业正在运行（${active.stage || '进行中'}），请等待它完成或先取消后再提交`,
                busyJobId: active.id,
              }))
              return
            }
            const id = randomUUID()
            const job = { id, running: true, progress: 0, stage: '排队中', controller: new AbortController(), updatedAt: Date.now() }
            jobs.set(id, job)
            run(id, payload)
            send(200, JSON.stringify({ jobId: id }))
            return
          }
          const id = url.searchParams.get('job')
          const job = id ? jobs.get(id) : undefined
          if (!job) { send(404, JSON.stringify({ error: '作业不存在或已过期' })); return }
          if (req.method === 'POST' && url.searchParams.get('cancel')) {
            job.controller.abort()
            send(200, JSON.stringify({ ok: true }))
            return
          }
          if (url.searchParams.get('result')) {
            if (!job.data && !job.resultPath) { send(409, JSON.stringify({ error: job.error ?? '尚未生成' })); return }
            if (job.resultPath) {
              // 产物在磁盘上：流式回传，不把几百 MB 再读进堆。
              const info = await stat(job.resultPath).catch(() => null)
              if (!info) { send(409, JSON.stringify({ error: '产物文件已过期，请重新导出' })); return }
              res.statusCode = 200
              res.setHeader('Content-Type', job.fileName?.endsWith('.zip') ? 'application/zip' : 'model/3mf')
              res.setHeader('Cache-Control', 'no-store')
              res.setHeader('Content-Length', info.size)
              createReadStream(job.resultPath).pipe(res)
              return
            }
            send(200, job.data, 'model/3mf')
            return
          }
          send(200, JSON.stringify({
            jobId: job.id, running: job.running, progress: job.progress, stage: job.stage,
            error: job.error ?? null, warnings: job.warnings ?? [], summary: job.summary ?? null,
            fileName: job.fileName ?? null,
            bytes: job.data?.byteLength ?? job.resultSize ?? 0, pitchMm: job.pitchMm ?? null, grid: job.grid ?? null, renderMs: job.renderMs ?? null,
            despeckle: job.despeckle ?? null,
          }))
        } catch (error) {
          send(400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })
    },
  }
}
