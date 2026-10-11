import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false } })
try {
  const [composition, textures, patterns, marks, store, file, split] = await Promise.all([
    server.ssrLoadModule('/src/utils/textureComposition.ts'), server.ssrLoadModule('/src/utils/boardTexture.ts'),
    server.ssrLoadModule('/src/utils/texturePatterns.ts'), server.ssrLoadModule('/src/utils/assemblyMarking.ts'),
    server.ssrLoadModule('/src/store/useAppStore.ts'), server.ssrLoadModule('/src/utils/projectFile.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
  ])
  const panel = { id: 'p1', x: 0, y: 0, w: 200, h: 100, slots: [], round_holes: [], edge_holes: [],
    contour: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }], roundIdx: [] }
  const svg = 'data:image/svg+xml;base64,PHN2Zy8+'
  const placement = { mode: 'free', autoFit: true, fit: 'cover', crop: composition.createDefaultTextureCrop(),
    transform: { xMm: 20, yMm: 30, widthMm: 40, heightMm: 60, rotationDeg: 0, flipX: false, flipY: false } }
  const common = { visible: true, locked: false, opacity: .8, placement }
  const source = { schemaVersion: 1, assets: [{ id: 'a', name: 'image.svg', mime: 'image/svg+xml', dataUrl: svg, width: 80, height: 80, aspect: 1, revision: 'a' }],
    layers: [{ ...common, id: 'image', name: '图片', kind: 'image', assetId: 'a' },
      { ...common, id: 'preset', name: '图案', kind: 'preset', presetId: 'mono-checker' },
      { ...common, id: 'pattern', name: '纹样', kind: 'pattern', pattern: patterns.createDefaultTexturePattern('hexagon') }] }
  const normalized = composition.normalizeTextureComposition(source)
  assert.equal(normalized.layers.length, 3)
  for (const layer of normalized.layers) {
    const resolved = composition.resolveTextureLayerPlacements(layer, [panel], { minX: 0, minY: 0, width: 200, height: 100 })[0]
    assert.deepEqual([resolved.transform.xMm, resolved.transform.yMm, resolved.transform.widthMm, resolved.transform.heightMm], [100, 50, 200, 100])
  }
  const distributed = composition.distributeTextureImages(normalized, [panel], 'sequence')
  assert.ok(distributed.layers.slice(0, -1).every(layer => !layer.visible))
  assert.deepEqual(composition.restoreTextureLayers(composition.normalizeTextureComposition(distributed), 'sequence'), normalized, 'leaving per-panel mode preserves every position and original visibility')
  const legacy = { ...textures.createDefaultBoardTexture(), enabled: true, source: 'image', imageDataUrl: svg, imageAspect: .5,
    fit: 'cover', scale: 120, offsetX: 15, offsetY: -10, rotation: 37, opacity: .6 }
  const adapted = textures.editableTextureComposition(legacy, [panel]).layers[0]
  assert.deepEqual([adapted.placement.transform.xMm, adapted.placement.transform.yMm, adapted.placement.transform.widthMm,
    adapted.placement.transform.heightMm, adapted.placement.transform.rotationDeg], [130, 40, 240, 480, -37])
  assert.equal(adapted.opacity, .6)
  const root = { ...textures.createDefaultBoardTexture(), enabled: true, source: 'composition', composition: normalized,
    backEnabled: true, backTexture: { ...textures.createDefaultBoardTexture(), enabled: true, source: 'image', imageDataUrl: svg } }
  const key = config => textures.textureCanvasKey(config, 2, [panel])
  const oldFront = key(root), oldBack = key(textures.boardTextureForSide(root, 'back'))
  const changed = { ...root, ...textures.boardTextureSidePatch(root, 'back', { rotation: 42 }) }
  assert.equal(key(changed), oldFront)
  assert.notEqual(key(textures.boardTextureForSide(changed, 'back')), oldBack)
  assert.equal(key({ ...root, textureThickness: 1.2, manufacturingOutput: 'perPanel' }), oldFront, 'physical settings do not repeat colour work')
  const marking = { ...marks.createDefaultAssemblyMarking(), backEngravingEnabled: true, sideLogoEnabled: true,
    reserveBackMarking: true, sideDepth: .18, sideTextHeight: 3, includeBrand: true, includePanelIds: true,
    includeSeamIds: false, includeOrientation: false, includeKitCode: false }
  assert.equal(marks.isBackEngravingEnabled(marking, root), true)
  const reserved = textures.backTextureForRendering(root, [panel], split.PEGBOARD_DEFAULT_CONFIG, marking)
  assert.ok(reserved.avoidZones.length > 0, 'rear assembly IDs reserve space in back artwork')
  // Current manufacturing rules keep brand/order side marks independent of rear artwork.
  const sideOnly = textures.backTextureForRendering(root, [panel], split.PEGBOARD_DEFAULT_CONFIG,
    { ...marking, includePanelIds: false })
  assert.equal(sideOnly.avoidZones.length, 0, 'a side logo alone must not erase rear artwork')
  const unreserved = { ...marking, reserveBackMarking: false }
  assert.equal(marks.buildSurfaceMarkingPlan([panel], split.PEGBOARD_DEFAULT_CONFIG, unreserved, root).panels[0].engravingPolygons.length, 0)
  const state = store.useAppStore.getState()
  state.setBoardTexture(root)
  state.setUI({ textureEditSide: 'front' })
  state.setBoardTextureSide('back', { offsetX: 12 })
  assert.equal(store.useAppStore.getState().ui.textureEditSide, 'front', 'pending back edits cannot steal the selected front face')
  state.setAssemblyMarking(marking)
  const ready = store.useAppStore.getState()
  const saved = file.parseProjectFile(file.serializeProjectFile({ project: ready.project, boards: ready.boards, placedParts: ready.placedParts,
    splitConfig: ready.splitConfig, splitResult: ready.splitResult, spatialLayout: ready.spatialLayout,
    assemblyScene: ready.assemblyScene, boardTexture: root, assemblyMarking: marking })).workspace
  assert.equal(saved.boardTexture.composition.layers[2].kind, 'pattern')
  assert.equal(saved.boardTexture.composition.layers[0].placement.autoFit, true)
  assert.equal(saved.assemblyMarking.backEngravingEnabled, true)
  assert.equal(saved.assemblyMarking.sideLogoEnabled, true)
  assert.equal(saved.assemblyMarking.sideDepth, .18)
  state.setAssemblyMarking({ backEngravingEnabled: false })
  state.undo()
  assert.equal(store.useAppStore.getState().assemblyMarking.backEngravingEnabled, true)
  console.log('统一工作台：混合图层、整幅跟随板型、原排列恢复、旧图旋转/透明度、分面配色缓存、两种凹刻独立保存和撤销通过')
} finally { await server.close() }
