import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
})

try {
  const [{ useAppStore }, { TrimStandaloneArcRangeCommand }] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/commands/SketchCommands.ts'),
  ])

  const constraint = {
    id: 'radius-constraint',
    type: 'radius',
    edgeIndex: 0,
    value: 10,
    labelPos: { x: 4, y: 4 },
    driving: true,
    label: 'R10.0 mm',
  }
  const original = {
    id: 'arc-target',
    type: 'outer',
    name: '独立圆弧',
    closed: false,
    points: [{ x: 10, y: 0 }, { x: 0, y: -10 }],
    originAnchorIdx: 0,
    // Store-level history checks intentionally keep this unconstrained: execute/undo/redo
    // asynchronously refresh solve states, and this command regression must not depend on
    // loading the Planegcs WASM binary in Node.
    constraints: [],
    arcs: [{
      id: 'arc-original',
      p1: 0,
      p2: 1,
      center: { x: 0, y: 0 },
      radius: 10,
      sweep: 'ccw',
    }],
  }
  const guardBefore = {
    id: 'guard-before', type: 'outer', name: 'before', closed: false,
    points: [{ x: -20, y: 0 }, { x: -10, y: 0 }], constraints: [],
  }
  const guardAfter = {
    id: 'guard-after', type: 'outer', name: 'after', closed: false,
    points: [{ x: 20, y: 0 }, { x: 30, y: 0 }], constraints: [],
  }

  const reset = (source = original) => {
    const state = useAppStore.getState()
    useAppStore.setState({
      project: {
        metadata: {
          name: 'arc trim regression', author: '', version: '0.1.0',
          createdAt: '2026-08-30T00:00:00.000Z',
        },
        config: { pixelToMM: 1, material: 'PETG' },
        parts: [{
          id: 'part-test', name: 'test', material: { name: 'PETG', thickness: 5 },
          features: [{
            id: 'sketch-test', name: 'test sketch', type: 'sketch', plane: 'xy',
            contours: [structuredClone(guardBefore), structuredClone(source), structuredClone(guardAfter)],
          }],
        }],
      },
      ui: { ...state.ui, activeSketchId: 'sketch-test' },
      splitResult: null,
      splitJob: null,
      undoStack: [],
      redoStack: [],
    })
  }
  const contours = () => useAppStore.getState().project.parts[0].features[0].contours
  const ids = () => contours().map(contour => contour.id)

  reset()
  const trim = new TrimStandaloneArcRangeCommand('arc-target', 0.25, 0.75, 'arc-remainder')
  useAppStore.getState().execute(trim)

  assert.equal(useAppStore.getState().undoStack.length, 1,
    'a successful arc interval trim must immediately enable undo')
  assert.equal(useAppStore.getState().redoStack.length, 0)
  assert.deepEqual(ids(), ['guard-before', 'arc-target', 'arc-remainder', 'guard-after'],
    'both arc remainders must replace the source at its original position')
  const firstExecution = structuredClone(contours().slice(1, 3))
  assert.ok(firstExecution.every(contour => contour.points.length === 2 && contour.arcs?.length === 1))
  assert.notEqual(firstExecution[0].arcs[0].id, firstExecution[1].arcs[0].id,
    'two retained arc pieces must own independent arc entities')

  // The command must own snapshots, not aliases into the live project.
  contours()[1].points[0].x = 999
  contours()[1].arcs[0].center.x = 999
  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().undoStack.length, 0)
  assert.equal(useAppStore.getState().redoStack.length, 1,
    'undo must move the command to redo history')
  assert.deepEqual(ids(), ['guard-before', 'arc-target', 'guard-after'])
  assert.deepEqual(JSON.parse(JSON.stringify(contours()[1])), original,
    'undo must restore the complete original contour, including constraints and arc identity')

  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().undoStack.length, 1,
    'redo must return the command to undo history')
  assert.equal(useAppStore.getState().redoStack.length, 0)
  assert.deepEqual(contours().slice(1, 3), firstExecution,
    'redo must replay the cached result and must not preserve mutations made after execute')

  useAppStore.getState().undo()
  assert.deepEqual(JSON.parse(JSON.stringify(contours()[1])), original,
    'a second undo after redo must still restore the exact source snapshot')

  // Boundary trims leave only one remainder. It must retain the source contour id so
  // downstream selection and subsequent undo/redo remain stable.
  reset()
  useAppStore.getState().execute(
    new TrimStandaloneArcRangeCommand('arc-target', 0, 0.4, 'unused-remainder'),
  )
  assert.deepEqual(ids(), ['guard-before', 'arc-target', 'guard-after'])
  assert.equal(contours()[1].arcs?.length, 1)
  assert.equal(useAppStore.getState().undoStack.length, 1)
  useAppStore.getState().undo()
  assert.deepEqual(JSON.parse(JSON.stringify(contours()[1])), original)
  useAppStore.getState().redo()
  assert.deepEqual(ids(), ['guard-before', 'arc-target', 'guard-after'])
  assert.equal(useAppStore.getState().undoStack.length, 1)

  // Deep restoration of constraints is a command concern rather than a store-history
  // concern. Verify it without invoking the store's asynchronous solver refresh.
  const constrainedOriginal = { ...structuredClone(original), constraints: [constraint] }
  reset(constrainedOriginal)
  const direct = new TrimStandaloneArcRangeCommand('arc-target', 0.2, 0.8, 'direct-remainder')
  direct.execute()
  contours()[1].points[0].x = 1234
  direct.undo()
  assert.deepEqual(JSON.parse(JSON.stringify(contours()[1])), constrainedOriginal,
    'the command snapshot must restore constraints, labels and the original arc entity')

  console.log('arc trim command regression: execute/undo/redo history, ordering and snapshots passed')
} finally {
  await server.close()
}
