import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

// 方案 §4/§5.D：原生整单导出必须是一份结构完整、可被切片器接受的 3MF。
// 网格闭合由导出过程自身的 validateClosedMesh 保证（不闭合会直接报错，不会静默产出），
// 这里核对外部产物结构：ZIP 条目与 CRC、部件齐全性、盘号连续、报告口径。
// 整单模型 XML 超过 V8 字符串上限，因此按字节扫描而不是整体解码。
const [projectPath, filePath] = process.argv.slice(2)
if (!projectPath || !filePath) throw new Error('Usage: verify-native-multiplate.mjs <project.snapboard> <file.3mf>')

const panels = JSON.parse(readFileSync(projectPath, 'utf8')).workspace.splitResult.panels
// unzipSync 会校验每个条目的 CRC，解压失败即视为产物损坏。
const archive = unzipSync(new Uint8Array(readFileSync(filePath)))
for (const entry of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', '3D/Objects/object_1.model',
  'Metadata/project_settings.config', 'Metadata/model_settings.config', 'Metadata/snapboard-export-report.json']) {
  assert.ok(archive[entry], `3MF 缺少 ${entry}`)
}

const model = Buffer.from(archive['3D/Objects/object_1.model'])
const countBetween = (needle, from, to) => {
  let n = 0, at = from
  for (;;) { const found = model.indexOf(needle, at); if (found < 0 || found >= to) return n; n++; at = found + needle.length }
}
const objectStarts = []
for (let at = model.indexOf('<object '); at >= 0; at = model.indexOf('<object ', at + 8)) objectStarts.push(at)
assert.ok(objectStarts.length > 0, '必须包含制造网格')

const objects = objectStarts.map((start, i) => {
  const end = i + 1 < objectStarts.length ? objectStarts[i + 1] : model.length
  const head = model.subarray(start, Math.min(start + 400, end)).toString('utf8')
  return {
    name: /name="([^"]*)"/.exec(head)?.[1] ?? '',
    vertices: countBetween(Buffer.from('<vertex '), start, end),
    triangles: countBetween(Buffer.from('<triangle '), start, end),
  }
})
for (const object of objects) {
  assert.ok(object.vertices > 0 && object.triangles > 0, `部件 ${object.name} 缺少顶点或三角形`)
}

// 相同板件复用同一个 object，所以按类型核对而不是按板计数。
const count = fragment => objects.filter(object => object.name.includes(fragment)).length
const colours = count('SnapColor')
assert.ok(count('结构基材') > 0, '缺少结构基材部件')
assert.ok(count('承托') > 0, '缺少顶部模具承托层')
assert.ok(count('封边') > 0, '缺少基材单线封边墙')
assert.ok(colours > 0 && colours % 4 === 0, `SnapColor 材料部件必须是 4 的倍数，实际 ${colours}`)

const modelSettings = strFromU8(archive['Metadata/model_settings.config'])
const plateIds = [...modelSettings.matchAll(/key="plater_id" value="(\d+)"/g)].map(m => Number(m[1]))
assert.ok(plateIds.length > 0, '必须至少有一个热床')
assert.deepEqual(plateIds, plateIds.map((_, i) => i + 1), '盘号必须是连续的 1..N')
assert.ok(/<plate>/.test(modelSettings) && /key="object_id"/.test(modelSettings), '热床必须带对象实例')

const report = JSON.parse(strFromU8(archive['Metadata/snapboard-export-report.json']))
const sampling = report.textureSampling?.[0]
assert.ok(sampling, '导出报告必须记录采样信息')
assert.ok(sampling.gridPitchMm > 0.4, `整单采样间距应来自动态预算，实际 ${sampling.gridPitchMm}`)
const layers = report.textureContours?.layers ?? []
assert.equal(layers.length, panels.length * 5, `应有 ${panels.length}×5 条板×层轮廓记录`)
assert.ok(layers.every(layer => layer.triangles > 0), '每层都必须产出几何')

console.log(JSON.stringify({ panels: panels.length, objects: objects.length, plates: plateIds.length,
  triangles: objects.reduce((n, o) => n + o.triangles, 0), colourParts: colours,
  gridPitchMm: +sampling.gridPitchMm.toFixed(4),
  budgetGoverning: sampling.manufacturingBudget?.governing,
  routes: [...new Set(layers.map(l => l.route))], contourLayers: layers.length }, null, 1))
console.log('verify:native-multiplate OK')
