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
  const [{ createManufacturing3MF, createManufacturing3MFStreamed, manufacturingCurveSegments }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }, { createSplitPanelShape }, { createDefaultBoardTexture }] = await Promise.all([
    server.ssrLoadModule('/src/utils/export3mf.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/boardMesh.ts'),
    server.ssrLoadModule('/src/utils/boardTexture.ts'),
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
  const curveSegments = manufacturingCurveSegments(cfg)
  assert.equal(curveSegments, 12, 'default 5mm holes should not use 64 manufacturing segments')
  assert.ok(manufacturingCurveSegments({ ...cfg, cornerRadius: 40 }) > curveSegments, 'large rounded corners require more subdivisions')
  const shape = createSplitPanelShape(sourcePanel, cfg)
  const reference = shape.extractPoints(64)
  const reduced = shape.extractPoints(curveSegments)
  const rings = result => [result.shape, ...result.holes]
  const distanceToEdge = (point, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
    const t = length2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy)
  }
  assert.equal(reduced.holes.length, reference.holes.length)
  const deviation = Math.max(...rings(reference).map((ring, index) => Math.max(...ring.map(point =>
    Math.min(...rings(reduced)[index].map((a, i, reducedRing) => distanceToEdge(point, a, reducedRing[(i + 1) % reducedRing.length])))))))
  assert.ok(deviation < 0.025, `manufacturing hole chord deviation ${deviation}mm exceeds budget`)

  const hugeInput = {
    panels: [makePanel('large-0')], cfg, placedParts: [],
    boardTexture: { ...createDefaultBoardTexture(),
      enabled: true, source: 'composition', modelingMode: 'vector',
      composition: {
        schemaVersion: 1,
        layers: [{ kind: 'image', visible: true, assetId: 'huge-svg' }],
        assets: [{ id: 'huge-svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,' + 'A'.repeat(34 * 1024 * 1024) }],
      },
    },
  }
  for (const count of [1, 2, 3, 4]) for (const outputMode of ['single', 'perPanel']) {
    await assert.rejects(createManufacturing3MF({ ...hugeInput, outputMode,
      panels: Array.from({ length: count }, (_, index) => makePanel(`large-${index}`)),
    }), /已在计算前停止/, `${count}-board ${outputMode} SVG export must stop before decoding or geometry`)
  }
  await assert.rejects(createManufacturing3MFStreamed(hugeInput, true), /已在计算前停止/,
    'OPFS streaming must not bypass SVG parsing protection or open a disk writer first')
  await assert.rejects(createManufacturing3MF({ ...hugeInput, boardTexture: { ...hugeInput.boardTexture,
    source: 'image', imageDataUrl: hugeInput.boardTexture.composition.assets[0].dataUrl,
  } }), /已在计算前停止/, 'legacy single-image SVG must use the same guard')
  const { textureVectorBudgetError } = await server.ssrLoadModule('/src/utils/textureVectorRegions.ts')
  const mapped = { ...hugeInput.boardTexture, composition: { ...hugeInput.boardTexture.composition,
    layers: [{ kind: 'panel-sequence', visible: true, assetIds: [], panelAssetMap: { 'large-0': 'huge-svg' } }],
  } }
  assert.match(textureVectorBudgetError(mapped), /已在计算前停止/, 'manual per-panel assignments must count their referenced SVG')
  mapped.composition.layers[0].visible = false
  assert.equal(textureVectorBudgetError(mapped), null, 'hidden resources must not block an unrelated export')

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
    'Metadata/snapboard-attribution.json',
  ]
  for (const filename of required) assert.ok(archive[filename], `missing ${filename}`)

  const projectSettings = JSON.parse(strFromU8(archive['Metadata/project_settings.config']))
  const attribution = JSON.parse(strFromU8(archive['Metadata/snapboard-attribution.json']))
  assert.equal(attribution.schema, 'snapboard-attribution/v1')
  assert.equal(attribution.generator, 'SnapBoard')
  assert.equal(attribution.attributionText, 'Created with SnapBoard')
  assert.equal(attribution.publicationNotice, 'Made with SnapBoard')
  assert.equal(attribution.attributionRequired, true)
  assert.match(attribution.attributionRequirement, /Made with SnapBoard/)
  assert.equal(attribution.projectName, 'SnapBoard 3MF compatibility verification')
  for(const key of ['layer_height','initial_layer_print_height','nozzle_diameter','filament_type','inherits_group','different_settings_to_system','extruder_printable_height'])assert.ok(Object.hasOwn(projectSettings,key),'Missing effective machine/process setting '+key)
  assert.equal(projectSettings.layer_height,'0.28')
  assert.ok(projectSettings.different_settings_to_system[0].split(';').includes('layer_height'),'Coarse layer override must survive inherited preset reload')
  assert.ok(!projectSettings.inherits_group[0].includes('H2D'),'A P1S process must not inherit an H2D fine profile')
  assert.deepEqual(projectSettings.filament_colour, ['#3EC6B0'])
  assert.equal(projectSettings.printer_model, 'Bambu Lab P1S')
  assert.equal(projectSettings.printer_settings_id, 'Bambu Lab P1S 0.4 nozzle')
  assert.deepEqual(projectSettings.printable_area, ['0x0', '220x0', '220x220', '0x220'])

  const mainModel = strFromU8(archive['3D/3dmodel.model'])
  assert.match(mainModel, /SnapBoard:Attribution/)
  assert.match(mainModel, /SnapBoard:PublicationNotice/)
  assert.match(mainModel, /SnapBoard:AttributionRequired/)
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
