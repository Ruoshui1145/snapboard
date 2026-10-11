import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
})

const rectangle = {
  id: 'old-outer', type: 'outer', name: '旧外轮廓', closed: true,
  points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }],
  constraints: [],
}

const draft = (name, width, height, kind = 'preset') => ({
  name,
  source: { kind, id: kind === 'preset' ? name : undefined, params: { width, height } },
  contours: [{
    role: 'outer',
    points: [
      { x: -width / 2, y: -height / 2 },
      { x: width / 2, y: -height / 2 },
      { x: width / 2, y: height / 2 },
      { x: -width / 2, y: height / 2 },
    ],
  }],
  warnings: [], errors: [], stats: { width, height, area: width * height, vertexCount: 4 },
})

try {
  const [{ useAppStore, prepareSplitGeometry }, { applyShapeDraft }, { transformShapeDraft }, splitEngine, projectFile] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/features/shapeLibrary/applyShape.ts'),
    server.ssrLoadModule('/src/features/shapeLibrary/model.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/projectFile.ts'),
  ])
  const initial = useAppStore.getState()
  useAppStore.setState({
    project: {
      metadata: { name: 'shape library regression', author: '', version: '0.1.0', createdAt: '2026-08-31T00:00:00.000Z' },
      config: { pixelToMM: 1, material: 'PETG' },
      parts: [{
        id: 'part-test', name: 'test', material: { name: 'PETG', thickness: 5 },
        features: [{ id: 'sketch-test', name: 'test sketch', type: 'sketch', plane: 'xy', contours: [structuredClone(rectangle)] }],
      }],
    },
    ui: { ...initial.ui, activeSketchId: 'sketch-test', selectedContourId: null },
    splitResult: null,
    splitJob: null,
    undoStack: [],
    redoStack: [],
  })

  const contours = () => useAppStore.getState().project.parts[0].features[0].contours
  const replacementIds = applyShapeDraft(draft('cloud', 100, 50), 'replace-outer')
  assert.equal(replacementIds.length, 1)
  assert.equal(contours().length, 1, 'replace must clear the previous design before adding the new outline')
  assert.equal(contours()[0].source.kind, 'preset')
  assert.deepEqual(
    contours()[0].points,
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
    'replacement must be placed in the visible right/down quadrant from the sketch origin',
  )
  assert.equal(useAppStore.getState().undoStack.length, 1, 'apply must be one undoable transaction')

  useAppStore.getState().undo()
  assert.deepEqual(
    JSON.parse(JSON.stringify(contours())),
    JSON.parse(JSON.stringify([rectangle])),
    'one undo must restore the exact previous design',
  )
  useAppStore.getState().redo()
  assert.equal(contours()[0].id, replacementIds[0])

  useAppStore.getState().undo()
  const innerIds = applyShapeDraft(draft('small-heart', 40, 20), 'insert-inner')
  assert.equal(innerIds.length, 1)
  const inserted = contours().find(contour => contour.id === innerIds[0])
  assert.equal(inserted.type, 'inner')
  assert.equal(Math.min(...inserted.points.map(point => point.x)), 80)
  assert.equal(Math.max(...inserted.points.map(point => point.x)), 120)
  assert.equal(Math.min(...inserted.points.map(point => point.y)), 40)
  assert.equal(Math.max(...inserted.points.map(point => point.y)), 60)

  useAppStore.getState().undo()
  assert.deepEqual(
    JSON.parse(JSON.stringify(contours())),
    JSON.parse(JSON.stringify([rectangle])),
    'insert-hole undo must remove only the inserted contour',
  )

  const placed = applyShapeDraft({ ...draft('placed-window', 20, 20), contours: [{ role: 'outer', points: [
    { x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 },
  ] }] }, 'insert-inner', { preservePosition: true })
  assert.equal(Math.min(...contours().find(contour => contour.id === placed[0]).points.map(point => point.x)), 20,
    'generated lightweight holes must keep their calculated board coordinates')
  const updated = applyShapeDraft({ ...draft('updated-window', 20, 20), contours: [{ role: 'outer', points: [
    { x: 45, y: 20 }, { x: 65, y: 20 }, { x: 65, y: 40 }, { x: 45, y: 40 },
  ] }] }, 'insert-inner', { preservePosition: true, replaceContourIds: placed })
  assert.equal(contours().some(contour => contour.id === placed[0]), false, 'update must remove the old lattice in one action')
  assert.equal(contours().some(contour => contour.id === updated[0]), true, 'update must add the new lattice')
  useAppStore.getState().undo()
  assert.equal(contours().some(contour => contour.id === placed[0]), true, 'one undo must restore the old lattice')
  assert.equal(contours().some(contour => contour.id === updated[0]), false, 'one undo must remove the updated lattice')
  useAppStore.getState().undo()

  assert.throws(
    () => applyShapeDraft(draft('oversized', 400, 300), 'insert-inner'),
    /超出外轮廓/,
    'oversized inner silhouettes must fail before mutating the sketch',
  )

  useAppStore.setState({
    project: {
      ...useAppStore.getState().project,
      config: { ...useAppStore.getState().project.config, pixelToMM: 0.5 },
      parts: [{
        id: 'part-scale', name: 'scale', material: { name: 'PETG', thickness: 5 },
        features: [{ id: 'sketch-scale', name: 'scale sketch', type: 'sketch', plane: 'xy', contours: [] }],
      }],
    },
    ui: { ...useAppStore.getState().ui, activeSketchId: 'sketch-scale', selectedContourId: null },
    undoStack: [], redoStack: [], splitResult: null, splitJob: null,
  })
  applyShapeDraft(draft('capsule', 420, 210), 'replace-outer')
  const scaled = contours()[0]
  const scaledWidthWorld = Math.max(...scaled.points.map(point => point.x)) - Math.min(...scaled.points.map(point => point.x))
  const scaledHeightWorld = Math.max(...scaled.points.map(point => point.y)) - Math.min(...scaled.points.map(point => point.y))
  assert.equal(scaledWidthWorld * 0.5, 420, '420 mm library width must remain 420 mm in a 0.5 mm/world-unit project')
  assert.equal(scaledHeightWorld * 0.5, 210, '210 mm library height must not collapse to 105 mm')

  const rotatedCapsule = transformShapeDraft(draft('capsule-rotated', 420, 210), {
    width: 420,
    height: 210,
    preserveAspect: false,
    rotationDegrees: 90,
  })
  applyShapeDraft(rotatedCapsule, 'replace-outer')
  const rotated = contours()[0]
  const rotatedWidthMm = (Math.max(...rotated.points.map(point => point.x)) - Math.min(...rotated.points.map(point => point.x))) * 0.5
  const rotatedHeightMm = (Math.max(...rotated.points.map(point => point.y)) - Math.min(...rotated.points.map(point => point.y))) * 0.5
  assert.ok(Math.abs(rotatedWidthMm - 210) < 1e-8, '90 degree rotation must swap the physical footprint width')
  assert.ok(Math.abs(rotatedHeightMm - 420) < 1e-8, '90 degree rotation must swap the physical footprint height')
  assert.equal(rotated.source.params.rotation, 90, 'rotation must remain traceable in contour source metadata')

  const separatedDraft = {
    ...draft('sign', 100, 50, 'image'),
    contours: [
      { role: 'outer', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 50 }, { x: 0, y: 50 }] },
      { role: 'outer', points: [{ x: 60, y: 5 }, { x: 100, y: 5 }, { x: 100, y: 45 }, { x: 60, y: 45 }] },
    ],
    stats: { width: 100, height: 50, area: 3600, vertexCount: 8 },
  }
  applyShapeDraft(separatedDraft, 'replace-outer')
  assert.equal(contours().filter(contour => contour.type === 'outer').length, 2,
    'disconnected sign components must be written as separate outer contours in one transaction')
  assert.equal(useAppStore.getState().ui.selectedContourId, null,
    'multiple sign components must leave global selection active so auto split processes every component')
  const importedPrepared = prepareSplitGeometry(contours(), 0.5, { selectedContourId: null })
  assert.equal(importedPrepared.targets.length, 2,
    'global split preparation must retain every disconnected outer component')
  assert.ok(importedPrepared.targets.every(target => target.cornerPolicy === 'preserve-source'),
    'image/SVG/preset provenance must reach the split worker as preserve-source')
  assert.equal(prepareSplitGeometry([rectangle], 1).targets[0].cornerPolicy, 'auto',
    'ordinary CAD/sketch contours must keep the existing automatic corner behavior')
  const secondOuterHole = applyShapeDraft({ ...draft('second-panel-window', 10, 10), contours: [{ role: 'outer', points: [
    { x: 70, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 20 }, { x: 70, y: 20 },
  ] }] }, 'insert-inner', { preservePosition: true })
  assert.equal(Math.min(...contours().find(contour => contour.id === secondOuterHole[0]).points.map(point => point.x)), 140,
    'absolute cutouts may land in the second outer contour of one sketch')
  useAppStore.getState().undo()

  const importedPanelResult = splitEngine.splitOrthogonalPolygon({
    points: [
      { x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 60 },
      { x: 119.73, y: 60 }, { x: 119.73, y: 60.27 },
      { x: 119.46, y: 60.27 }, { x: 119.46, y: 100 }, { x: 0, y: 100 },
    ],
    cornerPolicy: importedPrepared.targets[0].cornerPolicy,
  })
  assert.ok(importedPanelResult.panels.every(panel => (panel.roundIdx ?? []).length === 0),
    'imported silhouette stair steps must never be sent to the automatic R8 corner generator')

  const currentProject = useAppStore.getState().project
  const sourceContour = contours().find(contour => contour.source)
  const legacyContour = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }]
  const legacyPanel = {
    id: 'p1', x: 0, y: 0, w: 100, h: 50, contour: legacyContour, roundIdx: [0, 1, 2, 3],
    slots: [], round_holes: [], edge_holes: [], cutouts: [],
  }
  const restored = projectFile.restoreImportedCornerPolicy(currentProject, {
    sources: [{ contourId: sourceContour.id, sourceIds: [sourceContour.id], name: sourceContour.name, panels: [legacyPanel], warnings: [], coverageRatio: 1 }],
    panels: [legacyPanel], warnings: [], config: splitEngine.PEGBOARD_DEFAULT_CONFIG, ts: 1,
  })
  assert.deepEqual(restored.panels[0].roundIdx, [], 'opening an older imported project must clear only stale derived corner indices')
  assert.deepEqual(restored.panels[0].contour, legacyContour, 'corner migration must not move or resample panel edges')

  console.log('shape application regression: atomic replace, imported corner provenance, legacy corner migration, scaling, rotation, separated outers, inner insertion, undo/redo and containment passed')
} finally {
  await server.close()
}
