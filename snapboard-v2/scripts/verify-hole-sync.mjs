import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: 'hole-sync-isolate-constraint-solver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '../engine/solveState' && importer?.endsWith('/src/store/useAppStore.ts')) {
        return '\0hole-sync-solve-state'
      }
    },
    load(id) {
      if (id === '\0hole-sync-solve-state') return 'export async function computeContourState() { return "under" }'
    },
  }],
})

try {
  const { useAppStore, prepareSplitGeometry } = await server.ssrLoadModule('/src/store/useAppStore.ts')
  const contour = {
    id: 'outer', name: 'test board', type: 'outer', closed: true, constraints: [],
    points: [{ x: 0, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 110 }, { x: 0, y: 110 }],
  }
  const prepared = prepareSplitGeometry([contour], 1)
  assert.deepEqual(prepared.targets[0].points.map(point => point.y), [-10, -10, -110, -110],
    '画布 Y 坐标进入分割器时必须取反')

  const initial = useAppStore.getState()
  useAppStore.setState({
    project: {
      metadata: { name: 'hole sync regression', author: '', version: '0.1.0', createdAt: '2026-09-27T00:00:00Z' },
      config: { pixelToMM: 1, material: 'PETG' },
      parts: [{ id: 'part', name: 'part', material: { name: 'PETG', thickness: 5 },
        features: [{ id: 'sketch', name: 'sketch', type: 'sketch', plane: 'xy', contours: [contour] }] }],
    },
    ui: { ...initial.ui, activeSketchId: 'sketch', selectedContourId: null },
    splitResult: null, splitJob: null, undoStack: [], redoStack: [],
  })
  await useAppStore.getState().runAutoSplit()
  const original = useAppStore.getState().splitResult
  assert.ok(original?.panels.length)
  assert.equal(Math.min(...original.panels.flatMap(panel => panel.contour.map(point => point.y))), -110)

  const metadataCommand = {
    label: 'add annotation',
    execute: () => { contour.constraints.push({ id: 'annotation', type: 'length', value: 200,
      labelPos: { x: 100, y: 0 }, driving: false, label: '200' }) },
    undo: () => { contour.constraints.pop() },
    redo() { this.execute() },
  }
  useAppStore.getState().execute(metadataCommand)
  assert.equal(useAppStore.getState().splitResult, original, '标注不应重算孔位/板件')
  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().splitResult, original, '撤销标注不应重算孔位/板件')
  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().splitResult, original, '重做标注不应重算孔位/板件')

  const pending = useAppStore.getState().runAutoSplit({ regenerate: true })
  useAppStore.getState().execute(metadataCommand)
  await pending
  const regenerated = useAppStore.getState().splitResult
  assert.ok(regenerated?.panels.length, '后台分割期间的标注修改不应取消结果')
  assert.deepEqual(regenerated.panels.map(panel => panel.contour), original.panels.map(panel => panel.contour))

  const manualPanel = regenerated.panels[0]
  const manualHole = manualPanel.edge_holes.find(hole => hole.x <= 20)
  assert.ok(manualHole, '测试板左侧应有可手动切换的安全候选孔')
  useAppStore.getState().toggleEdgeHole(manualPanel.id, manualPanel.x, manualPanel.y, manualHole.x, manualHole.y)
  const withManual = useAppStore.getState().splitResult
  const expectedManualState = !manualHole.knocked
  const assertManual = result => {
    const hole = result.panels.flatMap(panel => panel.edge_holes)
      .find(candidate => candidate.x === manualHole.x && candidate.y === manualHole.y)
    assert.ok(hole?.manual, '真实几何重算不能丢掉可保留的手动孔')
    assert.equal(!!hole.knocked, expectedManualState)
  }
  assertManual(withManual)

  const geometryCommand = {
    label: 'resize board',
    execute: () => { contour.points[1].x = contour.points[2].x = 220 },
    undo: () => { contour.points[1].x = contour.points[2].x = 200 },
    redo() { this.execute() },
  }
  const waitForSplit = async previous => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const current = useAppStore.getState()
      if (!current.splitJob && current.splitResult !== previous) return current.splitResult
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('几何变化后未完成重新分割')
  }
  useAppStore.getState().execute(geometryCommand)
  const changed = await waitForSplit(withManual)
  assert.ok(changed?.panels.length)
  assertManual(changed)
  assert.notDeepEqual(changed.panels.map(panel => panel.w), original.panels.map(panel => panel.w),
    '修改轮廓后应更新板件与孔位')
  useAppStore.getState().undo()
  const restored = await waitForSplit(changed)
  assertManual(restored)
  assert.deepEqual(restored.panels.map(panel => panel.contour), original.panels.map(panel => panel.contour),
    '撤销几何修改应恢复原板件坐标')

  console.log(JSON.stringify({ pass: true, canvasYToMmY: true, metadataKeepsSplitIdentity: true,
    metadataDoesNotCancelPendingSplit: true, geometryRefreshesSplit: true, undoRestoresGeometry: true,
    manualHoleSurvivesGeometryAndUndo: true }, null, 2))
} finally {
  await server.close()
}
