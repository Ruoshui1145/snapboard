import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { localSecurityPlugin } from './local-security.mjs'

// 方案 §4：本地制造进程是一条真实的作业 API——启动、报阶段、出文件、能取消。
// 这里用最小工程跑通全链路，防止 dev server 接口在重构中被悄悄弄坏。
// cacheDir 放到系统临时目录：vite 二次优化时会整删 deps 缓存，
// 默认位置 node_modules/.vite 在沙箱环境里删不动，直接把进程打挂。
const cacheDir = mkdtempSync(join(tmpdir(), 'snapboard-vite-cache-'))
const server = await createServer({ configFile:false, appType: 'custom', cacheDir, server: { middlewareMode: true, hmr:false } })
let devServer
try {
  const [{ PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }, { createDefaultBoardTexture }] = await Promise.all([
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/boardTexture.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220, thickness: 5, manufacturingChamfer: 0 }
  const panels = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }], holes: [] }, cfg).panels
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" width="60" height="60"><rect width="60" height="60" fill="#123466"/><circle cx="30" cy="30" r="18" fill="#ce8350"/></svg>'
  const texture = { ...createDefaultBoardTexture(), enabled: true, source: 'composition',
    composition: { layers: [{ id: 'l1', kind: 'image', name: 'verify.svg', visible: true, opacity: 1,
      assetId: 'svg-1', placement: { mode: 'free', crop: { x: 0, y: 0, width: 1, height: 1 },
        transform: { xMm: 30, yMm: 30, widthMm: 60, heightMm: 60, rotationDeg: 0, flipX: false, flipY: false } } }],
      assets: [{ id: 'svg-1', mime: 'image/svg+xml', width: 60, height: 60,
        dataUrl: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }] },
    modelingMode: 'vector', manufacturingContours: true, surfaceMode: 'snapcolor' }
  const snapshot = { panels, cfg, placedParts: [], boardTexture: texture,
    assemblyMarking: { enabled: false }, projectName: 'native process verification', projectVersion: '1.0.0' }

  // 起一个真实的 dev server：作业 API 挂在中间件上，必须真的监听端口。
  const { nativeManufactureApi } = await import('./native-manufacture-api.mjs')
  devServer = await createServer({ configFile:false, root: process.cwd(), plugins: [localSecurityPlugin(),nativeManufactureApi()], cacheDir,
    server: { host:'127.0.0.1',middlewareMode: false, port: 0, strictPort: false, hmr:false }, logLevel: 'silent' })
  await devServer.listen()
  const port = devServer.httpServer.address().port
  const endpoint = `http://127.0.0.1:${port}/api/native-manufacture`

  const capability = await (await fetch(endpoint)).json()
  assert.equal(capability.available, true, 'dev server 必须提供本地制造进程')
  for (const source of ['image', 'pattern']) {
    const unsupported = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panels, cfg, placedParts: [], boardTexture: { ...texture, source } }) })
    assert.equal(unsupported.status, 400, `${source} 不能静默产出纯基材配方`)
    assert.match((await unsupported.json()).error ?? '', /浏览器制造/)
  }

  const started = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) })
  const startedBody = await started.text()
  assert.ok(started.ok, `提交快照应当成功：${startedBody}`)
  const { jobId } = JSON.parse(startedBody)

  // 并发缺陷回归：installNativeRuntime 替换的是进程级 globalThis.fetch，并行作业会互相
  // 拆除对方的资产 shim。作业运行中再提交必须被明确拒绝，且运行中的作业不受影响。
  const busySubmit = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) })
  assert.equal(busySubmit.status, 409, '已有作业运行时必须拒绝新的提交')
  assert.match((await busySubmit.json()).error ?? '', /已有制造作业/, '拒绝信息必须说明已有作业在运行')
  assert.equal((await (await fetch(endpoint)).json()).busy, true, '作业运行中能力接口必须报告 busy')

  let status
  const stages = new Set()
  for (let attempt = 0; attempt < 600; attempt++) {
    status = await (await fetch(`${endpoint}?job=${jobId}`)).json()
    if (status.stage) stages.add(status.stage)
    if (status.error) throw new Error(`制造失败：${status.error}`)
    if (!status.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(status.running, false, '作业必须在超时前结束')
  assert.equal((await (await fetch(endpoint)).json()).busy, false, '作业结束后必须解除 busy')
  assert.ok(status.progress === 1, '完成时进度必须是 1')
  assert.ok(stages.size >= 3, `必须报告分阶段进度，实际只有 ${[...stages].join(' / ')}`)
  assert.equal(status.summary.panelCount, panels.length)
  assert.ok(status.summary.plateCount >= 1)
  assert.ok(status.pitchMm > 0.4, `间距必须来自动态预算，实际 ${status.pitchMm}`)

  const file = await fetch(`${endpoint}?job=${jobId}&result=1`)
  assert.ok(file.ok, '必须能取回 3MF')
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
  assert.ok(archive['3D/Objects/object_1.model'], '产物必须是完整 3MF')
  // 产物落盘后必须支持重复取回（浏览器可能重试/续传），且不得留在堆里。
  const fileAgain = await fetch(`${endpoint}?job=${jobId}&result=1`)
  assert.ok(fileAgain.ok, '产物必须可以重复取回')
  await fileAgain.arrayBuffer()
  const report = JSON.parse(strFromU8(archive['Metadata/snapboard-export-report.json']))
  assert.ok(report.textureSampling?.[0]?.gridPitchMm > 0.4, '导出报告必须记录动态间距')

  const transformed = structuredClone(snapshot)
  transformed.boardTexture.composition.layers[0].opacity = 0.7
  transformed.boardTexture.composition.layers[0].placement.transform.rotationDeg = 37
  transformed.boardTexture.composition.layers[0].placement.crop = { x: .1, y: .05, width: .8, height: .9 }
  const transformedStart = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(transformed) })
  assert.ok(transformedStart.ok, `旋转裁切图层提交失败：HTTP ${transformedStart.status}`)
  const transformedJob = (await transformedStart.json()).jobId
  let transformedStatus
  for (let attempt = 0; attempt < 900; attempt++) {
    transformedStatus = await (await fetch(`${endpoint}?job=${transformedJob}`)).json()
    if (transformedStatus.error) throw new Error(`旋转裁切图层制造失败：${transformedStatus.error}`)
    if (!transformedStatus.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(transformedStatus.running, false)
  assert.equal(transformedStatus.summary.panelCount, 1)
  const transformedArchive = unzipSync(new Uint8Array(await (await fetch(`${endpoint}?job=${transformedJob}&result=1`)).arrayBuffer()))
  assert.equal(JSON.parse(strFromU8(transformedArchive['Metadata/snapboard-export-report.json'])).textureContours.layers.length, 5,
    '旋转、裁切和透明度图层须进入全部光学层')

  // 配件路径必须用真实配件库跑通。这里曾经有两个只在配件阶段才暴露的缺陷：
  // 导出器用 /partLibrary/index.json 这类相对地址取资产（Node 里直接失败，整单静默回退），
  // 以及 three 的 FileLoader 依赖 ProgressEvent（缺失时抛出未捕获异常直接结束进程）。
  const library = JSON.parse(readFileSync(new URL('../public/partLibrary/index.json', import.meta.url), 'utf8'))
  const definition = library.parts?.[0]
  assert.ok(definition, '配件库必须有可测的配件')
  const withParts = {
    ...snapshot,
    placedParts: [{
      id: 'verify-part-1', defId: definition.id, rotation: 0, params: {},
      placement: { surface: 'split-panel', side: 'front', panelId: panels[0].id,
        position: [panels[0].x + panels[0].w / 2, panels[0].y + panels[0].h / 2, 0], rotationZ: 0, targetIds: [] },
    }],
  }
  const partsStart = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withParts) })
  const partsBody = await partsStart.text()
  assert.ok(partsStart.ok, `提交带配件的快照应当成功：${partsBody}`)
  const partsJob = JSON.parse(partsBody).jobId
  let partsStatus
  for (let attempt = 0; attempt < 900; attempt++) {
    partsStatus = await (await fetch(`${endpoint}?job=${partsJob}`)).json()
    if (partsStatus.error) throw new Error(`带配件的制造失败：${partsStatus.error}`)
    if (!partsStatus.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(partsStatus.running, false, '带配件的作业必须结束')
  assert.ok(!partsStatus.warnings.some(warning => /配件库读取失败|导入失败/.test(warning)),
    `配件必须能被制造进程读取：${partsStatus.warnings.join('; ')}`)
  assert.ok(partsStatus.summary.uniqueObjectCount >= 2,
    `配件实例必须实际进入 3MF，而不只是没有警告：uniqueObjectCount=${partsStatus.summary.uniqueObjectCount}`)

  // 盘名回归：板件盘必须直接用板号（P01…）命名，配件盘只叫「配件」，
  // 不得再出现与板号对不上的「第 N 盘」（盘序与 P 编号在多盘时必然错位）。
  const partsFile = await fetch(`${endpoint}?job=${partsJob}&result=1`)
  const partsArchive = unzipSync(new Uint8Array(await partsFile.arrayBuffer()))
  const partsSettings = strFromU8(partsArchive['Metadata/model_settings.config'])
  const plateNames = [...partsSettings.matchAll(/plater_name" value="([^"]+)"/g)].map(match => match[1])
  assert.ok(plateNames.some(name => /^SnapBoard 板件 P\d+$/.test(name)),
    `板件盘必须直接用板号命名：${plateNames.join(', ')}`)
  assert.ok(plateNames.some(name => /^SnapBoard 配件/.test(name)),
    `配件盘必须叫「配件」：${plateNames.join(', ')}`)
  assert.ok(!plateNames.some(name => /第 \d+ 盘/.test(name)),
    `盘名不得再出现「第 N 盘」：${plateNames.join(', ')}`)

  // 资产读取器路径回归：配件库里的中文名模型在 URL 中是百分号编码的，必须解码一次
  // 再查磁盘（否则全部 404）；同时拒绝坏编码与越界路径，错误信息要带上资产地址。
  const { installNativeRuntime } = await import('./native-recipe-raster.mjs')
  const restoreFetch = installNativeRuntime(process.cwd())
  try {
    const ascii = await fetch('/partLibrary/index.json')
    assert.ok(ascii.ok, `ASCII 资产必须可读：HTTP ${ascii.status}`)
    const encoded = new URL(`/partLibrary/${definition.model.print}`, 'http://snapboard.local').pathname
    assert.ok(encoded.includes('%'), '门禁资产必须覆盖百分号编码的中文路径')
    const unicode = await fetch(encoded)
    assert.ok(unicode.ok, `百分号编码的中文资产必须可读：HTTP ${unicode.status} ${unicode.ok ? '' : await unicode.text()}`)
    // 注意：WHATWG URL 解析会把 %2E%2E 直接归并成父级（不再是资产前缀，原样透传），
    // 所以越界测试用编码反斜杠构造"解析后仍像资产、解码后才露馅"的路径。
    const traversal = await fetch('/partLibrary/%5C..%5C..%5Cpackage.json')
    assert.equal(traversal.status, 403, '解码后越界的资产路径必须被拒绝')
    const malformed = await fetch('/partLibrary/%E4%B8')
    assert.equal(malformed.status, 400, '坏百分号编码必须返回明确错误')
  } finally {
    restoreFetch()
  }

  // 逐板导出回归：-Pxx.3mf 只能装对应这一块板，配件只能出现在 -配件.3mf。
  // 曾经循环里 ...payload 把整单 placedParts 摊进每块板，所有板件文件都多出一整套配件。
  const perPanel = { ...withParts, boardTexture: { ...texture, manufacturingOutput: 'perPanel' } }
  const bundleStart = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(perPanel) })
  const bundleStartBody = await bundleStart.text()
  assert.ok(bundleStart.ok, `提交逐板导出的快照应当成功：${bundleStartBody}`)
  const bundleJob = JSON.parse(bundleStartBody).jobId
  let bundleStatus
  for (let attempt = 0; attempt < 900; attempt++) {
    bundleStatus = await (await fetch(`${endpoint}?job=${bundleJob}`)).json()
    if (bundleStatus.error) throw new Error(`逐板导出失败：${bundleStatus.error}`)
    if (!bundleStatus.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(bundleStatus.running, false, '逐板导出的作业必须结束')
  const bundleFile = await fetch(`${endpoint}?job=${bundleJob}&result=1`)
  assert.ok(bundleFile.ok, '必须能取回分板压缩包')
  const bundle = unzipSync(new Uint8Array(await bundleFile.arrayBuffer()))
  const panelEntries = Object.keys(bundle).filter(name => /-P\d+\.3mf$/i.test(name))
  const partsEntry = Object.keys(bundle).find(name => name.endsWith('-配件.3mf'))
  assert.equal(panelEntries.length, panels.length, `每块板必须各出一个文件：${Object.keys(bundle).join(', ')}`)
  assert.ok(partsEntry, '配件必须单独出 -配件.3mf')
  const objectsXml = (entry) => Object.entries(unzipSync(bundle[entry]))
    .filter(([name]) => name.startsWith('3D/Objects/')).map(([, bytes]) => strFromU8(bytes)).join('')
  for (const entry of panelEntries) {
    assert.ok(!objectsXml(entry).includes(definition.name), `${entry} 不得包含配件 ${definition.name}`)
  }
  assert.ok(objectsXml(partsEntry).includes(definition.name), `-配件.3mf 必须包含配件 ${definition.name}`)

  const missingPart = { ...perPanel, placedParts: [{ ...withParts.placedParts[0], defId: 'missing-print-model' }] }
  const missingStart = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(missingPart) })
  assert.ok(missingStart.ok)
  const missingJob = (await missingStart.json()).jobId
  let missingStatus
  for (let attempt = 0; attempt < 900; attempt++) {
    missingStatus = await (await fetch(`${endpoint}?job=${missingJob}`)).json()
    if (!missingStatus.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(missingStatus.running, false)
  assert.match(missingStatus.error ?? '', /找不到配件定义|配件仅生成/, '完整逐板导出缺件时必须失败')
  assert.equal(missingStatus.bytes, 0, '缺件不得留下误称完整的 ZIP')

  // 逐板导出的背面标识回归：板号与 J 接缝贴边标识依赖**整单**邻接关系。
  // 曾经逐板调用只喂单板，结果每块板都被刻成 P01，且完全没有接缝标识。
  const { createDefaultAssemblyMarking } = await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
  const quadPanels = splitOrthogonalPolygon({ points: [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 0, y: 200 },
  ], holes: [] }, cfg).panels
  assert.ok(quadPanels.length >= 2, '测试夹具必须产生多块相邻板')
  const quadSnapshot = { ...snapshot, panels: quadPanels, placedParts: [],
    assemblyMarking: { ...createDefaultAssemblyMarking(), includeSeamIds:true },
    boardTexture: { ...texture, manufacturingOutput: 'perPanel' } }
  const quadStart = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quadSnapshot) })
  const quadStartBody = await quadStart.text()
  assert.ok(quadStart.ok, `提交带标识的逐板快照应当成功：${quadStartBody}`)
  const quadJob = JSON.parse(quadStartBody).jobId
  let quadStatus
  for (let attempt = 0; attempt < 900; attempt++) {
    quadStatus = await (await fetch(`${endpoint}?job=${quadJob}`)).json()
    if (quadStatus.error) throw new Error(`带标识的逐板导出失败：${quadStatus.error}`)
    if (!quadStatus.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(quadStatus.running, false, '带标识的逐板作业必须结束')
  const quadBundle = unzipSync(new Uint8Array(await (await fetch(`${endpoint}?job=${quadJob}&result=1`)).arrayBuffer()))
  const quadPanelEntries = Object.keys(quadBundle).filter(name => /-P\d+\.3mf$/i.test(name))
  assert.equal(quadPanelEntries.length, quadPanels.length, '每块板必须各出一个文件')
  const engravedCodes = new Set()
  for (const entry of quadPanelEntries) {
    const inner = unzipSync(quadBundle[entry])
    const map = JSON.parse(strFromU8(inner['Metadata/snapboard-assembly-map.json']))
    assert.ok(map.seams.length >= 1, `${entry} 必须带整单接缝信息`)
    const report = JSON.parse(strFromU8(inner['Metadata/snapboard-export-report.json']))
    const panelInstance = report.plates.flatMap(plate => plate.instances).find(instance => instance.kind === 'panel')
    const code = /^(P\d+) · /.exec(panelInstance?.name ?? '')?.[1]
    assert.ok(code, `${entry} 必须包含带板号的板件对象：${panelInstance?.name}`)
    assert.ok(panelInstance.backMarkingApplied, `${entry} 的背面标识必须实际写入`)
    engravedCodes.add(code)
    const settings = strFromU8(inner['Metadata/model_settings.config'])
    assert.ok(settings.includes(`plater_name" value="SnapBoard 板件 ${code}"`),
      `${entry} 的盘名必须是自己的板号：SnapBoard 板件 ${code}`)
    const plan = map.panels.find(panel => panel.panelId === code)
    assert.ok(plan, `装配图必须包含 ${code}`)
    assert.ok(plan.marks.some(mark => mark.kind === 'seam'), `${entry} 必须刻上 J 接缝贴边标识`)
  }
  assert.equal(engravedCodes.size, quadPanels.length,
    `每块板的背面刻字必须是自己的板号，不得重复：${[...engravedCodes].join(', ')}`)

  // Color samples always travel with their full original boards in one 3MF,
  // even when the normal output selector is set to per-panel ZIP.
  const sampleSnapshot = { ...snapshot,
    boardTexture: { ...texture, manufacturingOutput: 'perPanel' },
    textureSampling: { sizeMm: 20, locations: [{ panelIndex: 0, x: 30, y: 30 }] },
  }
  const sampleStart = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sampleSnapshot) })
  assert.ok(sampleStart.ok, `提交颜色试样应成功：HTTP ${sampleStart.status}`)
  const sampleJob = (await sampleStart.json()).jobId
  let sampleStatus
  for (let attempt = 0; attempt < 900; attempt++) {
    sampleStatus = await (await fetch(`${endpoint}?job=${sampleJob}`)).json()
    if (sampleStatus.error) throw new Error(`颜色试样制造失败：${sampleStatus.error}`)
    if (!sampleStatus.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(sampleStatus.running, false)
  assert.equal(sampleStatus.fileName, null, '试样不得交付分板 ZIP')
  assert.equal(sampleStatus.summary.sampleCount, 1)
  assert.ok(sampleStatus.summary.plateCount >= 2, '试样与完整原板必须同包')
  const sampleFile = await fetch(`${endpoint}?job=${sampleJob}&result=1`)
  assert.match(sampleFile.headers.get('content-type') ?? '', /model\/3mf/)
  assert.ok(unzipSync(new Uint8Array(await sampleFile.arrayBuffer()))['Metadata/snapboard-texture-samples.json'])

  // 取消：长操作必须能停，且不留半成品。
  const second = await (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) })).json()
  await fetch(`${endpoint}?job=${second.jobId}&cancel=1`, { method: 'POST' })
  let cancelled
  for (let attempt = 0; attempt < 300; attempt++) {
    cancelled = await (await fetch(`${endpoint}?job=${second.jobId}`)).json()
    if (!cancelled.running) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(cancelled.running, false, '取消后作业必须停止')
  assert.ok(cancelled.bytes === 0, '取消后不得留下半成品文件')

  console.log(JSON.stringify({ panels: panels.length, plates: status.summary.plateCount,
    partWarnings: partsStatus.warnings.filter(warning => /配件|导入/.test(warning)),
    pitchMm: +status.pitchMm.toFixed(4), stages: [...stages], bytes: file.headers.get('content-length') ?? 'stream',
    cancelLeavesArtifact: cancelled.bytes > 0 }, null, 1))
  console.log('verify:native-process OK')
} finally {
  await devServer?.close()
  await server.close()
}
