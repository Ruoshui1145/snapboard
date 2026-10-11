import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import * as THREE from 'three'

const vite = await createServer({ root: process.cwd(), appType: 'custom', logLevel: 'error', server: { middlewareMode: true } })
try {
  const [{ generateOpenLattice, openLatticePlanSvg, roundLatticeWindowCorners }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }, { createManufacturing3MF }, { useAppStore }, { applyShapeDraft }, { generateSplitPanelMesh }, { pointInRing }, { serializeProjectFile, parseProjectFile }] = await Promise.all([
    vite.ssrLoadModule('/src/utils/openLattice.ts'),
    vite.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    vite.ssrLoadModule('/src/utils/export3mf.ts'),
    vite.ssrLoadModule('/src/store/useAppStore.ts'),
    vite.ssrLoadModule('/src/features/shapeLibrary/applyShape.ts'),
    vite.ssrLoadModule('/src/utils/boardMesh.ts'),
    vite.ssrLoadModule('/src/features/shapeLibrary/import/geometry.ts'),
    vite.ssrLoadModule('/src/utils/projectFile.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, thickness: 5, bedW: 220, bedH: 220 }
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  const roundedSquare = roundLatticeWindowCorners(square, 1.2)
  const areaOf = ring => Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2
  assert.ok(roundedSquare.length > 4 && areaOf(roundedSquare) < 100,
    'lattice window corners must be rounded inward, retaining material around junctions')
  const contour = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 160 }, { x: 0, y: 160 }]
  const original = splitOrthogonalPolygon({ points: contour, holes: [] }, cfg)
  assert.equal(original.panels.length, 1)
  const panel = original.panels[0]
  const design = generateOpenLattice(panel, cfg, 3.5, 'diamond')
  const thinner = generateOpenLattice(panel, cfg, 2.5, 'diamond')
  const organic = generateOpenLattice(panel, cfg, 3.5, 'organic')
  const hexFrame = generateOpenLattice(panel, cfg, 3.5, 'hex')
  assert.ok(hexFrame.holes.length >= 12 && hexFrame.holes.some(ring => {
    const xs = ring.map(point => point.x), ys = ring.map(point => point.y)
    return Math.max(...xs) - Math.min(...xs) > 15 && Math.max(...ys) - Math.min(...ys) > 15
  }), '200mm reference style must retain its large connected-frame windows')
  const center = ring => ({ x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
    y: ring.reduce((sum, point) => sum + point.y, 0) / ring.length })
  const sampleHexHole = hexFrame.holes.find(ring => pointInRing(center(ring), ring, false))
  assert.ok(sampleHexHole, 'hex frame must expose a real interior window')
  const hexPanel = splitOrthogonalPolygon({ points: contour, holes: [], passiveHoles: hexFrame.holes }, cfg).panels[0]
  const hexMesh = generateSplitPanelMesh({ panel: hexPanel, cfg, color: 0x3ec6b0, curveSegments: 8, includeGuides: false })
  hexMesh.updateMatrixWorld(true)
  const sample = center(sampleHexHole)
  const ray = new THREE.Raycaster(new THREE.Vector3(sample.x, sample.y, 100), new THREE.Vector3(0, 0, -1))
  assert.equal(ray.intersectObject(hexMesh, true).length, 0, '3D hex-frame preview must contain a real through-window')
  const withoutUnopenedHoles = { ...panel, edge_holes: panel.edge_holes.filter(hole => hole.knocked) }
  assert.ok(panel.edge_holes.some(hole => !hole.knocked), 'fixture needs unopened round-hole candidates')
  for (const style of ['organic', 'hex', 'diamond']) {
    assert.deepEqual(generateOpenLattice(panel, cfg, 3.5, style).holes,
      generateOpenLattice(withoutUnopenedHoles, cfg, 3.5, style).holes,
      `unopened round-hole candidates must not change the ${style} lattice`)
  }
  const candidate = panel.edge_holes.find(hole => !hole.knocked)
  assert.ok(candidate, 'fixture needs an unopened round-hole candidate')
  const punchedPanel = { ...panel, edge_holes: panel.edge_holes.map(hole => hole === candidate ? { ...hole, knocked: true } : hole) }
  for (const style of ['organic', 'hex', 'diamond']) {
    const lattice = generateOpenLattice(punchedPanel, cfg, 3.5, style)
    assert.ok(!lattice.holes.some(ring => pointInRing(candidate, ring, true)),
      `a real round hole must remain outside ${style} cutout windows`)
  }
  const punchedHex = generateOpenLattice(punchedPanel, cfg, 3.5, 'hex')
  const punchedMesh = generateSplitPanelMesh({ panel: { ...punchedPanel, cutouts: punchedHex.holes }, cfg,
    color: 0x3ec6b0, curveSegments: 8, includeGuides: false })
  punchedMesh.updateMatrixWorld(true)
  const roundRay = new THREE.Raycaster(new THREE.Vector3(candidate.x, candidate.y, 100), new THREE.Vector3(0, 0, -1))
  assert.equal(roundRay.intersectObject(punchedMesh, true).length, 0, 'opened round hole must remain a real 3D through-hole')
  assert.ok(!openLatticePlanSvg(panel, organic, cfg).includes('<circle'),
    'unopened round-hole candidates must not appear as structural holes in the plan')
  assert.ok(thinner.removedAreaMm2 >= design.removedAreaMm2, 'narrower ribs should not reduce open area')
  assert.ok(design.holes.length >= 8, 'a mesh should have many connected windows')
  assert.ok(design.removedAreaMm2 > 2500, 'windows should remove meaningful area')
  const split = splitOrthogonalPolygon({ points: contour, holes: [], passiveHoles: design.holes }, cfg)
  assert.equal(split.panels.reduce((n, p) => n + p.slots.length, 0), panel.slots.length)
  const output = await createManufacturing3MF({ panels: split.panels, cfg, placedParts: [], partDefinitions: [] })
  assert.ok(output.data.length > 1000, 'open lattice must export a closed 3MF')
  const organicSplit = splitOrthogonalPolygon({ points: contour, holes: [], passiveHoles: organic.holes }, cfg)
  assert.equal(organicSplit.panels.reduce((n, p) => n + p.slots.length, 0), panel.slots.length)
  // Newly cut windows may consume unused candidate markers; only functional slots must survive.
  const organicOutput = await createManufacturing3MF({ panels: organicSplit.panels, cfg, placedParts: [], partDefinitions: [] })
  assert.ok(organicOutput.data.length > 1000, 'organic lattice must export a closed 3MF')
  for (const style of ['organic', 'hex', 'diamond']) {
    const lattice = generateOpenLattice(panel, cfg, 3.5, style)
    const manufactured = splitOrthogonalPolygon({ points: contour, holes: [], passiveHoles: lattice.holes }, cfg)
    assert.equal(manufactured.panels.length, original.panels.length,
      `${style} must keep the whole board connected after edge-window clipping`)
    assert.equal(manufactured.panels.reduce((n, item) => n + item.slots.length, 0), panel.slots.length,
      `${style} must keep every functional slot`)
    assert.ok(lattice.holes.filter(ring => ring.some(point =>
      Math.min(point.x - panel.x, panel.x + panel.w - point.x, point.y - panel.y, panel.y + panel.h - point.y) < 12)).length >= 4,
      `${style} must retain partial windows along the board edge`)
    assert.ok(!manufactured.warnings.some(warning => warning.includes('跨板') || warning.includes('无法在当前模数分板')),
      `${style} windows must not cause seam replanning warnings`)
    assert.ok((await createManufacturing3MF({ panels: manufactured.panels, cfg, placedParts: [], partDefinitions: [] })).data.length > 1000,
      `${style} must export a closed 3MF`)
  }
  const largeCfg = { ...cfg, bedW: 300, bedH: 300, bedKeepouts: [] }
  const oversizedRounded = splitOrthogonalPolygon({ points: [
    { x: 0, y: 0 }, { x: 220, y: 0 }, { x: 220, y: 160 }, { x: 0, y: 160 },
  ], holes: [] }, largeCfg).panels[0]
  const extendedRounded = generateOpenLattice(oversizedRounded, largeCfg, 3.5, 'hex')
  const extendedSplit = splitOrthogonalPolygon({ points: [
    { x: 0, y: 0 }, { x: 220, y: 0 }, { x: 220, y: 160 }, { x: 0, y: 160 },
  ], holes: [], passiveHoles: extendedRounded.holes }, largeCfg)
  assert.equal(extendedSplit.panels[0].slots.length, oversizedRounded.slots.length,
    '200mm source must extend its own periodic windows without losing slots on a 220mm board')
  assert.ok(extendedRounded.holes.length > 20, 'extended 200mm source must avoid a wide solid edge strip')
  for (const [size, style] of [[200, 'hex'], [240, 'hex'], [240, 'diamond'], [240, 'organic']]) {
    const sourceOutline = [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }]
    const sourcePanel = splitOrthogonalPolygon({ points: sourceOutline, holes: [] }, largeCfg).panels[0]
    const sourcePlan = generateOpenLattice(sourcePanel, largeCfg, 3.5, style)
    const sourceSplit = splitOrthogonalPolygon({ points: sourceOutline, holes: [], passiveHoles: sourcePlan.holes }, largeCfg)
    assert.equal(sourceSplit.panels.reduce((n, item) => n + item.slots.length, 0), sourcePanel.slots.length,
      `${style} must retain SnapBoard slots at the source 3MF size`)
    assert.ok((await createManufacturing3MF({ panels: sourceSplit.panels, cfg: largeCfg, placedParts: [], partDefinitions: [] })).data.length > 1000,
      `${style} source-size geometry must export a closed 3MF`)
  }
  const tallContour = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 200 }, { x: 0, y: 200 }]
  const tallPanel = splitOrthogonalPolygon({ points: tallContour, holes: [] }, cfg).panels[0]
  const tallOrganic = generateOpenLattice(tallPanel, cfg, 4, 'organic')
  assert.ok(tallOrganic.holes.length > 30, '4mm organic ribs on a tall panel must not crash polygon union')
  const tallSplit = splitOrthogonalPolygon({ points: tallContour, holes: [], passiveHoles: tallOrganic.holes }, cfg)
  assert.equal(tallSplit.panels.reduce((n, p) => n + p.slots.length, 0), tallPanel.slots.length)
  assert.ok((await createManufacturing3MF({ panels: tallSplit.panels, cfg, placedParts: [], partDefinitions: [] })).data.length > 1000,
    'the previously failing 4mm tall-panel lattice must export a closed 3MF')
  const previewMesh = generateSplitPanelMesh({ panel: tallSplit.panels[0], cfg, color: 0x3ec6b0, curveSegments: 8, includeGuides: false })
  const fullMesh = generateSplitPanelMesh({ panel: tallSplit.panels[0], cfg, color: 0x3ec6b0, curveSegments: 24, includeGuides: false })
  const vertexCount = root => { let count = 0; root.traverse(object => { if (object.isMesh) count += object.geometry.getAttribute('position').count }); return count }
  assert.ok(vertexCount(previewMesh) < vertexCount(fullMesh), '3D interaction mesh must use fewer vertices than full-resolution geometry')
  assert.ok(generateOpenLattice({ ...tallPanel, contour: [...tallPanel.contour, tallPanel.contour[0]] }, cfg, 4, 'organic').holes.length > 30,
    'a repeated closing contour point must not create a zero-length beam')
  const wideContour = [{ x: 0, y: 0 }, { x: 320, y: 0 }, { x: 320, y: 160 }, { x: 0, y: 160 }]
  const wide = splitOrthogonalPolygon({ points: wideContour, holes: [] }, cfg)
  assert.ok(wide.panels.length >= 2, 'wide board must exercise multi-panel geometry')
  const wideHoles = wide.panels.flatMap(item => generateOpenLattice(item, cfg, 3.5, 'organic').holes)
  const wideResult = splitOrthogonalPolygon({ points: wideContour, holes: [], passiveHoles: wideHoles }, cfg)
  assert.equal(wideResult.panels.length, wide.panels.length, 'lattice windows must not repartition the board')
  assert.ok(!wideResult.warnings.some(warning => warning.includes('跨板') || warning.includes('无法在当前模数分板')),
    'multi-panel lattice windows must not trigger seam replanning warnings')
  assert.equal(wideResult.panels.reduce((n, p) => n + p.slots.length, 0), wide.panels.reduce((n, p) => n + p.slots.length, 0),
    'multi-panel lattice must keep all functional slots')
  const wideOutput = await createManufacturing3MF({ panels: wideResult.panels, cfg, placedParts: [], partDefinitions: [] })
  assert.ok(wideOutput.data.length > 1000, 'multi-panel lattice must export a closed 3MF')
  const extendedOutline = [{ x: 0, y: 0 }, { x: 440, y: 0 }, { x: 440, y: 200 }, { x: 0, y: 200 }]
  const extendedCfg = { ...cfg, bedW: 256, bedH: 256, bedKeepouts: [] }
  const extendedBase = splitOrthogonalPolygon({ points: extendedOutline, holes: [] }, extendedCfg)
  assert.ok(extendedBase.panels.some(item => item.w > 200), 'fixture must exercise a panel wider than the 200mm source')
  const extendedHoles = extendedBase.panels.flatMap(item => generateOpenLattice(item, extendedCfg, 3.5, 'hex').holes)
  const extendedBoards = splitOrthogonalPolygon({ points: extendedOutline, holes: [], passiveHoles: extendedHoles }, extendedCfg)
  assert.equal(extendedBoards.panels.length, extendedBase.panels.length, 'periodic source must not repartition two boards')
  assert.equal(extendedBoards.panels.reduce((n, item) => n + item.slots.length, 0),
    extendedBase.panels.reduce((n, item) => n + item.slots.length, 0),
    'periodic 200mm source must keep all functional slots across two boards')
  const initialState = useAppStore.getState()
  useAppStore.setState({
    project: {
      metadata: { name: 'lattice integration', author: '', version: '0.1.0', createdAt: '2026-09-28T00:00:00.000Z' },
      config: { pixelToMM: 1, material: 'PETG' },
      parts: [{ id: 'part', name: 'part', material: { name: 'PETG', thickness: 5 }, features: [{
        id: 'sketch', name: 'sketch', type: 'sketch', plane: 'xy', contours: [{
          id: 'outer', name: 'outer', type: 'outer', closed: true, points: contour.map(point => ({ x: point.x, y: -point.y })), constraints: [],
        }],
      }] }],
    },
    ui: { ...initialState.ui, activeSketchId: 'sketch', selectedContourId: null, viewMode: '3d' },
    splitConfig: cfg,
    splitResult: { sources: [{ contourId: 'outer', sourceIds: ['outer'], name: 'outer', panels: original.panels, warnings: [], coverageRatio: 1 }],
      panels: original.panels, warnings: [], config: cfg, ts: 1 },
    splitJob: null, undoStack: [], redoStack: [],
  })
  const viewTransitions = []
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.ui.viewMode !== previous.ui.viewMode) viewTransitions.push(state.ui.viewMode)
  })
  useAppStore.getState().setOpenLattice([{ panel, holes: organic.holes }], 'organic')
  const firstCutouts = useAppStore.getState().splitResult.panels[0].latticeCutouts
  assert.equal(firstCutouts.length, organic.holes.length, '3D manufacturing layer must update immediately')
  assert.equal(useAppStore.getState().project.parts[0].features[0].contours.length, 1,
    'new lattice must not write hundreds of sketch contours')
  assert.deepEqual(useAppStore.getState().splitResult.panels[0].cutouts ?? [], panel.cutouts ?? [],
    'manufacturing lattice must leave the base sketch cutouts unchanged')
  assert.equal(useAppStore.getState().splitJob, null, 'lattice update must not re-run board partitioning')
  const hex = generateOpenLattice(panel, cfg, 3.5, 'hex')
  useAppStore.getState().setOpenLattice([{ panel, holes: hex.holes }], 'hex')
  assert.equal(useAppStore.getState().ui.viewMode, '3d', 'lattice update must stay in the active 3D workspace')
  assert.ok(!viewTransitions.includes('2d'), 'lattice apply/update must never stop the 3D render loop via a transient 2D mode')
  assert.notDeepEqual(useAppStore.getState().splitResult.panels[0].latticeCutouts, firstCutouts,
    '3D panel geometry must refresh immediately after replacing the lattice')
  const independentOutput = await createManufacturing3MF({ panels: useAppStore.getState().splitResult.panels,
    cfg, placedParts: [], partDefinitions: [] })
  assert.ok(independentOutput.data.length > 1000, 'independent lattice data must export as a closed 3MF')
  assert.ok(!independentOutput.warnings.some(warning => warning.includes('关闭倒角') || warning.includes('倒角已从')),
    'manufacturing lattice must retain the requested edge chamfer')
  const savedState = useAppStore.getState()
  const saved = parseProjectFile(serializeProjectFile({
    project: savedState.project, boards: savedState.boards, placedParts: savedState.placedParts,
    boardTexture: savedState.boardTexture, assemblyMarking: savedState.assemblyMarking,
    lastTextureSampling: savedState.lastTextureSampling, assemblyScene: savedState.assemblyScene,
    splitConfig: savedState.splitConfig, splitResult: savedState.splitResult,
    spatialLayout: savedState.spatialLayout,
  }))
  assert.equal(saved.workspace.splitResult.panels[0].latticeCutouts.length, hex.holes.length,
    'saved project must retain independent manufacturing lattice')
  useAppStore.getState().undo()
  assert.deepEqual(useAppStore.getState().splitResult.panels[0].latticeCutouts, firstCutouts,
    'one undo must restore the prior manufacturing lattice')
  useAppStore.getState().clearOpenLattice()
  assert.equal(useAppStore.getState().splitResult.panels[0].latticeCutouts, undefined,
    'removing lattice must leave the base panel intact')
  unsubscribe()
  const draftFor = lattice => ({
    name: 'legacy lattice', source: { kind: 'preset', id: 'open-lattice-v1', params: { style: 'organic' } },
    contours: lattice.holes.map(ring => ({ role: 'outer', points: ring.map(point => ({ x: point.x, y: -point.y })) })),
    warnings: [], errors: [], stats: { width: 160, height: 160, vertexCount: lattice.holes.flat().length },
  })
  useAppStore.setState({ splitResult: { sources: [{ contourId: 'outer', sourceIds: ['outer'], name: 'outer',
    panels: original.panels, warnings: [], coverageRatio: 1 }], panels: original.panels, warnings: [], config: cfg, ts: 2 },
    undoStack: [], redoStack: [] })
  const legacyIds = applyShapeDraft(draftFor(organic), 'insert-inner', { preservePosition: true, viewMode: '3d' })
  await new Promise(resolve => setTimeout(resolve, 0))
  useAppStore.getState().setOpenLattice([{ panel, holes: hex.holes }], 'hex', legacyIds)
  assert.equal(useAppStore.getState().project.parts[0].features[0].contours.length, 1,
    'legacy sketch lattice must migrate into independent manufacturing data')
  useAppStore.getState().undo()
  assert.ok(useAppStore.getState().project.parts[0].features[0].contours.some(item => legacyIds.includes(item.id)),
    'one undo must restore the previous legacy sketch lattice')
  if (process.argv.includes('--write-plan')) {
    await writeFile('docs/assets/open-lattice-organic-review.svg', openLatticePlanSvg(panel, organic, cfg))
    await writeFile('docs/assets/open-lattice-hex-review.svg', openLatticePlanSvg(panel, hexFrame, cfg))
    await writeFile('docs/assets/open-lattice-diamond-review.svg', openLatticePlanSvg(panel, design, cfg))
    await writeFile('docs/assets/open-lattice-voronoi-snapboard-160mm.3mf', organicOutput.data)
  }
  console.log(`Open lattice passed: diamond ${design.holes.length}/${(design.removedAreaMm2 / (panel.w * panel.h) * 100).toFixed(1)}%, organic ${organic.holes.length}/${(organic.removedAreaMm2 / (panel.w * panel.h) * 100).toFixed(1)}%, hex frame ${hexFrame.holes.length}/${(hexFrame.removedAreaMm2 / (panel.w * panel.h) * 100).toFixed(1)}%, ${wide.panels.length}-panel closed 3MF`)
} finally { await vite.close() }
