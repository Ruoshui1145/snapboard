import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: projectRoot, appType: 'custom', server: { middlewareMode: true } })

const png = value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`
const asset = (id, value = id) => ({
  id, name: id, mime: 'image/png', dataUrl: png(value), width: 100, height: 50, aspect: 2, revision: `rev-${id}`,
})
const crop = { x: 0, y: 0, width: 1, height: 1 }
const baseLayer = { visible: true, locked: false, opacity: 1 }
const panels = [
  { id: 'top-left', x: 0, y: 100, w: 100, h: 100 },
  { id: 'top-right', x: 100, y: 100, w: 100, h: 100 },
  { id: 'bottom-left', x: 0, y: 0, w: 100, h: 100 },
  { id: 'bottom-right', x: 100, y: 0, w: 100, h: 100 },
  { id: 'far-right', x: 200, y: 0, w: 100, h: 100 },
]

try {
  const {
    createDefaultTextureComposition,
    migrateLegacySingleImageTexture,
    normalizeTextureComposition,
    textureAssetSizeError,
    MAX_TEXTURE_ASSET_BYTES,
    MAX_TEXTURE_TOTAL_BYTES,
    MAX_TEXTURE_SVG_ASSET_BYTES,
    MAX_TEXTURE_SVG_TOTAL_BYTES,
    resolvePanelSequenceAssignments,
    resolvePerPanelPlacements,
    resolveRepeatPlacements,
    resolveTextureLayerPlacements,
  } = await server.ssrLoadModule('/src/utils/textureComposition.ts')

  assert.deepEqual(createDefaultTextureComposition(), { schemaVersion: 1, assets: [], layers: [] })

  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(textureAssetSizeError(MAX_TEXTURE_ASSET_BYTES, mime), null)
    assert.equal(textureAssetSizeError(MAX_TEXTURE_ASSET_BYTES + 1, mime), '图片不能超过 16 MB')
  }
  assert.equal(textureAssetSizeError(100 * 1024 * 1024, 'image/svg+xml'), null)
  assert.equal(textureAssetSizeError(MAX_TEXTURE_SVG_ASSET_BYTES, 'image/svg+xml'), null)
  assert.equal(textureAssetSizeError(MAX_TEXTURE_SVG_ASSET_BYTES + 1, 'image/svg+xml'), 'SVG 文件不能超过 128 MB')
  for (const bytes of [NaN, Infinity, -1]) assert.equal(textureAssetSizeError(bytes, 'image/svg+xml'), '素材大小无效')

  // Capacity fixtures only: they need not be decodable pictures.
  const sizeAsset = (id, mime, bytes) => ({ ...asset(id), mime,
    dataUrl: `data:${mime};base64,${Buffer.alloc(bytes, 65).toString('base64')}` })
  const rasterLimit = sizeAsset('raster', 'image/png', MAX_TEXTURE_ASSET_BYTES)
  const overRaster = sizeAsset('large-svg', 'image/svg+xml', MAX_TEXTURE_ASSET_BYTES + 1)
  const independent = normalizeTextureComposition({ assets: [
    ...Array.from({ length: MAX_TEXTURE_TOTAL_BYTES / MAX_TEXTURE_ASSET_BYTES + 1 }, (_, i) => ({ ...rasterLimit, id: `raster-${i}` })),
    overRaster,
    { ...overRaster, id: 'oversize-raster', mime: 'image/svg+xml', dataUrl: overRaster.dataUrl.replace('image/svg+xml', 'image/png') },
  ], layers: [] })
  assert.deepEqual(independent.assets.map(a => a.id), ['raster-0', 'raster-1', 'raster-2', 'raster-3', 'large-svg'],
    'SVG must not consume the raster pool; data-URL MIME must enforce the raster limit even when asset.mime is forged')
  const svgLimit = sizeAsset('svg-limit', 'image/svg+xml', MAX_TEXTURE_SVG_ASSET_BYTES)
  const svgPool = normalizeTextureComposition({ assets: [
    ...Array.from({ length: MAX_TEXTURE_SVG_TOTAL_BYTES / MAX_TEXTURE_SVG_ASSET_BYTES + 1 }, (_, i) => ({ ...svgLimit, id: `svg-${i}` })),
    asset('small-raster'),
  ], layers: [] })
  assert.deepEqual(svgPool.assets.map(a => a.id), ['svg-0', 'svg-1', 'small-raster'], 'SVG total must be bounded without consuming raster capacity')
  assert.equal(normalizeTextureComposition({ assets: [sizeAsset('too-large', 'image/svg+xml', MAX_TEXTURE_SVG_ASSET_BYTES + 1)] }).assets.length, 0)
  assert.equal(migrateLegacySingleImageTexture({ imageDataUrl: overRaster.dataUrl, imageName: 'old.svg' }).assets.length, 1,
    'Legacy SVG migration must use the same independent limit')
  assert.equal(migrateLegacySingleImageTexture({ imageDataUrl: overRaster.dataUrl.replace('image/svg+xml', 'image/webp') }).assets.length, 0)
  assert.equal(normalizeTextureComposition({ assets: [{ ...asset('invalid-uri'), dataUrl: 'data:image/svg+xml,%ZZ' }] }).assets.length, 0)

  const normalized = normalizeTextureComposition({
    schemaVersion: 1,
    assets: [
      asset('a'),
      { ...asset('a', 'duplicate'), aspect: -1 },
      { ...asset('bad'), dataUrl: 'data:text/plain;base64,WA==' },
    ],
    layers: [
      { ...baseLayer, id: 'back', name: 'Back', kind: 'image', assetId: 'a', placement: { mode: 'free', transform: { xMm: 10, yMm: 20, widthMm: -5, heightMm: 30, rotationDeg: 450 }, fit: 'contain', crop: { x: -2, y: 0.9, width: 5, height: 5 } } },
      { ...baseLayer, id: 'front', name: 'Front', kind: 'image', assetId: 'a-2', placement: { mode: 'per-panel', panelIds: ['top-left', 'top-left', 3], insetMm: -9 } },
      { ...baseLayer, id: 'orphan', name: 'Orphan', kind: 'image', assetId: 'missing', placement: { mode: 'free' } },
    ],
  })
  assert.deepEqual(normalized.assets.map(item => item.id), ['a', 'a-2'], '重复资源 ID 应稳定补后缀，无效 MIME 应丢弃')
  assert.deepEqual(normalized.layers.map(item => item.id), ['back', 'front'], '图层顺序必须保留，悬空图层必须丢弃')
  assert.equal(normalized.layers[0].placement.transform.widthMm, 0.01)
  assert.equal(normalized.layers[0].placement.transform.rotationDeg, 90)
  assert.deepEqual(normalized.layers[0].placement.crop, { x: 0, y: 0.9, width: 1, height: 0.09999999999999998 })
  assert.deepEqual(normalized.layers[1].placement.panelIds, ['top-left'])
  assert.equal(normalized.layers[1].placement.insetMm, 0)
  assert.deepEqual(normalizeTextureComposition({ schemaVersion: 99, assets: [asset('a')] }), createDefaultTextureComposition())

  const migrated = migrateLegacySingleImageTexture({
    imageDataUrl: png('legacy'), imageName: 'legacy.png', imageAspect: 2,
    fit: 'contain', scale: 150, offsetX: 10, offsetY: -20, rotation: 270, opacity: 0.75,
  }, { minX: 10, minY: 20, width: 200, height: 100 })
  assert.equal(migrated.assets.length, 1)
  assert.equal(migrated.layers.length, 1)
  assert.equal(migrated.layers[0].placement.mode, 'free')
  assert.deepEqual(migrated.layers[0].placement.transform, {
    xMm: 130, yMm: 50, widthMm: 300, heightMm: 150, rotationDeg: -90, flipX: false, flipY: false,
  })
  assert.equal(migrated.layers[0].opacity, 0.75)
  const resolvedFree = resolveTextureLayerPlacements(migrated.layers[0], panels, { minX: 0, minY: 0, width: 300, height: 200 })
  assert.equal(resolvedFree.length, 1)
  assert.equal(resolvedFree[0].panelId, null)
  assert.equal(resolvedFree[0].transform.xMm, 130)
  const migratedTile = migrateLegacySingleImageTexture({ imageDataUrl: png('tile'), imageAspect: 2, fit: 'tile' }, { width: 200, height: 100 })
  assert.equal(migratedTile.layers[0].placement.mode, 'repeat')
  assert.equal(migratedTile.layers[0].placement.transform.widthMm, 68)
  assert.equal(migratedTile.layers[0].placement.transform.heightMm, 34)

  const panelPlacement = {
    mode: 'per-panel', panelIds: ['top-right', 'bottom-left'], fit: 'cover', crop,
    insetMm: 10, rotationDeg: 15, flipX: false, flipY: true,
  }
  const panelTargets = resolvePerPanelPlacements('layer', 'asset', panelPlacement, panels)
  assert.deepEqual(panelTargets.map(target => target.panelId), ['top-right', 'bottom-left'], '每板结果应遵循板件输入顺序')
  assert.deepEqual(panelTargets[0].transform, {
    xMm: 150, yMm: 150, widthMm: 80, heightMm: 80, rotationDeg: 15, flipX: false, flipY: true,
  })

  const repeatBase = {
    mode: 'repeat', fit: 'contain', crop,
    transform: { xMm: 5, yMm: 5, widthMm: 10, heightMm: 10, rotationDeg: 0, flipX: false, flipY: false },
    repeat: { kind: 'grid', gapXmm: 0, gapYmm: 0, alternateFlipX: true, alternateFlipY: false },
  }
  const grid = resolveRepeatPlacements('grid', 'a', repeatBase, { minX: 0, minY: 0, width: 20, height: 20 })
  assert.ok(grid.some(item => item.transform.xMm === 5 && item.transform.yMm === 5))
  assert.ok(grid.some(item => item.transform.xMm === 15 && item.transform.yMm === 5))
  const gridAt15 = grid.find(item => item.transform.xMm === 15 && item.transform.yMm === 5)
  assert.equal(gridAt15.transform.flipX, true, '交替列镜像必须确定')
  const brick = resolveRepeatPlacements('brick', 'a', { ...repeatBase, repeat: { ...repeatBase.repeat, kind: 'brick' } }, { minX: 0, minY: 0, width: 20, height: 20 })
  assert.ok(brick.some(item => item.transform.yMm === 15 && item.transform.xMm === 10), '错列奇数行应偏移半个步距')

  const sequenceBase = {
    ...baseLayer, id: 'sequence', name: 'Sequence', kind: 'panel-sequence', assetIds: ['a', 'b'], panelIds: 'all',
    order: 'row-major', overflow: 'cycle', fit: 'cover', crop, insetMm: 0, rotationDeg: 0, flipX: false, flipY: false,
  }
  const cycle = resolvePanelSequenceAssignments(sequenceBase, panels)
  assert.deepEqual(cycle.map(item => [item.panelId, item.assetId]), [
    ['top-left', 'a'], ['top-right', 'b'], ['bottom-left', 'a'], ['bottom-right', 'b'], ['far-right', 'a'],
  ])
  const once = resolvePanelSequenceAssignments({ ...sequenceBase, overflow: 'once' }, panels)
  assert.deepEqual(once.map(item => item.panelId), ['top-left', 'top-right'])
  const pingPong = resolvePanelSequenceAssignments({ ...sequenceBase, overflow: 'ping-pong' }, panels)
  assert.deepEqual(pingPong.map(item => item.assetId), ['a', 'b', 'a', 'b', 'a'])
  const manual = resolvePanelSequenceAssignments({ ...sequenceBase, order: 'manual', manualOrder: ['far-right', 'top-left'], overflow: 'once' }, panels)
  assert.deepEqual(manual.map(item => item.panelId), ['far-right', 'top-left'])
  const explicit = resolvePanelSequenceAssignments({ ...sequenceBase, panelAssetMap: { 'top-left': 'b', 'bottom-left': 'b' } }, panels)
  assert.deepEqual(explicit.slice(0, 3).map(item => [item.panelId, item.assetId]), [
    ['top-left', 'b'], ['top-right', 'b'], ['bottom-left', 'b'],
  ], '显式板件图片映射应覆盖自动序列，未指定板仍按序列分配')

  const normalizedSequence = normalizeTextureComposition({
    schemaVersion: 1, assets: [asset('a'), asset('b')],
    layers: [{ ...sequenceBase, panelAssetMap: { 'top-left': 'b', bad: 'missing' } }],
  }).layers[0]
  assert.deepEqual(normalizedSequence.panelAssetMap, { 'top-left': 'b' }, '无效资源映射必须在读取时清理')

  const resolvedSequence = resolveTextureLayerPlacements(sequenceBase, panels, { minX: 0, minY: 0, width: 300, height: 200 })
  assert.equal(resolvedSequence.length, 5)
  assert.equal(resolvedSequence[0].panelId, 'top-left')
  assert.equal(resolvedSequence[0].transform.widthMm, 100)
  assert.deepEqual(resolveTextureLayerPlacements({ ...sequenceBase, visible: false }, panels, { minX: 0, minY: 0, width: 300, height: 200 }), [])

  console.log('Texture composition regression passed: independent raster/SVG limits, exact Base64 boundaries, legacy migration, layer order, grid/brick, per-panel, cycle/once/manual OK')
} finally {
  await server.close()
}
