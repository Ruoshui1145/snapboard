import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(), appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
})

const outer = {
  id: 'outer-a', type: 'outer', name: 'A', closed: true,
  points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }],
  constraints: [], source: { kind: 'image', params: {} },
}
const inner = {
  id: 'inner-b', type: 'inner', name: 'B', closed: true,
  points: [{ x: 10, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 15 }, { x: 10, y: 15 }],
  constraints: [],
}

try {
  const [storeModule, commands, commandModule, geometry] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/commands/SketchCommands.ts'),
    server.ssrLoadModule('/src/commands/Command.ts'),
    server.ssrLoadModule('/src/utils/selectionTransform.ts'),
  ])
  const { useAppStore } = storeModule
  const { UpdateContourPointsCommand } = commands
  const { CompositeCommand } = commandModule
  const {
    contourInsideMarquee,
    isBoxTransformSafe,
    selectionBounds,
    transformContourGeometry,
  } = geometry

  const bounds = selectionBounds([outer, inner])
  assert.deepEqual(bounds.center, { x: 20, y: 10 })
  assert.equal(bounds.width, 40)
  assert.equal(bounds.height, 20)
  assert.equal(contourInsideMarquee(inner, { x: 8, y: 3 }, { x: 22, y: 17 }), true)
  assert.equal(contourInsideMarquee(outer, { x: 8, y: 3 }, { x: 22, y: 17 }), false)
  assert.equal(isBoxTransformSafe(outer), true)
  assert.equal(isBoxTransformSafe({ ...outer, constraints: [{ id: 'c', type: 'length', value: 40, labelPos: { x: 20, y: 0 }, driving: true, label: '40' }] }), false)

  const rotated = transformContourGeometry(outer, {
    center: bounds.center,
    scale: 2,
    rotation: Math.PI / 2,
  })
  const rotatedBounds = selectionBounds([{ ...outer, ...rotated.patch, points: rotated.points }])
  assert.ok(Math.abs(rotatedBounds.width - 40) < 1e-8)
  assert.ok(Math.abs(rotatedBounds.height - 80) < 1e-8)
  assert.equal(rotated.patch.source.params.selectionScale, 2)
  assert.ok(Math.abs(rotated.patch.source.params.rotation - 90) < 1e-8)

  const initial = useAppStore.getState()
  useAppStore.setState({
    project: {
      metadata: { name: 'selection transform', author: '', version: '0.1.0', createdAt: '2026-09-01T00:00:00.000Z' },
      config: { pixelToMM: 1, material: 'PETG' },
      parts: [{
        id: 'part', name: 'part', material: { name: 'PETG', thickness: 5 },
        features: [{ id: 'sketch', name: 'sketch', type: 'sketch', plane: 'xy', contours: [structuredClone(outer), structuredClone(inner)] }],
      }],
    },
    ui: { ...initial.ui, activeSketchId: 'sketch', selectedContourId: null, selectedContourIds: [] },
    undoStack: [], redoStack: [], splitResult: null, splitJob: null,
  })
  const contours = () => useAppStore.getState().project.parts[0].features[0].contours
  const move = { center: bounds.center, translateX: 30, translateY: 15 }
  const commandsToRun = contours().map(contour => {
    const result = transformContourGeometry(contour, move)
    return new UpdateContourPointsCommand(contour.id, contour.points, result.points, result.patch)
  })
  useAppStore.getState().execute(new CompositeCommand('移动选择组', commandsToRun))
  assert.equal(useAppStore.getState().undoStack.length, 1)
  assert.deepEqual(contours()[0].points[0], { x: 30, y: 15 })
  assert.deepEqual(contours()[1].points[0], { x: 40, y: 20 })
  useAppStore.getState().undo()
  assert.deepEqual(contours()[0].points, outer.points)
  assert.deepEqual(contours()[1].points, inner.points)

  useAppStore.getState().setUI({ selectedContourIds: ['outer-a', 'inner-b'] })
  assert.equal(useAppStore.getState().ui.selectedContourId, 'outer-a')
  assert.deepEqual(useAppStore.getState().ui.selectedContourIds, ['outer-a', 'inner-b'])

  console.log('selection transform regression: marquee, group bounds, move/scale/rotate, metadata and atomic undo passed')
} finally {
  await server.close()
}
