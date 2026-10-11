import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
})

const constraint = (id, extra = {}) => ({
  id,
  type: 'distance',
  value: 20,
  labelPos: { x: 10, y: 10 },
  driving: true,
  label: '距离 20.0 mm',
  ...extra,
})

const polygon = {
  id: 'hex-hole', type: 'inner', name: '正六边形内孔', shape: 'polygon', closed: true,
  center: { x: 50, y: 50 }, radius: 20, polygonCircumscribed: false, rotation: 0,
  points: Array.from({ length: 6 }, (_, index) => ({
    x: 50 + 20 * Math.cos(index * Math.PI / 3),
    y: 50 + 20 * Math.sin(index * Math.PI / 3),
  })),
  constraints: [constraint('hex-radius', { type: 'radius', value: 20, label: 'R 20.0 mm' })],
}
const custom = {
  id: 'custom-hole', type: 'inner', name: '自定义内孔', closed: true,
  points: [{ x: 80, y: 20 }, { x: 100, y: 20 }, { x: 95, y: 40 }, { x: 80, y: 35 }],
  constraints: [],
}
const slot = {
  id: 'slot-hole', type: 'inner', name: '槽口内孔', closed: true,
  points: [{ x: 20, y: 80 }, { x: 60, y: 80 }], slotWidth: 10,
  slotParams: { length: 50, width: 10 }, constraints: [],
}
const circle = {
  id: 'circle-hole', type: 'inner', name: '圆内孔', shape: 'circle', closed: true,
  center: { x: 100, y: 80 }, radius: 10,
  points: Array.from({ length: 32 }, (_, index) => ({
    x: 100 + 10 * Math.cos(index * Math.PI / 16),
    y: 80 + 10 * Math.sin(index * Math.PI / 16),
  })),
  constraints: [],
}
const outer = {
  id: 'outer', type: 'outer', name: '外轮廓', closed: true,
  points: [{ x: 0, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 110 }, { x: 0, y: 110 }],
  constraints: [
    constraint('outer-width', { type: 'length', edgeIndex: 0, value: 140, label: '宽 140.0 mm' }),
    constraint('hex-to-bottom', { edgeIndex: 0, contourId2: 'hex-hole', vertexIdx1: -2 }),
    constraint('custom-to-left', { edgeIndex: 3, contourId2: 'custom-hole', vertexIdx1: 0 }),
  ],
}

try {
  const [{ useAppStore }, { RemoveContourCommand }, holeErase] = await Promise.all([
    server.ssrLoadModule('/src/store/useAppStore.ts'),
    server.ssrLoadModule('/src/commands/SketchCommands.ts'),
    server.ssrLoadModule('/src/utils/eraserPolicy.ts'),
  ])
  const { resolveParametricEraseIntent, slotBoundaryDistance } = holeErase

  assert.equal(resolveParametricEraseIntent(polygon, 0), 'whole-feature',
    'regular polygon holes must erase as one feature')
  assert.equal(resolveParametricEraseIntent({ ...polygon, type: 'outer' }, 0), 'whole-feature',
    'outer parametric polygons must erase as one feature')
  assert.equal(resolveParametricEraseIntent(slot, -1), 'whole-feature',
    'slots must erase as one feature')
  assert.equal(resolveParametricEraseIntent(circle, -1), 'whole-feature',
    'an unsplit circle must erase as one feature')
  assert.equal(resolveParametricEraseIntent(circle, 0), 'circle-segment',
    'a circle segment selected between intersections must retain arc-trim semantics')
  assert.equal(resolveParametricEraseIntent(custom, 0), 'edge',
    'custom closed contours must retain edge-trim semantics')
  assert.equal(slotBoundaryDistance(slot, { x: 40, y: 85 }), 0,
    'visible slot side must be directly hittable')
  assert.equal(slotBoundaryDistance(slot, { x: 15, y: 80 }), 0,
    'visible slot end cap must be directly hittable')
  assert.equal(slotBoundaryDistance(custom, { x: 80, y: 20 }), null)

  const state = useAppStore.getState()
  useAppStore.setState({
    project: {
      metadata: {
        name: 'inner hole erase regression', author: '', version: '0.1.0',
        createdAt: '2026-08-31T00:00:00.000Z',
      },
      config: { pixelToMM: 1, material: 'PETG' },
      parts: [{
        id: 'part-test', name: 'test', material: { name: 'PETG', thickness: 5 },
        features: [{
          id: 'sketch-test', name: 'test sketch', type: 'sketch', plane: 'xy',
          contours: [outer, polygon, custom, slot, circle].map(item => structuredClone(item)),
        }],
      }],
    },
    ui: { ...state.ui, activeSketchId: 'sketch-test' },
    splitResult: null,
    splitJob: null,
    undoStack: [],
    redoStack: [],
  })

  const contours = () => useAppStore.getState().project.parts[0].features[0].contours
  const currentOuter = () => contours().find(item => item.id === 'outer')
  const initialIds = contours().map(item => item.id)
  const initialOuterConstraints = structuredClone(currentOuter().constraints)
  const initialPolygon = structuredClone(polygon)

  const removeHole = new RemoveContourCommand('hex-hole')
  // This command-only regression does not need solver/split side effects; keeping them disabled
  // also makes the test independent of the browser-only Planegcs WASM URL loader.
  removeHole.affectsSketch = false
  useAppStore.getState().execute(removeHole)
  assert.equal(useAppStore.getState().undoStack.length, 1, 'whole-hole erase must be one undoable operation')
  assert.equal(contours().some(item => item.id === 'hex-hole'), false)
  assert.deepEqual(currentOuter().constraints.map(item => item.id), ['outer-width', 'custom-to-left'],
    'only dimensions referencing the deleted hole must be removed')

  useAppStore.getState().undo()
  assert.deepEqual(contours().map(item => item.id), initialIds,
    'undo must restore the hole at its exact original contour position')
  assert.deepEqual(
    JSON.parse(JSON.stringify(contours().find(item => item.id === 'hex-hole'))),
    JSON.parse(JSON.stringify(initialPolygon)),
    'undo must restore all parameter metadata and the hole own dimensions')
  assert.deepEqual(currentOuter().constraints, initialOuterConstraints,
    'the same undo must restore cross-contour dimensions at their original positions')

  useAppStore.getState().redo()
  assert.equal(contours().some(item => item.id === 'hex-hole'), false)
  assert.deepEqual(currentOuter().constraints.map(item => item.id), ['outer-width', 'custom-to-left'])
  assert.equal(useAppStore.getState().undoStack.length, 1)

  console.log('eraser policy regression: polygon/slot whole erase, circle segment trim, slot boundary hit and atomic undo passed')
} finally {
  await server.close()
}
