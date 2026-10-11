import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, logLevel: 'error' })
try {
  const { useAppStore } = await server.ssrLoadModule('/src/store/useAppStore.ts')
  const { createDefaultBoardTexture } = await server.ssrLoadModule('/src/utils/boardTexture.ts')
  const front = { ...createDefaultBoardTexture(), enabled: true, source: 'image', imageDataUrl: 'front', surfaceMode: 'veneer',
    backTexture: { ...createDefaultBoardTexture(), source: 'image', imageDataUrl: 'back', rotation: 12 } }
  useAppStore.setState({ boardTexture: front, undoStack: [], redoStack: [] })
  const state = useAppStore.getState()
  state.setBoardTexture({ backEnabled: true })
  assert.equal(useAppStore.getState().boardTexture.surfaceMode, 'snapcolor')
  assert.equal(useAppStore.getState().boardTexture.backEnabled, true)
  assert.equal(useAppStore.getState().undoStack.length, 1, 'entering double colour is one atomic undo step')
  state.setUI({ textureEditSide: 'back' })
  state.setBoardTextureSide('back', { surfaceMode: 'veneer' })
  assert.equal(useAppStore.getState().boardTexture.backEnabled, false)
  assert.equal(useAppStore.getState().ui.textureEditSide, 'front')
  assert.equal(useAppStore.getState().undoStack.length, 2, 'opposing rapid mode clicks must not merge')
  state.undo()
  assert.equal(useAppStore.getState().boardTexture.backEnabled, true)
  assert.equal(useAppStore.getState().boardTexture.surfaceMode, 'snapcolor')
  state.undo()
  assert.equal(useAppStore.getState().boardTexture.surfaceMode, 'veneer')
  state.redo(); state.redo()
  assert.equal(useAppStore.getState().boardTexture.surfaceMode, 'veneer')
  state.setBoardTexture({ backEnabled: false, surfaceMode: 'snapcolor' })
  assert.equal(useAppStore.getState().boardTexture.surfaceMode, 'snapcolor')
  assert.equal(useAppStore.getState().boardTexture.backEnabled, false)
  state.setBoardTexture({ backEnabled: true })
  const result = useAppStore.getState().boardTexture
  assert.equal(result.imageDataUrl, 'front')
  assert.equal(result.backTexture.imageDataUrl, 'back')
  assert.equal(result.backTexture.rotation, 12)
  console.log('Mode switching passed: material → double → material → single → double, atomic undo/redo, active face and both images preserved')
} finally { await server.close() }
