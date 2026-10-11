import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'
import polygonClipping from 'polygon-clipping'

const vite = await createServer({ root: process.cwd(), appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const [{ generateSvgLattice, svgLatticeTransform, DEFAULT_SVG_LATTICE_OPTIONS, currentSvgFace }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }, { createManufacturing3MF }, { pointInRing }, { generateOpenLattice }, { useAppStore }, { serializeProjectFile, parseProjectFile }, { createLatticeFaceMeshes }] = await Promise.all([
    vite.ssrLoadModule('/src/utils/svgLattice.ts'),
    vite.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    vite.ssrLoadModule('/src/utils/export3mf.ts'),
    vite.ssrLoadModule('/src/features/shapeLibrary/import/geometry.ts'),
    vite.ssrLoadModule('/src/utils/openLattice.ts'),
    vite.ssrLoadModule('/src/store/useAppStore.ts'),
    vite.ssrLoadModule('/src/utils/projectFile.ts'),
    vite.ssrLoadModule('/src/utils/latticeFaceMesh.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220, thickness: 5 }
  const panel = splitOrthogonalPolygon({ points: [
    { x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 160 }, { x: 0, y: 160 },
  ], holes: [] }, cfg).panels[0]
  const art = { fills: [], strokes: [
    { points: [{ x: 0, y: 80 }, { x: 160, y: 80 }], width: 1, closed: false },
    { points: [{ x: 80, y: 0 }, { x: 80, y: 160 }], width: 1, closed: false },
    { points: [{ x: 52, y: 52 }, { x: 108, y: 52 }, { x: 108, y: 108 }, { x: 52, y: 108 }], width: 1, closed: true },
  ] }
  const lattice = generateSvgLattice(panel, cfg, art)
  const transformed = svgLatticeTransform([0, 0, 100, 100], { x: 0, y: 0, w: 160, h: 160 },
    { offsetX: 10, offsetY: -5, scale: 1.5, rotationDeg: 90, flipX: true, flipY: false })
  assert.ok(Math.abs(transformed.a * 50 + transformed.c * 50 + transformed.e - 90) < 1e-6)
  assert.ok(Math.abs(transformed.b * 50 + transformed.d * 50 + transformed.f - 75) < 1e-6)
  assert.ok(transformed.b < 0, 'horizontal mirror must reverse the rotated SVG x-axis')
  const upright = svgLatticeTransform([0, 0, 100, 100], { x: 0, y: 0, w: 160, h: 160 })
  assert.ok(upright.d < 0 && Math.abs(upright.f - 155) < 1e-6,
    'SVG top must map to the top of the 3D front view, rather than displaying upside down')
  assert.ok(lattice.holes.length >= 4 && lattice.removedAreaMm2 > 1000)
  const asGeometry = holes => holes.map(hole => [[...hole.map(point => [point.x, point.y]), [hole[0].x, hole[0].y]]])
  const unsupportedVoid = polygonClipping.difference(asGeometry(lattice.holes),
    asGeometry(generateOpenLattice(panel, cfg, 3.5, 'organic').holes))
  assert.equal(unsupportedVoid.length, 0, 'legacy SVG windows must remain inside the reference backing windows; this is not a load rating')
  for (const slot of panel.slots) assert.ok(!lattice.holes.some(hole => pointInRing(slot, hole, true)), 'slot must not overlap new window')
  for (const round of panel.round_holes) assert.ok(!lattice.holes.some(hole => pointInRing(round, hole, true)), 'round hole must retain material collar')
  const { data } = await createManufacturing3MF({ panels: [{ ...panel, latticeCutouts: lattice.holes }], cfg,
    placedParts: [], partDefinitions: [] })
  const model = Object.entries(unzipSync(data)).find(([name]) => /3D\/Objects\/object_\d+\.model$/i.test(name))?.[1]
  assert.ok(model && strFromU8(model).includes('mesh'), 'SVG lattice must export a closed 3MF mesh')
  const placement = { offsetX: 12.5, offsetY: -7.5, scale: 1.3, rotationDeg: 15, flipX: true, flipY: false }
  useAppStore.setState({ splitConfig: cfg, splitResult: { panels: [panel], sources: [], warnings: [], config: cfg, ts: Date.now() } })
  useAppStore.getState().setOpenLattice([{ panel, holes: lattice.holes }], 'svg', [], '<svg viewBox="0 0 1 1"/>', placement)
  const state = useAppStore.getState()
  const saved = parseProjectFile(serializeProjectFile({ project: state.project, boards: state.boards,
    placedParts: state.placedParts, boardTexture: state.boardTexture, assemblyMarking: state.assemblyMarking,
    lastTextureSampling: state.lastTextureSampling, assemblyScene: state.assemblyScene,
    splitConfig: state.splitConfig, splitResult: state.splitResult, spatialLayout: state.spatialLayout }))
  assert.deepEqual(saved.workspace.splitResult.openLatticePlacement, placement,
    'project reopen must restore SVG position, size, rotation and mirrors')
  const faceArt = { fills: [], strokes: [
    { points: [{ x: 55, y: 60 }, { x: 105, y: 60 }, { x: 105, y: 100 }, { x: 55, y: 100 }], width: 0.3, closed: true },
    { points: [{ x: 65, y: 80 }, { x: 95, y: 80 }], width: 0.3, closed: false },
  ] }
  const options = { ...DEFAULT_SVG_LATTICE_OPTIONS }
  const fidelity = generateSvgLattice(panel, cfg, faceArt, 3.5, 'svg', options)
  assert.ok(fidelity.face && fidelity.face.layers.length === 4, 'local backing must be actual manufacturing geometry')
  assert.ok(fidelity.removedAreaMm2 > 0 && fidelity.removedAreaMm2 < generateOpenLattice(panel, cfg, 3.5, 'hex').removedAreaMm2,
    'local pad closes only some reference windows, leaving the remainder through-open')
  const detail = fidelity.face.layers.find(layer => layer.role === 'detail')
  const backing = fidelity.face.layers.find(layer => layer.role === 'backing')
  assert.equal(detail.zMax, cfg.thickness, 'two-color inlay must touch the bed together with the background')
  assert.ok(backing.zMin >= cfg.thickness - options.backingMm)
  const toMp = polygons => polygons.map(polygon => polygon.map(ring => [...ring.map(p => [p.x, p.y]), [ring[0].x, ring[0].y]]))
  const remainingThrough = polygonClipping.difference(asGeometry(fidelity.holes), toMp(backing.polygons))
  assert.ok(remainingThrough.length > 0)
  // Every functional hole remains empty in every layer; inactive circle guides never become anchors.
  for (const layer of fidelity.face.layers) for (const polygon of layer.polygons) {
    const solidAt = p => pointInRing(p, polygon[0], true) && !polygon.slice(1).some(h => pointInRing(p, h, true))
    for (const hole of [...panel.slots, ...panel.round_holes, ...panel.edge_holes.filter(h => h.knocked)])
      assert.ok(!solidAt(hole), `${layer.role} must not cap an original functional hole`)
  }
  const changedGuide = { ...panel, edge_holes: [...panel.edge_holes, { x: 87.5, y: 92.5, knocked: false }] }
  assert.deepEqual(generateSvgLattice(changedGuide, cfg, faceArt, 3.5, 'svg', options), fidelity,
    'inactive circle guides must not change the backing, details or skeleton')
  const meshes = await createLatticeFaceMeshes(fidelity.face, '#3EC6B0')
  assert.equal(meshes.length, fidelity.face.layers.length)
  assert.equal(meshes.find(mesh => mesh.userData.latticeFaceRole === 'detail').material.color.getHexString(), '263238')
  for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose() }
  const fidelityPanel = { ...panel, latticeCutouts: fidelity.holes, latticeFace: fidelity.face }
  const candidate = panel.edge_holes.find(h => !h.knocked && h.x > panel.x + 5 && h.x < panel.x + panel.w - 5 && h.y > panel.y + 5 && h.y < panel.y + panel.h - 5)
  assert.ok(candidate)
  const openedPanel = { ...fidelityPanel, edge_holes: panel.edge_holes.map(h => h === candidate ? { ...h, knocked: true } : h) }
  const openedFace = currentSvgFace(openedPanel, cfg)
  for (const layer of openedFace.layers) for (const polygon of layer.polygons)
    assert.ok(!pointInRing(candidate, polygon[0], true) || polygon.slice(1).some(r => pointInRing(candidate, r, true)),
      'opening a round hole after application must immediately cut through all cached face layers')
  assert.deepEqual(currentSvgFace({ ...fidelityPanel, latticeFace: openedFace }, cfg).layers, fidelity.face.layers,
    'closing a round hole must restore the face and original drawing')
  const thicker = currentSvgFace(fidelityPanel, { ...cfg, thickness: 6 })
  assert.equal(Math.max(...thicker.layers.map(layer => layer.zMax)), 6, 'changing thickness must update the same preview/export geometry')
  const fidelityResult = await createManufacturing3MF({ panels: [fidelityPanel], cfg, placedParts: [], partDefinitions: [] })
  const files = unzipSync(fidelityResult.data)
  const objectXml = strFromU8(Object.entries(files).find(([name]) => /3D\/Objects\/object_\d+\.model$/i.test(name))[1])
  const coordinates = [...objectXml.matchAll(/<vertex[^>]+z="([^"]+)"/g)].map(match => Number(match[1]))
  assert.ok(Math.abs(coordinates.reduce((a, b) => Math.min(a, b), Infinity)) < 1e-6 && Math.abs(coordinates.reduce((a, b) => Math.max(a, b), -Infinity) - cfg.thickness) < 1e-6,
    'face-down printing must preserve total thickness and contact the bed at z=0')
  const settings = strFromU8(files['Metadata/model_settings.config'])
  assert.ok(settings.includes('局部细节托底') && settings.includes('双色镶嵌线稿') && /key="extruder" value="2"/.test(settings),
    'manufacturing file must include the real backing and second-material detail')
  const mono = { ...options, contrastColor: undefined }
  const monoResult = generateSvgLattice(panel, cfg, faceArt, 3.5, 'svg', mono)
  assert.deepEqual(monoResult.face.layers.filter(layer => layer.role !== 'detail'), fidelity.face.layers.filter(layer => layer.role !== 'detail'))
  assert.ok(Math.abs(cfg.thickness - monoResult.face.layers.find(layer => layer.role === 'detail').zMax - 0.2) < 1e-6,
    'single-color linework needs a real recess to remain visible without a second material')
  const fillArt = { fills: [[[[[50, 80], [110, 80], [110, 80.2], [50, 80.2], [50, 80]]]]], strokes: [] }
  const filled = generateSvgLattice(panel, cfg, fillArt, 3.5, 'svg', options)
  const filledDetail = filled.face.layers.find(layer => layer.role === 'detail')
  const ys = filledDetail.polygons.flatMap(p => p.flatMap(r => r.map(v => v.y)))
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1,
    'filled SVG linework must also be widened; stroke-only width controls cannot protect traced drawings')
  await assert.rejects(createManufacturing3MF({ panels: [fidelityPanel], cfg, placedParts: [], partDefinitions: [],
    boardTexture: { ...useAppStore.getState().boardTexture, enabled: true, source: 'material' } }), /暂不能与纹理工作室叠加/)
  useAppStore.getState().setOpenLattice([{ panel, holes: fidelity.holes, face: fidelity.face }], 'svg', [], '<svg viewBox="0 0 1 1"/>', placement, options)
  const faceState = useAppStore.getState()
  const faceSaved = parseProjectFile(serializeProjectFile({ project: faceState.project, boards: faceState.boards,
    placedParts: faceState.placedParts, boardTexture: faceState.boardTexture, assemblyMarking: faceState.assemblyMarking,
    lastTextureSampling: faceState.lastTextureSampling, assemblyScene: faceState.assemblyScene,
    splitConfig: faceState.splitConfig, splitResult: faceState.splitResult, spatialLayout: faceState.spatialLayout }))
  assert.deepEqual(faceSaved.workspace.splitResult.panels[0].latticeFace, fidelity.face)
  assert.deepEqual(faceSaved.workspace.splitResult.openLatticeSvgOptions, options)
  useAppStore.getState().clearOpenLattice()
  assert.equal(useAppStore.getState().splitResult.panels[0].latticeFace, undefined)
  useAppStore.getState().undo()
  assert.deepEqual(useAppStore.getState().splitResult.panels[0].latticeFace, fidelity.face, 'undo must restore the actual face layers')
  console.log(`SVG lattice: ${lattice.holes.length} through-windows, ${Math.round(lattice.removedAreaMm2)} mm² removed; 3MF OK`)
  console.log(`Wall-mounted SVG fidelity: ${fidelity.face.layers.length} closed layers; holes, second material, face-down export, save/reopen and undo OK`)
} finally { await vite.close() }
