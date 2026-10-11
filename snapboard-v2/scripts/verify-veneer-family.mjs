import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, logLevel: 'error' })
try {
  const { VENEER_FAMILIES, veneerFamily, veneerFamilyPatch } = await server.ssrLoadModule('/src/components/texture/veneerMaterials.ts')
  const { createDefaultBoardTexture } = await server.ssrLoadModule('/src/utils/boardTexture.ts')
  const original = { ...createDefaultBoardTexture(), surfaceMode: 'veneer', imageDataUrl: 'retained-art', textureThickness: .8,
    surfacePrintOverrides: { nozzleTempC: 250, fanPercent: 25 }, woodGrain: { ...createDefaultBoardTexture().woodGrain, seed: 42 } }
  assert.deepEqual(VENEER_FAMILIES.map(f => f.id), ['decorative', 'transparent', 'wood'])
  assert.equal(veneerFamily(original), 'decorative')
  assert.equal(veneerFamily({ ...original, surfaceMaterialKind: 'transparent-petg' }), 'transparent')
  assert.equal(veneerFamily({ ...original, surfaceMode: 'woodgrain', surfaceMaterialKind: 'transparent-petg' }), 'wood', '旧木纹工程优先按木纹归类')
  let texture = original
  for (const family of ['transparent', 'wood', 'decorative']) {
    const patch = veneerFamilyPatch(texture, family)
    texture = { ...texture, ...patch }
    assert.equal(veneerFamily(texture), family)
    assert.equal(texture.surfaceMode, family === 'wood' ? 'woodgrain' : 'veneer')
    assert.equal(texture.surfacePrintGoal, 'standard')
    for (const key of ['imageDataUrl', 'composition', 'woodGrain', 'surfacePrintOverrides', 'textureThickness', 'baseInfillDensity', 'baseMaterialName', 'surfaceFinish'])
      assert.deepEqual(texture[key], original[key], `${family} 切换保留 ${key}`)
  }
  const customized = { ...original, surfaceMaterialKind: 'transparent-petg', surfacePrintGoal: 'clear-experimental', surfaceMaterialName: '自定义透明料' }
  assert.deepEqual({ ...customized, ...veneerFamilyPatch(customized, 'transparent') }, { ...customized, enabled: true }, '重复选择同类不重置现有透明参数')
  console.log('Veneer families passed: three choices, legacy inference, correct mode transitions, custom settings and artwork preserved.')
} finally { await server.close() }
