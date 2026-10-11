import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { createServer } from 'vite'

const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false } })
try {
  const attribution = await server.ssrLoadModule('/src/utils/snapboardAttribution.ts')
  const record = attribution.createSnapBoardAttribution({ projectName: '<测试 & 来源>', projectVersion: '1.3.1' })
  assert.ok(attribution.isSnapBoardAttribution(record))
  assert.equal(record.authenticity, 'unsigned-local')
  assert.notEqual(record.sourceRecordId, attribution.createSnapBoardAttribution().sourceRecordId)
  assert.deepEqual(attribution.normalizeSnapBoardAttribution(record), record, 'opening an intact source record retains its identity')
  const legacy = { ...record }; delete legacy.sourceRecordId; delete legacy.authenticity; delete legacy.originUrl; delete legacy.verificationNotice
  const migrated = attribution.normalizeSnapBoardAttribution(legacy)
  assert.equal(migrated.generatedAt, legacy.generatedAt)
  assert.equal(migrated.projectName, legacy.projectName)
  assert.ok(attribution.isSnapBoardAttribution(migrated), 'legacy source records remain readable')
  const forged = attribution.normalizeSnapBoardAttribution({ ...record, authenticity: 'official-signed', signedBy: 'SnapBoard' })
  assert.equal(forged.authenticity, 'unsigned-local')
  assert.equal(Object.hasOwn(forged, 'signedBy'), false, 'import cannot claim verified authenticity')

  const [{ createSplitPanels3MF, createManufacturing3MF }, { writeSpatial3MF }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }] = await Promise.all([
    server.ssrLoadModule('/src/utils/export3mf.ts'), server.ssrLoadModule('/src/utils/spatial3mf.ts'), server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG }
  const { panels } = splitOrthogonalPolygon({ points: [{x:0,y:0},{x:80,y:0},{x:80,y:80},{x:0,y:80}], holes: [] }, cfg)
  const cube = { name: 'source-check', vertices: [0,0,0, 10,0,0, 10,10,0, 0,10,0, 0,0,5, 10,0,5, 10,10,5, 0,10,5], triangles: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7] }
  const outputs = [
    createSplitPanels3MF(panels, cfg, '来源核对'),
    (await createManufacturing3MF({ panels, cfg, placedParts: [], projectName: '来源核对' })).data,
    writeSpatial3MF([cube], '来源核对', { 'Metadata/snapboard-attribution.json': new TextEncoder().encode('{"authenticity":"official-signed"}') }),
  ]
  for (const output of outputs) {
    const archive = unzipSync(output)
    const source = JSON.parse(strFromU8(archive['Metadata/snapboard-attribution.json']))
    assert.ok(attribution.isSnapBoardAttribution(source))
    const model = strFromU8(archive['3D/3dmodel.model'])
    assert.ok(model.includes(`<metadata name="SnapBoard:SourceRecordId">${source.sourceRecordId}</metadata>`), 'root model and source manifest must identify the same export')
    assert.match(model, /SnapBoard:Authenticity">unsigned-local/)
    assert.match(model, /Made with SnapBoard/)
  }
  const [css, designer, standee, sheet] = await Promise.all([
    'src/components/designer/BrandWatermark.css', 'src/components/designer/DesignerApp.tsx',
    'src/components/standee/StandeeApp.tsx', 'src/utils/samplingCheckSheet.ts',
  ].map(file => readFile(file, 'utf8')))
  assert.match(css, /pointer-events:none/)
  assert.doesNotMatch(css, /animation:|filter:|backdrop-filter:/, 'branding must not animate or add per-frame effects')
  assert.match(designer, /<BrandWatermark\s*\/>/)
  assert.match(standee, /<BrandWatermark\s*\/>/)
  assert.match(sheet, /fillText\(SNAPBOARD_PUBLICATION_NOTICE/)
  console.log('Source marking passed: legacy compatibility, unverified imports, distinct file IDs, matching root/manifest IDs in 3 export paths, static noninteractive watermarks, PNG branding.')
} finally { await server.close() }
