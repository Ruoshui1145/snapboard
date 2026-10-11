import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { strFromU8, unzipSync } from 'fflate'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const [{ createManufacturing3MF, createManufacturing3MFPerPanel }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }, { createDefaultAssemblyMarking }] = await Promise.all([
    server.ssrLoadModule('/src/utils/export3mf.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/assemblyMarking.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, printerPreset:'custom', bedW: 220, bedH: 220, bedKeepouts:[], manufacturingChamfer: 0.35 }
  const panels = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 0, y: 200 }], holes: [] }, cfg).panels
  assert.equal(panels.length, 2)
  const result = await createManufacturing3MF({ panels, cfg, placedParts: [], outputMode: 'perPanel',
    projectName: '逐板浏览器测试', assemblyMarking: {...createDefaultAssemblyMarking(),includeSeamIds:true} })
  assert.equal(result.panelCount, 2)
  assert.equal(result.markingRequestedCount, 2)
  assert.equal(result.markingAppliedCount, 2)
  assert.match(result.fileName, /-分板\.zip$/)
  const bundle = unzipSync(result.data)
  const names = Object.keys(bundle).filter(name => name.endsWith('.3mf'))
  assert.equal(names.length, 2)
  const codes = new Set()
  for (const name of names) {
    assert.match(name, /-P\d+\.3mf$/)
    const inner = unzipSync(bundle[name])
    assert.ok(JSON.parse(strFromU8(inner['Metadata/snapboard-manufacturing-catalog.json'])), 'Each panel must carry its manufacturing catalog')
    const report = JSON.parse(strFromU8(inner['Metadata/snapboard-export-report.json']))
    const map = JSON.parse(strFromU8(inner['Metadata/snapboard-assembly-map.json']))
    assert.equal(report.plates.flatMap(plate => plate.instances).filter(item => item.kind === 'panel').length, 1)
    assert.ok(map.seams.length > 0, 'each panel must retain full-project seam context')
    const label = report.plates.flatMap(plate => plate.instances).find(item => item.kind === 'panel').name
    codes.add(/^(P\d+)/.exec(label)?.[1])
  }
  assert.deepEqual([...codes].sort(), ['P01', 'P02'])
  await assert.rejects(createManufacturing3MFPerPanel({ panels, cfg, placedParts: [],
    textureSampling: { sizeMm: 20, locations: [{ panelIndex: 0, x: 100, y: 100 }] } }), /同一个 3MF/)
  console.log('verify:browser-per-panel OK')
} finally { await server.close() }
