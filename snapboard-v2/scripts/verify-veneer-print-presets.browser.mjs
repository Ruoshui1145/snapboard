import { strFromU8, unzipSync } from 'fflate'
import { createManufacturing3MF } from '/src/utils/export3mf.ts'
import { createDefaultBoardTexture } from '/src/utils/boardTexture.ts'
import { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } from '/src/utils/pegboardSplit.ts'

const check = (condition, message) => { if (!condition) throw new Error(message) }
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)

export async function run() {
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, thickness: 5 }
  const { panels } = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], holes: [] }, cfg)
  equal(panels.length, 1, '40mm 试片')
  const base = { ...createDefaultBoardTexture(), enabled: true, surfaceMode: 'veneer', source: 'preset' }
  const exportWith = async texture => {
    const result = await createManufacturing3MF({ panels, cfg, placedParts: [], partDefinitions: [], boardTexture: texture })
    const archive = unzipSync(result.data)
    return {
      project: JSON.parse(strFromU8(archive['Metadata/project_settings.config'])),
      model: strFromU8(archive['Metadata/model_settings.config']),
      report: JSON.parse(strFromU8(archive['Metadata/snapboard-export-report.json'])),
    }
  }

  const standard = await exportWith(base)
  equal(standard.project.initial_layer_print_height, '0.25', '常规首层')
  equal(standard.project.filament_max_volumetric_speed, ['21', '21'], '常规耗材流量')
  check(/质感贴面[\s\S]*?key="layer_height" value="0\.28"/.test(standard.model), '常规贴面应保留 0.28mm')

  const transparent = { ...base, surfaceMaterialName: '透明 PETG', surfaceMaterialKind: 'transparent-petg', surfacePrintGoal: 'frosted' }
  const frosted = await exportWith(transparent)
  equal(frosted.project.initial_layer_print_height, '0.2', '细磨砂首层')
  equal(frosted.project.filament_max_volumetric_speed, ['21', '15'], '细磨砂只限制表层料卷')
  equal(frosted.project.fan_min_speed[1], '20', '细磨砂试验风扇')
  check(/质感贴面[\s\S]*?key="layer_height" value="0\.2"/.test(frosted.model), '细磨砂贴面应为 0.20mm')
  equal(frosted.report.veneer.goal, 'frosted', '报告应记录目标')

  const clear = await exportWith({ ...transparent, surfacePrintGoal: 'clear-experimental', surfaceFilamentVendor: 'Test Spool', surfacePrintOverrides: { nozzleTempC: 252, flowRatio: 1.01, maxFlowMm3s: 12, fanPercent: 10 } })
  equal(clear.project.initial_layer_print_height, '0.1', '清亮试验首层')
  equal(clear.project.nozzle_temperature, ['245', '252'], '温度只覆盖表层料卷')
  equal(clear.project.filament_flow_ratio, ['0.95', '1.01'], '校准流量只覆盖表层料卷')
  equal(clear.project.filament_max_volumetric_speed, ['21', '12'], '体积流量只覆盖表层料卷')
  equal(clear.project.fan_min_speed[1], '10', '风扇覆盖')
  equal(clear.project.filament_vendor[1], 'Test Spool', '料卷厂牌')
  check(/质感贴面[\s\S]*?key="layer_height" value="0\.1"/.test(clear.model), '清亮试验贴面应为 0.10mm')
  equal(clear.report.veneer.profileVersion, 1, '报告应记录预设版本')

  let rejected = false
  try { await exportWith({ ...transparent, surfacePrintOverrides: { nozzleTempC: 300 } }) } catch (error) { rejected = /超出/.test(String(error)) }
  check(rejected, '越界校准值应阻止导出')
  return 'PASS：常规、细磨砂、清亮试验和越界校准；基材参数未被透明贴面覆盖'
}
