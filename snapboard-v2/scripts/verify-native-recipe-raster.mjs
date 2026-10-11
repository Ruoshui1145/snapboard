import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { createServer } from 'vite'

const originalFetch = globalThis.fetch
globalThis.fetch = async input => {
  const asset = String(input)
  if (!asset.startsWith('/snapcolor/luts/') || asset.includes('..')) throw new Error(`Unexpected LUT asset: ${asset}`)
  return new Response(readFileSync(join(process.cwd(), 'public', asset)), { status: 200 })
}
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const [{ createManufacturing3MF }, { createDefaultBoardTexture }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }] = await Promise.all([
    server.ssrLoadModule('/src/utils/export3mf.ts'), server.ssrLoadModule('/src/utils/boardTexture.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220, cornerRadius: 0 }
  const panel = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], holes: [] }, cfg).panels[0]
  assert.ok(panel)
  const nativeRecipeRaster = { width: 201, height: 201, pitchMm: 0.5, recipeIds: new Uint16Array(201 * 201) }
  const input = { panels: [panel], cfg, placedParts: [], boardTexture: { ...createDefaultBoardTexture(), enabled: true,
    source: 'preset', modelingMode: 'vector', manufacturingContours: true, surfaceMode: 'snapcolor' }, nativeRecipeRaster }
  await assert.rejects(createManufacturing3MF({ ...input, nativeRecipeRaster: { ...nativeRecipeRaster, width: 200 } }), /尺寸或间距/)
  // 阶段 A 的动态 PPI 在大工程上大于 0.5mm，不能被写死的上限挡住。
  const dynamicPitch = 0.51653
  const dynamicSide = Math.ceil(panel.w / dynamicPitch) + 1
  await createManufacturing3MF({ ...input, nativeRecipeRaster: {
    width: dynamicSide, height: dynamicSide, pitchMm: dynamicPitch,
    recipeIds: new Uint16Array(dynamicSide * dynamicSide),
  } })
  // 间距不得大于纹理范围短边：再大就连两个样点都放不下。
  await assert.rejects(createManufacturing3MF({ ...input, nativeRecipeRaster: {
    width: 2, height: 2, pitchMm: panel.w + 1, recipeIds: new Uint16Array(4),
  } }), /尺寸或间距/)
  const generated = await createManufacturing3MF(input)
  const archive = unzipSync(generated.data)
  const settings = strFromU8(archive['Metadata/model_settings.config'])
  assert.match(settings, /基材单线封边墙/)
  assert.match(settings, /SnapColor/)
  assert.equal(generated.panelCount, 1)
  assert.equal(generated.plateCount, 1)
  assert.equal(generated.warnings.length, 0)
  const large = await createManufacturing3MF({ ...input, boardTexture: { ...input.boardTexture,
    source: 'composition', composition: { schemaVersion: 1,
      assets: [{ id: 'large', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,' + 'A'.repeat(34 * 1024 * 1024) }],
      layers: [{ kind: 'image', visible: true, assetId: 'large' }],
    },
  } })
  assert.equal(large.panelCount, 1, 'an already prepared valid native recipe grid must not reparse large SVG data')
  console.log('Native recipe-raster 3MF regression passed: one closed board, seal and optical layers without browser canvas')
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}
