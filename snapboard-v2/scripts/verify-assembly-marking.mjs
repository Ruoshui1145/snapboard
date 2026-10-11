import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { createServer } from 'vite'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: projectRoot, appType: 'custom', server: { middlewareMode: true } })

try {
  const [markingModule, splitModule, exportModule, boardModule] = await Promise.all([
    server.ssrLoadModule('/src/utils/assemblyMarking.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/export3mf.ts'),
    server.ssrLoadModule('/src/utils/boardMesh.ts'),
  ])
  const { buildAssemblyMarkPlan, createDefaultAssemblyMarking, detectAssemblySeams } = markingModule
  const { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } = splitModule
  const { createManufacturing3MF } = exportModule
  const { generateSplitPanelMesh, makeBackSeamGuide } = boardModule
  const { markingShapes } = await server.ssrLoadModule('/src/utils/markingShapes.ts')
  const markAt = (x, y, w = 5) => ({ polygons: [[
    { x, y }, { x: x + w, y }, { x: x + w, y: y + 5 }, { x, y: y + 5 },
  ]] })
  assert.equal(markingModule.assemblyMarkCavityPolygons({ marks: [markAt(0, 0), markAt(200, 0)] }).length, 2,
    'distant labels on the same row must not be joined into one long groove')
  assert.equal(markingModule.assemblyMarkCavityPolygons({ marks: [markAt(0, 0), markAt(5, 0)] }).length, 1,
    'overlapping label cavities on the same row must merge before triangulation')
  for (const height of [3, 3.6, 4.2, 4.8, 8]) {
    for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-') {
      const rings = markingModule.pixelTextPolygons(char, 0, 0, height)
      assert.ok(markingShapes(rings).length > 0, `${char} at ${height} mm needs valid solid glyphs`)
    }
  }
  for (const mirror of [true, false]) {
    const shapes = markingShapes(markingModule.pixelTextPolygons('O', 0, 0, 4.8, 0, mirror))
    assert.equal(shapes.length, 1, 'O must be a connected stroke, not seven disconnected pixel rows')
    assert.equal(shapes[0].holes.length, 1, 'O counter must stay hollow in both preview and export')
  }
  const markingCss = await readFile(path.join(projectRoot, 'src/components/assemblyMarking/AssemblyMarkingPanel.css'), 'utf8')
  const markingPanelSource = await readFile(path.join(projectRoot, 'src/components/assemblyMarking/AssemblyMarkingPanel.tsx'), 'utf8')
  assert.match(markingCss, /\.assembly-marking-panel\s*\{[^}]*flex:\s*0 0 auto/s, 'panel must not collapse beneath the sticky split summary')
  assert.match(markingPanelSource, /snapboard:set-view-preset/, 'UI must provide a direct back-view preview action')
  assert.doesNotMatch(
    markingPanelSource,
    /useAppStore\(state\s*=>\s*state\.splitResult\?\.panels\s*\?\?\s*\[\]\)/,
    'Zustand selector must not allocate a new empty array when splitResult is null',
  )

  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220, manufacturingChamfer: 0.25 }
  const split = splitOrthogonalPolygon({ points: [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 0, y: 200 },
  ] }, cfg)
  assert.ok(split.panels.length >= 2, 'fixture must create multiple printable panels')

  // Verify every legacy mark explicitly even when the current UI defaults omit optional labels.
  const marking = { ...createDefaultAssemblyMarking(), kitCode: 'TEST', includeBrand: true, includeSeamIds: true, includeKitCode: true }
  const plan = buildAssemblyMarkPlan(split.panels, cfg, marking, 'assembly marking verification')
  assert.equal(plan.panels.length, split.panels.length)
  assert.equal(new Set(plan.panels.map(panel => panel.panelId)).size, split.panels.length, 'panel IDs must be globally unique')
  assert.ok(plan.seams.length >= 1, 'adjacent panels must produce at least one seam')
  const previewSeams = detectAssemblySeams(split.panels)
  assert.deepEqual(previewSeams, plan.seams, 'back-view seam guides must reuse the manufacturing seam coordinates')
  const seamGuide = makeBackSeamGuide(previewSeams)
  assert.ok(seamGuide, 'multi-panel assemblies need a visible back-view seam guide')
  assert.equal(seamGuide.name, 'back-seam-guides')
  assert.equal(seamGuide.children.length, previewSeams.length, 'each seam needs exactly one yellow highlight ribbon')
  assert.ok(seamGuide.children.every(child => child.userData.previewOnly === true && child.position.z < 0),
    'seam ribbons must stay on the back surface and remain preview-only')
  assert.ok(plan.panels.every(panel => panel.engravingPolygons.length > 0), `every panel needs a safe permanent mark: ${plan.warnings.join('; ')}`)
  for (const seam of plan.seams) {
    const pairMarks = plan.panels.flatMap(panel => panel.marks).filter(mark => mark.seamId === seam.id)
    assert.equal(pairMarks.length, 2, `${seam.id} must be engraved on both mating panels; ${JSON.stringify({ seam, panels: split.panels.map(p => [p.id, p.x, p.y, p.w, p.h]), warnings: plan.warnings })}`)
    assert.deepEqual(new Set(pairMarks.map(mark => mark.partnerPanelId)), new Set([seam.firstPanelId, seam.secondPanelId]))
    assert.ok(pairMarks.every(mark => /^\d{1,3}$/.test(mark.text)), `${seam.id} physical label must use a short numeric code`)
    assert.ok(pairMarks.every(mark => mark.textRotation === 0 && mark.textHeightMm >= 4.8), 'seam numbers must stay upright and never shrink below 4.8mm')
    for (const mark of pairMarks) {
      const points=mark.polygons.slice(0,-1).flat()
      const height=Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))
      assert.ok(Math.abs(height-mark.textHeightMm)<1e-4,'actual digit geometry must have its full height along the vertical slot axis')
    }
    const aligned = seam.axis === 'horizontal'
      ? Math.abs(pairMarks[0].x - pairMarks[1].x)
      : Math.abs(pairMarks[0].y - pairMarks[1].y)
    assert.ok(aligned < 1e-6, `${seam.id} arrows must face each other at the same position along the seam`)
    const edgeDistances = pairMarks.map(mark => seam.axis === 'horizontal' ? Math.abs(mark.y - seam.coordinate) : Math.abs(mark.x - seam.coordinate))
    assert.ok(edgeDistances.every(distance => distance < 7), `${seam.id} markers must stay at the seam edge`)
    assert.ok(pairMarks.every(mark => mark.textHeightMm >= 5.4), `${seam.id} should fit enlarged upright digits on a standard 200mm seam`)
  }

  const shapeFixtures = {
    L: [{ x: 0, y: 0 }, { x: 440, y: 0 }, { x: 440, y: 180 }, { x: 220, y: 180 }, { x: 220, y: 380 }, { x: 0, y: 380 }],
    U: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 400 }, { x: 340, y: 400 }, { x: 340, y: 180 }, { x: 160, y: 180 }, { x: 160, y: 400 }, { x: 0, y: 400 }],
    notch: [{ x: 0, y: 0 }, { x: 480, y: 0 }, { x: 480, y: 360 }, { x: 300, y: 360 }, { x: 300, y: 280 }, { x: 180, y: 280 }, { x: 180, y: 360 }, { x: 0, y: 360 }],
  }
  for (const [name, points] of Object.entries(shapeFixtures)) {
    const result = splitOrthogonalPolygon({ points }, cfg)
    const shapePlan = buildAssemblyMarkPlan(result.panels, cfg, marking, name)
    assert.equal(new Set(shapePlan.panels.map(panel => panel.panelId)).size, result.panels.length, `${name}: duplicate panel IDs`)
    assert.ok(shapePlan.panels.every(panel => panel.engravingPolygons.length > 0), `${name}: every printable panel needs an identity mark`)
    for (const seam of shapePlan.seams) {
      const marks = shapePlan.panels.flatMap(panel => panel.marks).filter(mark => mark.seamId === seam.id)
      assert.equal(marks.length, 2, `${name}: ${seam.id} needs two matching marks; ${JSON.stringify({ seam, panels: result.panels.map(panel => [panel.id, panel.x, panel.y, panel.w, panel.h]), warnings: shapePlan.warnings })}`)
      assert.ok(marks.every(mark => mark.textRotation === 0 && mark.textHeightMm >= 4.8), `${name}: horizontal and vertical seams must use the same upright reading direction`)
    }
  }
  const lShape = splitOrthogonalPolygon({ points: shapeFixtures.L }, cfg)
  const lShape3mf = await createManufacturing3MF({
    panels: lShape.panels, cfg, placedParts: [], projectName: 'L Marking Test', assemblyMarking: marking,
  })
  assert.ok(!lShape3mf.warnings.some(warning => warning.includes('安全回退')), `L-shape marked export fallback: ${lShape3mf.warnings.join('; ')}`)

  const singleCutRoot = generateSplitPanelMesh({
    panel: split.panels[0], cfg: { ...cfg, thickness: 0.3 }, color: 0x3ec6b0,
    includeGuides: false, manufacturingChamfer: 0,
    blindEngraving: [
      [{ x: 80, y: 80 }, { x: 86, y: 80 }, { x: 86, y: 84 }, { x: 80, y: 84 }],
      [{ x: 110, y: 80 }, { x: 116, y: 80 }, { x: 116, y: 84 }, { x: 110, y: 84 }],
    ],
  })
  for (const node of singleCutRoot.children) {
    const geometry = node.geometry.clone()
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name)
    const indexed = mergeVertices(geometry, 1e-5)
    const edgeCounts = new Map()
    const index = indexed.getIndex()
    for (let i = 0; i < index.count; i += 3) for (const [a, b] of [[index.getX(i), index.getX(i + 1)], [index.getX(i + 1), index.getX(i + 2)], [index.getX(i + 2), index.getX(i)]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
    }
    assert.equal([...edgeCounts.values()].filter(count => count !== 2).length, 0, 'separate same-row blind grooves must stay watertight')
  }

  const common = { panels: split.panels, cfg, placedParts: [], projectName: 'Assembly Marking Test' }
  const plain = await createManufacturing3MF(common)
  const marked = await createManufacturing3MF({ ...common, assemblyMarking: marking })
  assert.equal(marked.panelCount, split.panels.length)
  assert.equal(marked.markingRequestedCount, split.panels.length)
  assert.equal(marked.markingAppliedCount, split.panels.length, marked.warnings.join('; '))
  assert.equal(marked.uniqueObjectCount, split.panels.length, 'unique permanent IDs must prevent accidental object reuse')
  assert.ok(!marked.warnings.some(warning => warning.includes('安全回退')), marked.warnings.join('; '))

  const plainArchive = unzipSync(plain.data)
  const markedArchive = unzipSync(marked.data)
  assert.ok(markedArchive['Metadata/snapboard-assembly-map.json'], '3MF must include a machine-readable assembly map')
  const assemblyMap = JSON.parse(strFromU8(markedArchive['Metadata/snapboard-assembly-map.json']))
  assert.equal(assemblyMap.kitCode, 'TEST')
  assert.equal(assemblyMap.panels.length, split.panels.length)
  assert.equal(assemblyMap.seams.length, plan.seams.length)
  const report=JSON.parse(strFromU8(markedArchive['Metadata/snapboard-export-report.json']))
  assert.equal(report.marking.applied,split.panels.length)
  assert.ok(report.plates.flatMap(plate=>plate.instances).every(instance=>instance.backMarkingApplied),'report must describe actual engraved meshes')
  const tiny={...split.panels[0],id:'tiny',x:0,y:0,w:8,h:8,contour:[{x:0,y:0},{x:8,y:0},{x:8,y:8},{x:0,y:8}],slots:[],round_holes:[],edge_holes:[],cutouts:[],roundIdx:[]}
  const noRoom=await createManufacturing3MF({...common,panels:[tiny],assemblyMarking:marking})
  const noRoomZip=unzipSync(noRoom.data)
  const noRoomReport=JSON.parse(strFromU8(noRoomZip['Metadata/snapboard-export-report.json']))
  assert.equal(noRoomReport.marking.applied,0)
  assert.equal(noRoomReport.plates[0].instances[0].backMarkingApplied,false)
  assert.match(strFromU8(noRoomZip['Metadata/model_settings.config']),/背面标识未写入/,'missing marks must be visible in slicer object names')

  const triangles = data => (strFromU8(data).match(/<triangle /g) ?? []).length
  const plainTriangleCount = triangles(plainArchive['3D/Objects/object_1.model'])
  const markedTriangleCount = triangles(markedArchive['3D/Objects/object_1.model'])
  assert.ok(markedTriangleCount > plainTriangleCount, 'blind engraving must add real manufacturing geometry')

  const output = path.resolve(projectRoot, '..', '.tmp-3d-test', 'snapboard-back-assembly-marking.3mf')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, marked.data)
  const couponPanel = { ...split.panels[0], id: 'coupon', x: 0, y: 0, w: 80, h: 40,
    contour: [{x:0,y:0},{x:80,y:0},{x:80,y:40},{x:0,y:40}], slots: [], round_holes: [], edge_holes: [], inner_contours: [] }
  const coupon = await createManufacturing3MF({ panels: [couponPanel], cfg: { ...cfg, thickness: 3 }, placedParts: [], projectName: 'Rounded label coupon',
    assemblyMarking: { ...marking, includeSeamIds: false, includeOrientation: false } })
  assert.equal(coupon.markingAppliedCount, 1, coupon.warnings.join('; '))
  const couponOutput = path.resolve(projectRoot, '../output/print-debug/SnapBoard-rounded-label-coupon.3mf')
  await mkdir(path.dirname(couponOutput), { recursive: true }); await writeFile(couponOutput, coupon.data)
  // 细长小板：可用缝隙可能比粗网格步距还窄，粗网格会整体跨过去，必须靠加密搜索找回位置。
  const thinResults = []
  for (const [w, h] of [[180, 75], [200, 60], [120, 75]]) {
    const thin = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }, cfg)
    const thinPlan = buildAssemblyMarkPlan(thin.panels, cfg, marking, 'thin panel verification')
    const blocked = thinPlan.warnings.filter(warning => warning.includes('连续安全区域')).length
    const placed = thinPlan.panels.filter(panel => panel.marks.some(mark => mark.kind === 'identity')).length
    thinResults.push({ size: `${w}×${h}`, panels: thinPlan.panels.length, placed, blocked })
    assert.equal(blocked, 0, `${w}×${h} 板件应能找到板号/朝向位置：${thinPlan.warnings.join('; ')}`)
  }

  if (process.argv[2]) {
    const { workspace } = JSON.parse(await readFile(path.resolve(process.argv[2]), 'utf8'))
    const realPanels = workspace.splitResult.panels
    const realCfg = workspace.splitConfig
    const realPlan = buildAssemblyMarkPlan(realPanels, realCfg, workspace.assemblyMarking, workspace.project.metadata.name)
    assert.equal(realPlan.seams.length, 15, 'the frozen 11-panel project must retain all 15 seams')
    assert.ok(!realPlan.warnings.some(warning => warning.includes('两侧没有共同')), realPlan.warnings.join('; '))
    for (const id of ['J12', 'J14']) {
      const marks = realPlan.panels.flatMap(panel => panel.marks).filter(mark => mark.seamId === id)
      assert.equal(marks.length, 2, `${id} must have real geometry on both mating panels`)
      assert.equal(marks[0].y, marks[1].y, `${id} paired arrows must share a seam position`)
      for (const mark of marks) {
        assert.ok(mark.polygons.length > 0 && mark.textHeightMm >= 4.8 && mark.textRotation === 0)
        const cavity = markingModule.assemblyMarkCavityPolygons({ marks: [mark] })[0]
        const xs = cavity.map(point => point.x), ys = cavity.map(point => point.y)
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
        assert.ok(markingModule.placementFits(realPanels[mark.panelIndex], realCfg,
          (minX + maxX) / 2, (minY + maxY) / 2, maxX - minX, maxY - minY, 0, 0, []),
        `${id} cavity on ${mark.panelId} must clear slots, holes, cutouts and outer edges`)
      }
    }
    const real3mf = await createManufacturing3MF({
      panels: realPanels, cfg: realCfg, placedParts: [], projectName: workspace.project.metadata.name,
      assemblyMarking: workspace.assemblyMarking,
    })
    const realArchive = unzipSync(real3mf.data)
    const realReport = JSON.parse(strFromU8(realArchive['Metadata/snapboard-export-report.json']))
    assert.equal(real3mf.markingAppliedCount, realPanels.length, real3mf.warnings.join('; '))
    assert.ok(realReport.plates.flatMap(plate => plate.instances).every(instance => instance.backMarkingApplied),
      'all 11 exported 3MF panels must contain actual back engravings')
    console.log('PASS: frozen Longliang J12/J14 paired cavities and 11/11 engraved 3MF panels')
  }

  console.log(JSON.stringify({
    thinPanels: thinResults,
    panels: plan.panels.map(panel => ({ id: panel.panelId, marks: panel.marks.map(mark => ({ text: mark.text, width: mark.width, height: mark.height })), polygons: panel.engravingPolygons.length })),
    seams: plan.seams.map(seam => `${seam.id}:${seam.firstPanelId}<->${seam.secondPanelId}`),
    plainTriangleCount,
    markedTriangleCount,
    output,
  }, null, 2))
} finally {
  await server.close()
}
