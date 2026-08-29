import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root: projectRoot,
  appType: 'custom',
  server: { middlewareMode: true },
})

try {
  const [{ createManufacturing3MF }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }] = await Promise.all([
    server.ssrLoadModule('/src/utils/export3mf.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
  ])

  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220 }
  const split = splitOrthogonalPolygon({
    points: [
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { x: 150, y: 150 },
      { x: 0, y: 150 },
    ],
    holes: [],
  }, cfg)
  assert.equal(split.panels.length, 1)
  const sourcePanel = split.panels[0]
  const makePanel = id => ({ ...sourcePanel, id })

  const result = await createManufacturing3MF({
    panels: [makePanel('p1'), makePanel('p2')],
    cfg,
    placedParts: [],
    projectName: 'SnapBoard 3MF compatibility verification',
  })
  assert.equal(result.plateCount, 2)
  assert.equal(result.panelCount, 2)
  assert.equal(result.uniqueObjectCount, 1)

  const archive = unzipSync(result.data)
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    '3D/3dmodel.model',
    '3D/_rels/3dmodel.model.rels',
    '3D/Objects/object_1.model',
    'Metadata/project_settings.config',
    'Metadata/model_settings.config',
    'Metadata/slice_info.config',
    'Metadata/filament_sequence.json',
    'Metadata/cut_information.xml',
  ]
  for (const filename of required) assert.ok(archive[filename], `missing ${filename}`)

  const projectSettings = JSON.parse(strFromU8(archive['Metadata/project_settings.config']))
  assert.ok(Object.keys(projectSettings).length >= 500, 'project config is sparse')
  assert.deepEqual(projectSettings.filament_colour, ['#3EC6B0'])
  assert.equal(projectSettings.printer_model, 'Bambu Lab P1S')
  assert.equal(projectSettings.printer_settings_id, 'Bambu Lab P1S 0.4 nozzle')
  assert.deepEqual(projectSettings.printable_area, ['0x0', '220x0', '220x220', '0x220'])

  const mainModel = strFromU8(archive['3D/3dmodel.model'])
  assert.match(mainModel, /p:path="\/3D\/Objects\/object_1\.model"/)
  assert.doesNotMatch(mainModel, /p:UUID=/)
  const transforms = [...mainModel.matchAll(/<item[^>]+transform="([^"]+)"/g)].map(match => match[1])
  assert.equal(transforms.length, 2)
  assert.notEqual(transforms[0], transforms[1], 'plate transforms overlap')
  assert.ok(Number(transforms[1].trim().split(/\s+/)[9]) >= 260, 'plate 2 has no global grid offset')

  const modelSettings = strFromU8(archive['Metadata/model_settings.config'])
  assert.equal((modelSettings.match(/<plate>/g) ?? []).length, 2)
  assert.match(modelSettings, /key="plater_id" value="1"/)
  assert.match(modelSettings, /key="plater_id" value="2"/)
  assert.equal((modelSettings.match(/<model_instance>/g) ?? []).length, 2)

  const output = path.resolve(projectRoot, '..', '.tmp-3d-test', 'snapboard-bambu-two-plate.3mf')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, result.data)

  const slopedSplit = splitOrthogonalPolygon({
    points: [
      { x: 0, y: 0 }, { x: 0, y: 650 }, { x: 220, y: 515 },
      { x: 500, y: 515 }, { x: 500, y: 230 }, { x: 710, y: 230 }, { x: 710, y: 0 },
    ],
  }, cfg)
  assert.ok(slopedSplit.coverageRatio > 0.999999, `斜边覆盖率不足：${slopedSplit.coverageRatio}`)
  assert.ok(slopedSplit.panels.some(panel => panel.contour.some((point, index) => {
    const next = panel.contour[(index + 1) % panel.contour.length]
    return Math.abs(next.x - point.x) > 1e-6 && Math.abs(next.y - point.y) > 1e-6
  })), '制造输入必须保留真实斜边')
  const sloped3MF = await createManufacturing3MF({
    panels: slopedSplit.panels,
    cfg,
    placedParts: [],
    projectName: 'SnapBoard sloped panel verification',
  })
  assert.equal(sloped3MF.panelCount, slopedSplit.panels.length)
  assert.deepEqual(sloped3MF.warnings, [])
  console.log(`3MF verification passed: ${output}`)
} finally {
  await server.close()
}
