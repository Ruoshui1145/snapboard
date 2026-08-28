import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

const input = process.argv[2]
if (!input) throw new Error('Usage: npm run verify:textured-3mf -- <file.3mf>')
const archive = unzipSync(new Uint8Array(await readFile(path.resolve(input))))
const text = filename => strFromU8(archive[filename])
const settings = JSON.parse(text('Metadata/project_settings.config'))
assert.equal(settings.printer_model, 'Bambu Lab P1S')
assert.equal(settings.printer_settings_id, 'Bambu Lab P1S 0.4 nozzle')
assert.ok(settings.filament_type.every(type => type === 'PETG'))
assert.ok(settings.filament_settings_id.every(id => id.includes('PETG')))
assert.ok(settings.nozzle_temperature.every(value => String(value) === '245'))
assert.ok(settings.textured_plate_temp.every(value => String(value) === '70'))
assert.ok(settings.filament_colour.length >= 2)
assert.equal(settings.layer_height, '0.28')
assert.equal(settings.wall_loops, '2')
assert.equal(settings.top_shell_layers, '3')
assert.equal(settings.top_shell_thickness, '0.6')
assert.notEqual(settings.sparse_infill_density, '100%', '结构基材不能继承 Lumina 的 100% 全局填充')
assert.equal(settings.curr_bed_type, 'Textured PEI Plate')

const modelSettings = text('Metadata/model_settings.config')
assert.match(modelSettings, /key="extruder" value="2"/)
assert.match(modelSettings, /key="sparse_infill_density" value="100%"/, '表层子零件必须保留 Lumina 实心覆盖')
assert.match(modelSettings, /key="layer_height" value="0\.28"/, '结构基材必须使用独立 0.28mm 层高')
assert.ok((modelSettings.match(/<plate>/g) ?? []).length >= 1)
assert.match(modelSettings, /plater_name" value="SnapBoard 板件/)
if (/kind="part"/.test(modelSettings)) assert.match(modelSettings, /plater_name" value="SnapBoard 配件/)

const objectModel = text('3D/Objects/object_1.model')
const allVertices = [...objectModel.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)]
assert.ok(allVertices.every(match => Number(match[1]) >= -1e-6 && Number(match[2]) >= -1e-6), '倒角或表层不得向板件局部轮廓外形成负坐标凸边')
const objects = [...objectModel.matchAll(/<object id="(\d+)" type="model" name="([^"]+)">([\s\S]*?)<\/object>/g)]
const structural = objects.filter(match => match[2].includes('结构基材'))
const backing = objects.filter(match => match[2].includes('顶部模具承托层'))
const textures = objects.filter(match => match[2].includes('Lumina'))
const veneers = objects.filter(match => match[2].includes('质感贴面'))
assert.ok(structural.length >= 1)
assert.ok((backing.length >= 1 && textures.length >= 2) || veneers.length >= 1)
const zRange = body => {
  const values = [...body.matchAll(/<vertex[^>]+ z="([^"]+)"/g)].map(match => Number(match[1]))
  let min = Infinity, max = -Infinity
  for (const value of values) { if (value < min) min = value; if (value > max) max = value }
  return { min, max }
}
for (const object of structural) {
  const range = zRange(object[3])
  assert.ok(Math.abs(range.min - 1) < 1e-6, '细磨砂方案应让装饰面朝下，结构层位于 z=1..5')
  assert.ok(Math.abs(range.max - 5) < 1e-6)
}
for (const object of backing) {
  const range = zRange(object[3])
  assert.ok(Math.abs(range.min - 0.4) < 1e-6)
  assert.ok(Math.abs(range.max - 1) < 1e-6)
}
for (const object of textures) {
  const range = zRange(object[3])
  assert.ok(range.min >= -1e-6)
  assert.ok(range.max <= 0.4 + 1e-6)
}
for (const object of veneers) {
  const range = zRange(object[3])
  assert.ok(Math.abs(range.min) < 1e-6)
  assert.ok(Math.abs(range.max - 1) < 1e-6)
}
const mainModel = text('3D/3dmodel.model')
assert.match(mainModel, /<components>[\s\S]*<component/, '结构基材与表层必须绑定在同一个父对象中整体移动')
if (textures.length) {
  assert.equal(settings.initial_layer_print_height, '0.08', 'Lumina 装饰面朝下时首层必须保持 0.08mm')
  assert.match(modelSettings, /key="layer_height" value="0\.08"/, 'Lumina 光学层必须保持 0.08mm 层高')
  assert.ok(Math.abs(Math.min(...textures.map(object => zRange(object[3]).min))) < 1e-6)
  assert.equal(settings.filament_colour.length, 5, '结构基材 + RYBW 应为 5 卷基础耗材，而不是每个观看色一卷')
}
if (veneers.length) {
  assert.equal(settings.initial_layer_print_height, '0.25', '单材质贴面/基材首层应使用约 0.25mm')
  assert.match(modelSettings, /质感贴面[\s\S]*?key="layer_height" value="0\.28"/, '单材质贴面应使用高速 0.28mm 层高')
}
console.log(`Composite 3MF verification passed: ${structural.length} bases + ${backing.length} backings + ${textures.length} optical parts + ${veneers.length} veneer parts`)
