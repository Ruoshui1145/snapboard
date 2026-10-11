import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: projectRoot, appType: 'custom', server: { middlewareMode: true } })
try {
  const [{ useAppStore }, { serializeProjectFile, parseProjectFile }, { paintTextureAvoidZonesRgba }] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/utils/projectFile.ts'),
    server.ssrLoadModule('/src/utils/boardTexture.ts'),
  ])
  const state = useAppStore.getState()
  assert.equal(state.boardTexture.brightness, 1, 'SnapColor 默认不得预先压暗导入图片')
  assert.equal(state.boardTexture.contrast, 1, 'SnapColor 默认不得对全部图片强制高对比')
  assert.equal(state.boardTexture.saturation, 1, 'SnapColor 默认应保持设计源色度')
  assert.equal(state.boardTexture.quantizeColors, 48, 'SnapColor 默认应保留 48 色设计调色板')
  assert.equal(state.boardTexture.hueWeight, 0.35, 'SnapColor 默认应保持色相保护权重')
  const workspace = {
    project: state.project,
    boards: state.boards,
    placedParts: state.placedParts,
    splitConfig: state.splitConfig,
    splitResult: state.splitResult,
    boardTexture: {
      ...state.boardTexture,
      enabled: true,
      imageDataUrl: 'data:image/png;base64,dGV4dHVyZQ==',
      imageName: '纹理.png',
      imageAspect: 1.5,
      rotation: 37,
      colorMode: 'posterize',
      colorCount: 5,
      surfaceMode: 'veneer',
      surfaceMaterialName: '透明 PETG',
      surfaceMaterialKind: 'transparent-petg',
      surfacePrintGoal: 'frosted',
      surfaceFilamentVendor: '测试料卷',
      surfacePrintOverrides: { nozzleTempC: 250, flowRatio: 1.01, maxFlowMm3s: 14, fanPercent: 20 },
      surfaceFinish: 'textured-pei',
      baseColor: '#F3F3EE',
      surfaceColor: '#A8CDBA',
      baseInfillDensity: 18,
      edgeSealEnabled: true,
      edgeSealWidth: 0.65,
      source: 'composition',
      composition: {
        schemaVersion: 1,
        assets: [{
          id: 'asset-a', name: 'A.png', mime: 'image/png', dataUrl: 'data:image/png;base64,dGV4dHVyZQ==',
          width: 10, height: 10, aspect: 1, revision: 'fixture-a',
        }],
        layers: [{
          id: 'layer-a', kind: 'image', name: 'A', assetId: 'asset-a', visible: true, locked: false, opacity: 0.8,
          placement: { mode: 'free', fit: 'contain', crop: { x: 0, y: 0, width: 1, height: 1 }, transform: { xMm: 50, yMm: 60, widthMm: 80, heightMm: 80, rotationDeg: 15, flipX: false, flipY: false } },
        }],
      },
      pattern: { ...state.boardTexture.pattern, id: 'hexagon', seed: 42, cellSizeMm: 18 },
      avoidZones: [{
        id: 'visual-core', name: '视觉核心', x: 0.25, y: 0.2,
        width: 0.5, height: 0.4, enabled: true,
      }],
    },
  }
  const parsed = parseProjectFile(serializeProjectFile(workspace))
  assert.equal(parsed.workspace.boardTexture.enabled, true)
  assert.equal(parsed.workspace.boardTexture.imageName, '纹理.png')
  assert.equal(parsed.workspace.boardTexture.rotation, 37)
  assert.equal(parsed.workspace.boardTexture.colorCount, 5)
  assert.equal(parsed.workspace.boardTexture.surfaceMode, 'veneer')
  assert.equal(parsed.workspace.boardTexture.surfaceMaterialKind, 'transparent-petg')
  assert.equal(parsed.workspace.boardTexture.surfacePrintGoal, 'frosted')
  assert.equal(parsed.workspace.boardTexture.surfaceFilamentVendor, '测试料卷')
  assert.deepEqual(parsed.workspace.boardTexture.surfacePrintOverrides, { nozzleTempC: 250, flowRatio: 1.01, maxFlowMm3s: 14, fanPercent: 20 })
  assert.equal(parsed.workspace.boardTexture.surfaceFinish, 'textured-pei')
  assert.equal(parsed.workspace.boardTexture.surfaceColor, '#A8CDBA')
  assert.equal(parsed.workspace.boardTexture.baseInfillDensity, 18)
  assert.equal(parsed.workspace.boardTexture.edgeSealEnabled, true)
  assert.equal(parsed.workspace.boardTexture.edgeSealWidth, 0.65)
  assert.equal(parsed.workspace.boardTexture.source, 'composition')
  assert.equal(parsed.workspace.boardTexture.composition.assets[0]?.id, 'asset-a')
  assert.equal(parsed.workspace.boardTexture.composition.layers[0]?.id, 'layer-a')
  assert.equal(parsed.workspace.boardTexture.composition.layers[0]?.opacity, 0.8)
  assert.equal(parsed.workspace.boardTexture.pattern.id, 'hexagon')
  assert.equal(parsed.workspace.boardTexture.pattern.seed, 42)
  assert.deepEqual(parsed.workspace.boardTexture.avoidZones, [{
    id: 'visual-core', name: '视觉核心', x: 0.25, y: 0.2,
    width: 0.5, height: 0.4, enabled: true,
  }])
  const dual = parseProjectFile(serializeProjectFile({ ...workspace,
    boardTexture: { ...workspace.boardTexture, surfaceMode: 'snapcolor', backEnabled: true,
      backImageDataUrl: 'data:image/png;base64,YmFjay1pbWFnZQ==', backImageName: '背面.png',
      backImageAspect: 1.25, backFit: 'contain', backScale: 130,
      backOffsetX: -12, backOffsetY: 8, backRotation: 90 },
    assemblyMarking: { ...state.assemblyMarking, sideLogoEnabled: true },
  }))
  assert.equal(dual.workspace.boardTexture.backEnabled, true)
  assert.equal(dual.workspace.boardTexture.backImageName, '背面.png')
  assert.equal(dual.workspace.boardTexture.backScale, 130)
  assert.equal(dual.workspace.boardTexture.backOffsetX, -12)
  assert.equal(dual.workspace.assemblyMarking.sideLogoEnabled, true)
  const paused = parseProjectFile(serializeProjectFile({ ...dual.workspace,
    boardTexture: { ...dual.workspace.boardTexture, backEnabled: false },
  }))
  assert.equal(paused.workspace.boardTexture.backEnabled, false)
  assert.equal(paused.workspace.boardTexture.backImageName, '背面.png', '切回单面不能删除背面图片')

  const pixels = new Uint8ClampedArray(4 * 4 * 4).fill(7)
  paintTextureAvoidZonesRgba(pixels, 4, 4, parsed.workspace.boardTexture.avoidZones, '#112233')
  const pixel = (x, y) => [...pixels.slice((y * 4 + x) * 4, (y * 4 + x + 1) * 4)]
  assert.deepEqual(pixel(1, 2), [17, 34, 51, 255], '避让区内像素必须回填为基材色')
  assert.deepEqual(pixel(0, 0), [7, 7, 7, 7], '避让区外像素不得改写')

  const legacy = JSON.parse(serializeProjectFile(workspace))
  delete legacy.workspace.boardTexture
  const migrated = parseProjectFile(JSON.stringify(legacy))
  assert.equal(migrated.workspace.boardTexture.enabled, false)
  assert.equal(migrated.workspace.boardTexture.presetId, 'mono-checker')
  assert.deepEqual(migrated.workspace.boardTexture.avoidZones, [])

  const legacyWithoutZones = JSON.parse(serializeProjectFile(workspace))
  delete legacyWithoutZones.workspace.boardTexture.avoidZones
  assert.deepEqual(parseProjectFile(JSON.stringify(legacyWithoutZones)).workspace.boardTexture.avoidZones, [])

  const legacyWithoutPrintGoal = JSON.parse(serializeProjectFile(workspace))
  delete legacyWithoutPrintGoal.workspace.boardTexture.surfaceMaterialKind
  delete legacyWithoutPrintGoal.workspace.boardTexture.surfacePrintGoal
  delete legacyWithoutPrintGoal.workspace.boardTexture.surfacePrintOverrides
  const migratedPrintGoal = parseProjectFile(JSON.stringify(legacyWithoutPrintGoal)).workspace.boardTexture
  assert.equal(migratedPrintGoal.surfaceMaterialKind, 'transparent-petg', '旧工程应从透明材料名称迁移材料类别')
  assert.equal(migratedPrintGoal.surfacePrintGoal, 'standard', '旧工程不应自动开启试验打印参数')
  assert.deepEqual(migratedPrintGoal.surfacePrintOverrides, {})

  legacyWithoutPrintGoal.workspace.boardTexture.surfaceMaterialName = '浅绿色 PETG 大理石'
  legacyWithoutPrintGoal.workspace.boardTexture.surfacePrintGoal = 'clear-experimental'
  legacyWithoutPrintGoal.workspace.boardTexture.surfacePrintOverrides = { nozzleTempC: 300 }
  const invalidPrintGoal = parseProjectFile(JSON.stringify(legacyWithoutPrintGoal)).workspace.boardTexture
  assert.equal(invalidPrintGoal.surfaceMaterialKind, 'decorative-petg')
  assert.equal(invalidPrintGoal.surfacePrintGoal, 'standard')
  assert.deepEqual(invalidPrintGoal.surfacePrintOverrides, {}, '越界校准值不可进入工程')

  const legacyWithoutEdgeSeal = JSON.parse(serializeProjectFile(workspace))
  delete legacyWithoutEdgeSeal.workspace.boardTexture.edgeSealEnabled
  delete legacyWithoutEdgeSeal.workspace.boardTexture.edgeSealWidth
  const migratedEdgeSeal = parseProjectFile(JSON.stringify(legacyWithoutEdgeSeal)).workspace.boardTexture
  assert.equal(migratedEdgeSeal.edgeSealEnabled, true, '旧工程默认启用基材单线封边')
  assert.equal(migratedEdgeSeal.edgeSealWidth, 0.5, '旧工程默认使用 0.5mm 单线封边')
  delete legacyWithoutEdgeSeal.workspace.boardTexture.manufacturingEdgeQuality
  assert.equal(parseProjectFile(JSON.stringify(legacyWithoutEdgeSeal)).workspace.boardTexture.manufacturingEdgeQuality, 'standard', '旧工程保留原制造路线')
  legacyWithoutEdgeSeal.workspace.boardTexture.manufacturingEdgeQuality = 'fine'
  assert.equal(parseProjectFile(JSON.stringify(legacyWithoutEdgeSeal)).workspace.boardTexture.manufacturingEdgeQuality, 'fine', '精细制造档保存后恢复')

  const legacyWithoutComposition = JSON.parse(serializeProjectFile(workspace))
  delete legacyWithoutComposition.workspace.boardTexture.composition
  delete legacyWithoutComposition.workspace.boardTexture.pattern
  const migratedComposition = parseProjectFile(JSON.stringify(legacyWithoutComposition)).workspace.boardTexture
  assert.deepEqual(migratedComposition.composition, { schemaVersion: 1, assets: [], layers: [] })
  assert.equal(migratedComposition.pattern.id, 'square')
  const legacyBranding = JSON.parse(serializeProjectFile(workspace))
  legacyBranding.workspace.boardTexture.surfaceMode = 'lumina'
  legacyBranding.workspace.boardTexture.lutId = 'aliz-petg-rybw'
  legacyBranding.workspace.boardTexture.modelingMode = 'vector'
  const migratedBranding = parseProjectFile(JSON.stringify(legacyBranding)).workspace.boardTexture
  assert.equal(migratedBranding.surfaceMode, 'snapcolor', '旧 surfaceMode 必须迁移到 SnapColor')
  assert.equal(migratedBranding.lutId, 'snapcolor-petg-rybw', '旧 Aliz LUT ID 必须迁移到 SnapColor ID')
  assert.equal(migratedBranding.modelingMode, 'vector', 'SVG 模式保存和重开后必须保留')
  legacyBranding.workspace.boardTexture.modelingMode = 'pixel'
  assert.equal(parseProjectFile(JSON.stringify(legacyBranding)).workspace.boardTexture.modelingMode, 'pixel')

  // Optional real traced SVG: verify resource/persistence only, not image decode or manufacturing.
  if (process.argv[2]) {
    const [{ textureAssetSizeError }, svg] = await Promise.all([
      server.ssrLoadModule('/src/utils/textureComposition.ts'), readFile(process.argv[2]),
    ])
    assert.equal(textureAssetSizeError(svg.length, 'image/svg+xml'), null)
    const originalHash = createHash('sha256').update(svg).digest('hex')
    const svgUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`
    const svgWorkspace = { ...workspace, boardTexture: { ...workspace.boardTexture,
      source: 'composition', imageDataUrl: '', surfaceMode: 'snapcolor', modelingMode: 'vector',
      colorMode: 'original', backEnabled: false,
      composition: {
        schemaVersion: 1,
        assets: [{ id: 'real-svg', name: path.basename(process.argv[2]), mime: 'image/svg+xml',
          dataUrl: svgUrl, width: 100, height: 100, aspect: 1, revision: originalHash }],
        layers: [{ ...workspace.boardTexture.composition.layers[0], id: 'real-svg-layer', assetId: 'real-svg' }],
      },
    } }
    const reopenedSvg = parseProjectFile(serializeProjectFile(svgWorkspace)).workspace.boardTexture
    assert.equal(reopenedSvg.modelingMode, 'vector')
    assert.equal(reopenedSvg.composition.assets.length, 1)
    assert.equal(reopenedSvg.composition.layers[0].assetId, 'real-svg')
    assert.equal(reopenedSvg.composition.assets[0].dataUrl, svgUrl, 'Large SVG data must survive project save/reopen unchanged')
    const recoveredHash = createHash('sha256').update(Buffer.from(reopenedSvg.composition.assets[0].dataUrl.split(',')[1], 'base64')).digest('hex')
    assert.equal(recoveredHash, originalHash)
    assert.equal(createHash('sha256').update(await readFile(process.argv[2])).digest('hex'), originalHash, 'Source SVG must remain untouched')
    const { textureVectorBudgetError, buildTextureVectorRegions } = await server.ssrLoadModule('/src/utils/textureVectorRegions.ts')
    assert.match(textureVectorBudgetError(reopenedSvg), /已在计算前停止/, 'A large imported SVG must not be admitted to unbounded vector parsing')
    const blocked = await buildTextureVectorRegions(reopenedSvg, { minX: 0, minY: 0, width: 100, height: 100 }, [])
    assert.equal(blocked.eligible, false)
    assert.match(blocked.reason, /已在计算前停止/, 'The real SVG must be rejected before DOMParser/SVGLoader, even without browser globals')
    const { installNativeSvgDom } = await import('./native-svg-dom.mjs')
    installNativeSvgDom()
    const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><title>颜色与曲线 🙂</title><rect width="100" height="100" fill="#123abc"/></svg>'
    const decoded = await buildTextureVectorRegions({ ...reopenedSvg, source: 'image', fit: 'stretch',
      opacity: 1, brightness: 1, contrast: 1, saturation: 1,
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(tinySvg).toString('base64')}`,
    }, { minX: 0, minY: 0, width: 100, height: 100 }, [])
    assert.equal(decoded.eligible, true, decoded.reason)
    assert.ok(decoded.regions.some(region => region.color === '#123abc'), 'bounded Base64 decoding must preserve UTF-8 SVG and its fill colors')
    console.log(`Real SVG resource/project roundtrip passed: ${(svg.length / 1024 / 1024).toFixed(2)} MiB, SHA256 preserved`)
    console.log('Real SVG vector memory admission guard and small UTF-8 Base64 vector decode passed; full manufacturing was not attempted')
  }
  console.log('Texture project persistence verification passed')
} finally {
  await server.close()
}
