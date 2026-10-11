import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const read = file => readFile(path.join(root, file), 'utf8')
const [featureGates, studio, lut, exporter, projectFile, geometry] = await Promise.all([
  read('src/config/snapColorFeatures.ts'),
  read('src/components/texture/TextureStudio.tsx'),
  read('src/utils/snapColorLut.ts'),
  read('src/utils/export3mf.ts'),
  read('src/utils/projectFile.ts'),
  read('src/types/geometry.ts'),
])

assert.match(featureGates, /pixelArtImport:\s*true/)
assert.match(featureGates, /svgVectorImport:\s*true/)
assert.match(featureGates, /SNAPCOLOR_RASTER_ACCEPT\s*=\s*'image\/png,image\/jpeg,image\/webp/)
assert.match(studio, /MODELING_MODES = ALL_MODELING_MODES\.filter\(mode => snapColorModelingModeAvailable\(mode\.id\)\)/)
assert.match(studio, /accept=\{SNAPCOLOR_IMAGE_ACCEPT\}/)
assert.match(studio, /prepareTextureSvg\(await file.text\(\)\)/)
assert.doesNotMatch(studio, /surfaceMode:\s*'lumina'/)

assert.match(geometry, /BoardSurfaceMode = 'snapcolor' \| 'veneer'/)
assert.match(lut, /SNAPCOLOR_LUTS/)
// 内置档案按耗材品牌区分，显示名只讲品牌与 PETG，不再带 SnapColor 前缀。
assert.match(lut, /Aliz PETG · RYBW/)
assert.match(lut, /魔创 PETG · 黑白/)
assert.match(lut, /三绿 PETG · RYBW/)
assert.doesNotMatch(lut, /name: 'SnapColor PETG/, '内置档案显示名不得再带 SnapColor 前缀')
assert.match(lut, /'aliz-petg-rybw': 'snapcolor-petg-rybw'/, 'legacy Aliz IDs must remain read-only migration aliases')
assert.match(projectFile, /value\.surfaceMode === 'lumina'\) next\.surfaceMode = 'snapcolor'/, 'legacy surface mode must migrate')
assert.match(exporter, /SnapColor \$\{context\.lut\.materials\[index\]\.name\}/)

const runtimeAssets = await readdir(path.join(root, 'public', 'snapcolor', 'luts'))
assert.ok(runtimeAssets.length >= 15, `6 组原有档案 + 6 组品牌 PETG 档案（含层配方）必须全部就位：${runtimeAssets.join(', ')}`)
assert.ok(runtimeAssets.every(name => name.startsWith('snapcolor-') && name.endsWith('.npy')),
  `runtime LUT assets must use SnapColor names: ${runtimeAssets.join(', ')}`)
await assert.rejects(readdir(path.join(root, 'public', 'lumina')), /ENOENT/)

// 注册表与磁盘资产一一对应，且每个档案的配方数与材料/层数定义自洽。
const { SNAPCOLOR_LUTS, parseSnapColorNpy } = await import('../src/utils/snapColorLut.ts')
for (const definition of SNAPCOLOR_LUTS) {
  const assetPath = path.join(root, 'public', definition.asset)
  const parsed = parseSnapColorNpy(await readFile(assetPath))
  assert.ok(parsed.data instanceof Uint8Array, `${definition.id} 必须为 uint8`)
  assert.equal(parsed.shape.at(-1), 3, `${definition.id} 最后一维必须为 RGB`)
  const colorCount = parsed.data.length / 3
  if (definition.stackAsset) {
    const stacks = parseSnapColorNpy(await readFile(path.join(root, 'public', definition.stackAsset)))
    assert.equal(stacks.shape[0], colorCount, `${definition.id} 层配方数必须等于实测颜色数`)
    assert.equal(stacks.shape[1], definition.layerCount, `${definition.id} 层配方层数不匹配`)
  } else if (definition.id === 'snapcolor-petg-bw') {
    assert.ok(colorCount >= 32, `${definition.id} 至少含 32 个灰阶配方（含定位色块）`)
  } else {
    assert.equal(colorCount, definition.materials.length ** definition.layerCount,
      `${definition.id} 配方数必须等于 材料数^层数`)
  }
}

console.log(`SnapColor packaging verification passed: ${runtimeAssets.length} branded LUT assets (${SNAPCOLOR_LUTS.length} profiles); pixel/SVG enabled; legacy migration retained`)
