import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: projectRoot, appType: 'custom', server: { middlewareMode: true } })
try {
  const [{ useAppStore }, { serializeProjectFile, parseProjectFile }] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/utils/projectFile.ts'),
  ])
  const state = useAppStore.getState()
  const workspace = {
    project: state.project,
    boards: state.boards,
    placedParts: state.placedParts,
    splitConfig: state.splitConfig,
    splitResult: state.splitResult,
    boardTexture: {
      ...state.boardTexture,
      enabled: true,
      source: 'image',
      imageDataUrl: 'data:image/png;base64,dGV4dHVyZQ==',
      imageName: '纹理.png',
      imageAspect: 1.5,
      rotation: 37,
      colorMode: 'posterize',
      colorCount: 5,
      surfaceMode: 'veneer',
      surfaceFinish: 'textured-pei',
      baseColor: '#F3F3EE',
      surfaceColor: '#A8CDBA',
      baseInfillDensity: 18,
    },
  }
  const parsed = parseProjectFile(serializeProjectFile(workspace))
  assert.equal(parsed.workspace.boardTexture.enabled, true)
  assert.equal(parsed.workspace.boardTexture.imageName, '纹理.png')
  assert.equal(parsed.workspace.boardTexture.rotation, 37)
  assert.equal(parsed.workspace.boardTexture.colorCount, 5)
  assert.equal(parsed.workspace.boardTexture.surfaceMode, 'veneer')
  assert.equal(parsed.workspace.boardTexture.surfaceFinish, 'textured-pei')
  assert.equal(parsed.workspace.boardTexture.surfaceColor, '#A8CDBA')
  assert.equal(parsed.workspace.boardTexture.baseInfillDensity, 18)

  const legacy = JSON.parse(serializeProjectFile(workspace))
  delete legacy.workspace.boardTexture
  const migrated = parseProjectFile(JSON.stringify(legacy))
  assert.equal(migrated.workspace.boardTexture.enabled, false)
  assert.equal(migrated.workspace.boardTexture.presetId, 'mono-checker')
  console.log('Texture project persistence verification passed')
} finally {
  await server.close()
}
