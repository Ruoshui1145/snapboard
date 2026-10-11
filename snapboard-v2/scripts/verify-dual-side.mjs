import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const [{ useAppStore }, api, file] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/utils/boardTexture.ts'),
    server.ssrLoadModule('/src/utils/projectFile.ts'),
  ])
  const initial = useAppStore.getState()
  const image = 'data:image/svg+xml;base64,PHN2Zy8+'
  initial.setBoardTexture({ enabled: true, source: 'image', imageDataUrl: image, imageName: 'front.svg',
    backEnabled: true, backImageDataUrl: image, backImageName: 'legacy-back.svg', backRotation: 17 })
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture).rotation, 17)
  initial.setBoardTextureSide('back', { source: 'composition', composition: { schemaVersion: 1,
    assets: [{ id: 'a', name: 'back.svg', mime: 'image/svg+xml', dataUrl: image, width: 80, height: 80, aspect: 1, revision: 'r' }],
    layers: [{ id: 'l', kind: 'image', name: 'back.svg', assetId: 'a', visible: true, locked: false, opacity: 1,
      placement: { mode: 'free', fit: 'cover', crop: { x: 0, y: 0, width: 1, height: 1 },
        transform: { xMm: 30, yMm: 30, widthMm: 80, heightMm: 80, rotationDeg: 37, flipX: false, flipY: false } } }] },
    offsetX: 12, rotation: 42, brightness: 1.2, textureThickness: 0.8 })
  const state = useAppStore.getState()
  assert.equal(state.boardTexture.imageName, 'front.svg')
  assert.equal(state.boardTexture.rotation, 0)
  assert.equal(state.boardTexture.brightness, 1)
  assert.equal(api.backBoardTexture(state.boardTexture).composition.layers[0].placement.transform.rotationDeg, 37)
  assert.equal(api.backBoardTexture(state.boardTexture).rotation, 42)
  assert.equal(state.boardTexture.textureThickness, 0.8, 'both faces share physical layer thickness')
  assert.equal(state.textureSolve.status, 'dirty', 'back edits invalidate the colour result')
  initial.undo()
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture).imageName, 'legacy-back.svg')
  initial.redo()
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture).rotation, 42)
  const restored = file.parseProjectFile(file.serializeProjectFile({ project: state.project, boards: state.boards,
    placedParts: state.placedParts, splitConfig: state.splitConfig, splitResult: state.splitResult,
    boardTexture: state.boardTexture, assemblyMarking: state.assemblyMarking, assemblyScene: state.assemblyScene })).workspace.boardTexture
  assert.equal(api.backBoardTexture(restored).composition.layers[0].placement.transform.rotationDeg, 37)
  assert.equal(api.backBoardTexture(restored).brightness, 1.2)
  assert.equal(restored.backEnabled, true)
  initial.setBoardTextureSide('back', { enabled: false, source: 'composition', composition: { schemaVersion: 1, assets: [], layers: [] } })
  assert.equal(useAppStore.getState().boardTexture.enabled, true, 'clearing one face must retain the other face')
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture), null)
  initial.undo()
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture).rotation, 42)
  initial.setBoardTexture({ backEnabled: false })
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture), null)
  initial.setBoardTexture({ backEnabled: true })
  assert.equal(api.backBoardTexture(useAppStore.getState().boardTexture).rotation, 42)
  const panels = [{ id: 'left', x: 10, y: 0, w: 20, h: 30,
    contour: [{ x: 10, y: 0 }, { x: 30, y: 0 }, { x: 10, y: 30 }] },
  { id: 'right', x: 30, y: 0, w: 70, h: 30, contour: undefined }]
  const mirrored = api.texturePanelsForSide(panels, 'back')
  assert.equal(mirrored[0].x, 80)
  assert.equal(mirrored[1].x, 10)
  assert.deepEqual(api.texturePanelsForSide(mirrored, 'back'), panels)
  console.log('双面编辑/保存：正背资源与参数独立，共用制造参数，旧图片兼容、双面开关与全局坐标镜像通过')
} finally { await server.close() }
