import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { buildMarkPlan, DEFAULT_CODES, normalizeOrder } from '../../apps/order-workbench/shared/domain.mjs'

const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const [split, lattice, svg, marking, exporter, order, side, board, solids] = await Promise.all([
    'pegboardSplit', 'openLattice', 'svgLattice', 'assemblyMarking', 'export3mf', 'orderEngraving', 'sideLogo', 'boardMesh', 'spatialSolid',
  ].map(name => server.ssrLoadModule(`/src/utils/${name}.ts`)))
  const cfg = { ...split.PEGBOARD_DEFAULT_CONFIG, bedW: 256, bedH: 256, thickness: 5, manufacturingChamfer: .25 }
  const base = split.splitOrthogonalPolygon({ points: [{ x: -230, y: -150 }, { x: -10, y: -150 }, { x: -10, y: 70 }, { x: -230, y: 70 }] }, cfg).panels[0]
  const makePlan = panel => {
    const normalized = normalizeOrder({ customer: { name: 'PRIVATE' }, product: { name: 'PRIVATE', layoutCode: 'F', mappingCode: 'M0', colourCode: 'C00',
      widthMm: panel.w, heightMm: panel.h, thicknessMm: cfg.thickness }, kitQuantity: 1,
      panels: [{ code: 'P01', quantity: 1, widthMm: panel.w, heightMm: panel.h, sourcePanelId: panel.id }], designFingerprint: 'c'.repeat(64) }, DEFAULT_CODES)
    return { ...buildMarkPlan({ ...normalized, number: 'SB-20261004-0001', markingKey: '2610040001', revision: 2 }),
      designFingerprint: normalized.designFingerprint, kitQuantity: 1, perSetPanelCount: 1, totalPanelCount: 1 }
  }
  const wasm = await solids.spatialManifold()
  const decode = data => {
    const archive = unzipSync(data), xml = strFromU8(archive['3D/Objects/object_1.model'])
    const meshes = [...xml.matchAll(/<mesh>([\s\S]*?)<\/mesh>/g)].map(match => {
      const vertices = [...match[1].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap(v => v.slice(1).map(Number))
      const triangles = [...match[1].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap(t => t.slice(1).map(Number))
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(vertices), triVerts: Uint32Array.from(triangles), tolerance: 1e-5 })
      mesh.merge(); const solid = new wasm.Manifold(mesh)
      assert.equal(solid.status(), 'NoError', 'actual side-engraved manufacturing mesh must remain closed')
      return solid
    })
    return { archive, meshes }
  }
  let output, outputTrace
  const measurements = []
  for (const style of ['hex', 'honeycomb']) {
    const open = lattice.generateOpenLattice(base, cfg, 3.5, style)
    const panel = { ...base, latticeCutouts: open.holes }, plan = makePlan(panel)
    const config = { ...marking.createDefaultAssemblyMarking(), numberPlacement: 'back', sideLogoEnabled: true }
    const layout = marking.buildSurfaceMarkingPlan([panel], cfg, config)
    assert.equal(layout.panels[0].numberMark, undefined, 'assembly IDs do not fall back to side engraving')
    assert.equal(layout.panels[0].marks.length, 0)
    assert.equal(layout.panels[0].engravingPolygons.length, 0)
    assert.equal(order.orderSideEngravings(panel, cfg, plan, plan.panels[0])[0].surface, 'side')
    const input = { panels: [panel], cfg, placedParts: [], partDefinitions: [], assemblyMarking: { ...config, enabled: false } }
    const plain = decode((await exporter.createManufacturing3MF(input)).data)
    const traced = await exporter.createManufacturing3MF({ ...input, assemblyMarking: config, orderEngraving: plan, orderInstance: plan.panels[0] })
    assert.equal(traced.numbering.side, 0, 'order text is independent of assembly panel IDs')
    assert.equal(traced.numbering.back, 0); assert.equal(traced.numbering.pocket, 0)
    assert.equal(traced.markingRequestedCount, 0, 'a through board must not report failed back engraving')
    const after = decode(traced.data)
    assert.equal(after.meshes.length, plain.meshes.length, 'numbering must not add shells or material components')
    let removed = 0, added = 0
    for (let i = 0; i < plain.meshes.length; i++) {
      const grown = after.meshes[i].subtract(plain.meshes[i]), cut = plain.meshes[i].subtract(after.meshes[i])
      // Float32 boolean/3MF round-trips leave sub-micron boundary slivers across
      // hundreds of honeycomb edges. Bound them to one ppm of the original solid.
      const numericalTolerance = plain.meshes[i].volume() * 1e-6
      added += grown.volume()
      assert.ok(grown.volume() < numericalTolerance, `every through window and the original material footprint must remain open and unchanged: added=${grown.volume()}, before=${plain.meshes[i].volume()}, after=${after.meshes[i].volume()}`)
      removed += cut.volume()
      const outsideSide = wasm.Manifold.cube([panel.w, panel.h - .2401, cfg.thickness])
      const front = wasm.Manifold.cube([panel.w, panel.h, cfg.manufacturingChamfer])
      const rearBase = wasm.Manifold.cube([panel.w, panel.h, cfg.manufacturingChamfer])
      const rear = rearBase.translate([0, 0, cfg.thickness - cfg.manufacturingChamfer])
      for (const region of [outsideSide, front, rear]) {
        const overlap = cut.intersect(region)
        assert.ok(overlap.volume() < numericalTolerance, `order strokes must stay on the side wall and leave the front/back unchanged: outside=${overlap.volume()}, removed=${cut.volume()}, bounds=${JSON.stringify(cut.boundingBox())}, warnings=${JSON.stringify(traced.warnings)}`)
        overlap.delete(); region.delete()
      }
      rearBase.delete()
      grown.delete(); cut.delete(); plain.meshes[i].delete(); after.meshes[i].delete()
    }
    assert.ok(removed > 5, 'the complete order number must physically cut the side wall')
    const trace = JSON.parse(strFromU8(after.archive['Metadata/snapboard-order-engraving.json']))
    assert.equal(trace.surface, 'side'); assert.equal(trace.panels[0].layout, 'side')
    assert.equal(trace.panels[0].readingOrder, 'top-edge-left-to-right')
    assert.deepEqual(trace.panels[0].lines, [plan.orderNumber])
    assert.deepEqual(trace.panels[0].segments.map(s => s.text), trace.panels[0].lines)
    assert.ok(trace.panels[0].segments.every((segment, index, list) => !index || segment.xMm < list[index - 1].xMm),
      'top-edge exterior view must preserve the canonical field reading order')
    assert.equal(trace.panels[0].engravings.map(c => c.marks[0].text).join(' '), plan.orderNumber,
      'replacing the assembly side number must retain its enabled orientation')
    assert.ok(Object.values(after.archive).every(bytes => !strFromU8(bytes).includes('PRIVATE')))
    assert.deepEqual(panel.latticeCutouts, open.holes, 'manufacturing must not rewrite the lattice windows')
    const backed = svg.applyLatticeFrontLayer(base, cfg, open, 1.4)
    assert.equal(marking.isThroughLatticePanel({ ...base, latticeCutouts: backed.holes, latticeFace: backed.face }), false)
    output = traced.data
    outputTrace = trace
    measurements.push({ style, addedNumericalSliversMm3: added, removedMm3: removed, meshCount: after.meshes.length, traceSurface: trace.surface })
  }
  const thin = { ...base, latticeCutouts: lattice.generateOpenLattice(base, cfg, 3.5, 'hex').holes }
  const plan = makePlan(thin)
  assert.throws(() => order.orderSideEngravings(thin, { ...cfg, thickness: 3 }, plan, plan.panels[0]), /侧壁.*完整订单号.*不会省略订单号或添加背壳/)
  const view = await readFile('src/components/viewport/Viewport3D.tsx', 'utf8')
  assert.match(view, /label\.userData\.latticeFace = Boolean\(p\.latticeFace \|\| p\.latticeCutouts\?\.length\)/,
    'the center P01 overlay must not float inside a through window')
  const out = resolve('../output/order-engraving-regression')
  await mkdir(out, { recursive: true }); await writeFile(resolve(out, 'through-honeycomb-side-order.3mf'), output)
  await writeFile(resolve(out, 'through-side-order-evidence.json'), JSON.stringify({ measurements, trace: outputTrace }, null, 2))
  console.log('PASS: through hex/honeycomb side-only preview and actual full order trace, closed meshes, no new material or backing, clear thin-wall error, preserved metadata and existing retained fronts')
} finally { await server.close() }
