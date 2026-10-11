import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const closePoint = (actual, expected, message, tolerance = 0.15) => {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) <= tolerance,
    `${message}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const wasmPath = fileURLToPath(import.meta.resolve('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'))
const wasmVirtualId = '\0complex-curve-planegcs-wasm'
const vite = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  plugins: [{
    name: 'complex-curve-node-wasm-path',
    enforce: 'pre',
    resolveId(source) {
      return source.includes('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url')
        ? wasmVirtualId
        : null
    },
    load(id) {
      return id === wasmVirtualId ? `export default ${JSON.stringify(wasmPath)}` : null
    },
  }],
})

try {
  const solver = await vite.ssrLoadModule('/src/engine/solver.ts')
  const state = await vite.ssrLoadModule('/src/engine/solveState.ts')

  // 测试应用层包装器，避免只测GCS整数输入而漏掉输出取整及事后吸附。
  const preciseCenter = { x: 20.0137, y: -9.0273 }
  for (const radius of [0.375, 12.34567, 100.01234]) {
    const seed = [0, 1, 2, 3].map(i => ({
      x: preciseCenter.x + 10 * Math.cos(i * Math.PI / 2),
      y: preciseCenter.y + 10 * Math.sin(i * Math.PI / 2),
    }))
    const exact = await solver.solveSketch(seed, [solver.circleRadius(radius)], {
      circle: { center: preciseCenter, radius: 10 }, fixedIndices: [], closed: true,
    })
    assert.ok(exact.success, exact.message)
    closePoint(exact.circle.center, preciseCenter, '小数圆心不能量化到0.1绘图单位', 1e-7)
    assert.ok(Math.abs(exact.circle.radius - radius) < 1e-7, '小数半径必须满足输入尺寸')
  }
  const sloped = [{ x: 0.013, y: 0.027 }, { x: 100.013, y: 5.027 }]
  const unchanged = await solver.solveSketch(sloped, [], { fixedIndices: [0, 1], closed: false })
  assert.ok(unchanged.success, unchanged.message)
  unchanged.points.forEach((point, i) => closePoint(point, sloped[i], '固定斜线不能被自动拉平', 1e-7))

  for (const sweep of ['ccw', 'cw']) {
    const radius = 12.34567
    const center = { x: 1.01234, y: 2.04321 }
    const direction = sweep === 'ccw' ? 1 : -1
    const pts = [{ x: center.x + radius, y: center.y }, { x: center.x, y: center.y - direction * radius }]
    const arc = { id: 'precise', p1: 0, p2: 1, center, radius, sweep }
    const exactArc = await solver.solveSketch(pts, [solver.arcRadius(arc.id, radius)], {
      arcs: [arc], fixedIndices: [0], closed: false,
    })
    assert.ok(exactArc.success, exactArc.message)
    closePoint(exactArc.arcs.precise.center, center, '270度弧的小数圆心应保持', 1e-7)
    assert.ok(Math.abs(exactArc.arcs.precise.radius - radius) < 1e-7)
    exactArc.points.forEach(point => assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - radius) < 1e-6))
  }

  const { useAppStore } = await vite.ssrLoadModule('/src/store/useAppStore.ts')
  const { dimensionEditCommand, circleSizeSolveContour } = await vite.ssrLoadModule('/src/commands/DimensionEditCommand.ts')
  const circleContour = {
    id: 'edit-circle', type: 'outer', name: '三点圆', shape: 'circle', closed: true,
    center: preciseCenter, radius: 10,
    points: [0, 1, 2, 3].map(i => ({ x: preciseCenter.x + 10 * Math.cos(i * Math.PI / 2), y: preciseCenter.y + 10 * Math.sin(i * Math.PI / 2) })),
    constraints: [{ id: 'r', type: 'radius', driving: true, value: 10, label: 'R 10 mm', labelPos: { x: 25, y: -9 } }],
  }
  const originalProject = useAppStore.getState().project
  useAppStore.setState({ project: {
    ...originalProject, parts: [{ id: 'part', name: 'test', material: { name: 'PETG', thickness: 5 },
      features: [{ id: 'sketch', name: 'test', type: 'sketch', plane: 'xy', contours: [circleContour] }] }],
  }, splitResult: null, undoStack: [], redoStack: [] })
  const diameter = 31.23456
  const resized = await solver.solveSketch(circleContour.points, [
    ...state.existingConstraintsToSolver(circleSizeSolveContour(circleContour), 1), solver.circleDiameter(diameter),
  ], { circle: { center: preciseCenter, radius: 10 }, fixedIndices: [], closed: true })
  assert.ok(resized.success, resized.message)
  const command = dimensionEditCommand(circleContour, resized.points, resized.circle, {
    id: 'd', type: 'diameter', value: diameter, driving: true, label: `直径 ${diameter} mm`, labelPos: { x: 40, y: 0 },
  })
  const currentCircle = () => useAppStore.getState().project.parts[0].features[0].contours[0]
  command.execute()
  assert.ok(Math.abs(currentCircle().radius * 2 - diameter) < 1e-6)
  assert.equal(currentCircle().constraints.find(c => c.id === 'r').driving, false)
  assert.equal(currentCircle().constraints.find(c => c.id === 'r').value, diameter / 2)
  const editedCircle = structuredClone(currentCircle())
  command.undo()
  assert.deepEqual(currentCircle(), circleContour, '一次撤销必须完整恢复几何和尺寸')
  command.redo()
  assert.deepEqual(currentCircle(), editedCircle, '重做必须恢复一致的半径与直径')

  // 与用户截图同构：大弧 + 短水平线 + 小弧 + 竖线 + 底边，形成单一闭环。
  const points = [
    { x: 0, y: 200 },
    { x: 200, y: 0 },
    { x: 240, y: 0 },
    { x: 300, y: 60 },
    { x: 300, y: 200 },
  ]
  const arcs = [
    { id: 'large', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 200, sweep: 'ccw' },
    { id: 'small', p1: 2, p2: 3, center: { x: 300, y: 0 }, radius: 60, sweep: 'cw' },
  ]
  const contour = {
    id: 'complex-outer', type: 'outer', name: '大弧混合闭环', closed: true,
    points, arcs, constraints: [],
  }

  const baseline = await solver.solveSketch(points, [], {
    fixedIndices: [0], closed: true, arcs,
  })
  assert.equal(baseline.success, true, baseline.message)
  assert.ok((baseline.degreesOfFreedom ?? 0) > 0, 'unconstrained mixed contour must retain degrees of freedom')
  closePoint(baseline.arcs.large.center, arcs[0].center, 'large arc center must not drift')
  closePoint(baseline.arcs.small.center, arcs[1].center, 'small arc center must not drift')
  assert.equal(baseline.arcs.large.radius, 200, 'large radius must remain stable during unrelated solve')
  assert.equal(baseline.arcs.small.radius, 60, 'small radius must remain stable during unrelated solve')

  const conflicting = await solver.solveSketch(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [solver.p2pDistance(0, 1, 20)],
    { fixedIndices: [0, 1], closed: false },
  )
  assert.equal(conflicting.success, false, 'an unsatisfied fixed-endpoint dimension must fail instead of committing unchanged geometry')
  assert.equal(conflicting.conflict, true, 'fixed endpoints with a contradictory length must report conflict')
  assert.match(conflicting.message ?? '', /did not satisfy constraint/)

  // 多弧轮廓中缺少 edgeIndex 的旧/损坏半径尺寸是有歧义的，不能悄悄驱动第一条弧。
  const ambiguous = {
    id: 'ambiguous-radius', type: 'radius', value: 100,
    labelPos: { x: 0, y: 0 }, driving: true, label: 'R 100 mm',
  }
  assert.equal(state.geomToSolver(ambiguous, contour, 1), null)
  assert.equal(state.geomToSolver({ ...ambiguous, edgeIndex: 0 }, contour, 1).a_id, 'arc_large')

  // 参考尺寸和尚未接入的 arcAngle 不得靠“约束条数”把复杂轮廓误报为完全定义。
  const passiveConstraints = Array.from({ length: 10 }, (_, index) => ({
    id: `reference-${index}`, type: 'length', edgeIndex: 1,
    value: 40, labelPos: { x: 0, y: 0 }, driving: false, label: '参考',
  }))
  assert.equal(await state.computeContourState({ ...contour, constraints: passiveConstraints }, 1), 'under')
  assert.equal(await state.computeContourState({
    ...contour,
    constraints: [{
      id: 'unsupported-arc-angle', type: 'arcAngle', edgeIndex: 0,
      value: 270, labelPos: { x: 0, y: 0 }, driving: true, label: '270°',
    }],
  }, 1), 'under')

  // 一条非相邻底边穿过圆弧端点：视觉上可能像闭环，但拓扑上是自交，必须拒绝。
  const crossingPoints = [
    { x: 10, y: 0 },
    { x: 0, y: 10 },
    { x: -20, y: 0 },
    { x: 20, y: 0 },
  ]
  const crossing = await solver.solveSketch(crossingPoints, [], {
    fixedIndices: [0, 1, 2, 3],
    closed: true,
    arcs: [{ id: 'crossed', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 10, sweep: 'ccw' }],
  })
  assert.equal(crossing.success, false, 'non-adjacent line/arc intersection must be rejected')
  assert.match(crossing.message ?? '', /self-intersecting/)

  const crossedArcs = await solver.solveSketch([
    { x: -5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: -4 }, { x: -5, y: -4 },
  ], [], {
    fixedIndices: [0, 1, 2, 3],
    closed: true,
    arcs: [
      { id: 'upper', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 5, sweep: 'ccw' },
      { id: 'lower', p1: 2, p2: 3, center: { x: 0, y: -4 }, radius: 5, sweep: 'ccw' },
    ],
  })
  assert.equal(crossedArcs.success, false, 'non-adjacent arc/arc intersections must be rejected')
  assert.match(crossedArcs.message ?? '', /self-intersecting/)

  // 开放混合链上编辑远离圆弧的直线，圆弧参数必须保持不变。
  const openPoints = [
    { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 },
  ]
  const openArc = { id: 'head', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 10, sweep: 'cw' }
  const edited = await solver.solveSketch(
    openPoints,
    [solver.p2pDistance(2, 3, 20)],
    { fixedIndices: [0, 1, 2], closed: false, arcs: [openArc] },
  )
  assert.equal(edited.success, true, edited.message)
  assert.equal(edited.arcs.head.radius, 10)
  closePoint(edited.arcs.head.center, openArc.center, 'unrelated length edit keeps arc center')
  assert.ok(Math.abs(Math.hypot(
    edited.points[3].x - edited.points[2].x,
    edited.points[3].y - edited.points[2].y,
  ) - 20) <= 0.15, 'target line length must solve')

  // 反向保护：明确带 tangent_la 的圆角半径编辑仍必须解锁圆心，不能被默认固定策略破坏。
  const filletPoints = [
    { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 20, y: -10 },
  ]
  const filletArc = { id: 'fillet', p1: 1, p2: 2, center: { x: 10, y: 0 }, radius: 10, sweep: 'cw' }
  const fillet = await solver.solveSketch(filletPoints, [
    solver.horizontal(0, 1),
    solver.vertical(2, 3),
    solver.tangentLineArc(0, 1, filletArc.id),
    solver.tangentLineArc(2, 3, filletArc.id),
    solver.arcRadius(filletArc.id, 5),
  ], {
    fixedIndices: [0, 3], closed: false, arcs: [filletArc],
  })
  assert.equal(fillet.success, true, fillet.message)
  assert.equal(fillet.arcs.fillet.radius, 5)
  assert.ok(Math.hypot(
    fillet.arcs.fillet.center.x - filletArc.center.x,
    fillet.arcs.fillet.center.y - filletArc.center.y,
  ) > 1, 'tangent-driven fillet center must remain movable')

  const standaloneArc = { id: 'standalone', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 10, sweep: 'ccw' }
  const resizedStandalone = await solver.solveSketch(
    [{ x: 10, y: 0 }, { x: 0, y: 10 }],
    [
      solver.arcRadius(standaloneArc.id, 20),
      solver.arcLength(standaloneArc.id, 20 * Math.PI / 2),
    ],
    { fixedIndices: [], closed: false, arcs: [standaloneArc] },
  )
  assert.equal(resizedStandalone.success, true, resizedStandalone.message)
  assert.equal(resizedStandalone.arcs.standalone.radius, 20)
  assert.ok(Math.abs(
    (resizedStandalone.arcs.standalone.endAngle - resizedStandalone.arcs.standalone.startAngle)
      - Math.PI / 2,
  ) <= 1e-3, 'standalone radius edit must preserve the requested arc span')

  // 内六边形是独立内孔：它的约束映射不能引用外轮廓的弧 primitive。
  const hex = {
    id: 'hex-hole', type: 'inner', name: '六边形孔', closed: true,
    points: Array.from({ length: 6 }, (_, index) => ({
      x: 100 + 30 * Math.cos(index * Math.PI / 3),
      y: 100 + 30 * Math.sin(index * Math.PI / 3),
    })),
    constraints: [],
  }
  const hexLength = state.geomToSolver({
    id: 'hex-edge', type: 'length', edgeIndex: 0, value: 30,
    labelPos: { x: 0, y: 0 }, driving: true, label: '30 mm',
  }, hex, 1)
  assert.equal(hexLength.type, 'p2p_distance')
  assert.equal('a_id' in hexLength, false)

  console.log('complex curve constraints regression: mixed-loop stability, topology rejection, DOF state and inner-hole isolation passed')
} finally {
  await vite.close()
}
