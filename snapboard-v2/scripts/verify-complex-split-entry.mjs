import assert from 'node:assert/strict'
import { createServer } from 'vite'

const arcContour = (id, start, end, center, radius, sweep) => ({
  id,
  type: 'outer',
  name: id,
  closed: false,
  points: [start, end],
  arcs: [{ id: `${id}-arc`, p1: 0, p2: 1, center, radius, sweep }],
  constraints: [],
})

const openLine = (id, points) => ({
  id,
  type: 'outer',
  name: id,
  closed: false,
  points,
  constraints: [],
})

const regularPolygon = (id, type, center, radius, sides) => ({
  id,
  type,
  name: id,
  closed: true,
  shape: 'polygon',
  center,
  radius,
  points: Array.from({ length: sides }, (_, index) => {
    const angle = Math.PI * 2 * index / sides
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    }
  }),
  constraints: [],
})

const translateContour = (contour, dx, dy) => ({
  ...contour,
  points: contour.points.map(point => ({ x: point.x + dx, y: point.y + dy })),
  ...(contour.center ? { center: { x: contour.center.x + dx, y: contour.center.y + dy } } : {}),
  ...(contour.arcs ? {
    arcs: contour.arcs.map(arc => ({
      ...arc,
      center: { x: arc.center.x + dx, y: arc.center.y + dy },
    })),
  } : {}),
})

const segmentCrossings = (points) => {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const on = (p, a, b) => Math.abs(cross(a, b, p)) < 1e-7
    && p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7
    && p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7
  const intersects = (a, b, c, d) => {
    const abC = cross(a, b, c), abD = cross(a, b, d)
    const cdA = cross(c, d, a), cdB = cross(c, d, b)
    if (((abC > 1e-7 && abD < -1e-7) || (abC < -1e-7 && abD > 1e-7))
      && ((cdA > 1e-7 && cdB < -1e-7) || (cdA < -1e-7 && cdB > 1e-7))) return true
    return on(c, a, b) || on(d, a, b) || on(a, c, d) || on(b, c, d)
  }
  const result = []
  for (let left = 0; left < points.length; left++) {
    const leftNext = (left + 1) % points.length
    for (let right = left + 1; right < points.length; right++) {
      const rightNext = (right + 1) % points.length
      if (left === right || leftNext === right || rightNext === left) continue
      if (intersects(points[left], points[leftNext], points[right], points[rightNext])) result.push([left, right])
    }
  }
  return result
}

// 与用户截图同构：一条 270° 大弧、一条 90° 小弧和三段开放直线在视觉上
// 首尾相接；它们都保持 closed=false，验证分割入口不能依赖预先擦除/合并。
const complexContours = [
  arcContour(
    'large-arc',
    { x: 200, y: 400 },
    { x: 400, y: 200 },
    { x: 200, y: 200 },
    200,
    'ccw',
  ),
  openLine('top-link', [{ x: 400, y: 200 }, { x: 440, y: 200 }]),
  arcContour(
    'small-arc',
    { x: 440, y: 200 },
    { x: 540, y: 300 },
    { x: 540, y: 200 },
    100,
    'cw',
  ),
  openLine('return-chain', [
    { x: 540, y: 300 },
    { x: 540, y: 400 },
    { x: 200, y: 400 },
  ]),
].map(contour => translateContour(contour, 0.031, 0.057))
const innerHexagon = translateContour(
  regularPolygon('inner-hexagon', 'inner', { x: 200, y: 230 }, 42, 6),
  0.031,
  0.057,
)

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const { prepareSplitGeometry, useAppStore } = await vite.ssrLoadModule('/src/store/useAppStore.ts')
  const { extractPlanarFaces } = await vite.ssrLoadModule('/src/utils/planarFaces.ts')

  const prepared = prepareSplitGeometry(
    [...complexContours, innerHexagon],
    0.4,
    { idPrefix: 'regression' },
  )
  assert.equal(prepared.targets.length, 1, 'open large/small arcs and lines must yield one bounded outer face')
  assert.deepEqual(
    new Set(prepared.targets[0].sourceIds),
    new Set(['large-arc', 'top-link', 'small-arc', 'return-chain']),
    'the derived split face must retain every real source contour id',
  )
  assert.ok(
    prepared.targets[0].points.length > 40,
    'both arcs must be adaptively tessellated instead of becoming endpoint chords',
  )
  const targetBounds = prepared.targets[0].points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x), minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x), maxY: Math.max(bounds.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  assert.ok(
    Math.abs(targetBounds.minX - Math.round(targetBounds.minX)) > 1e-4
      && Math.abs(targetBounds.minY - Math.round(targetBounds.minY)) > 1e-4,
    'the regression must retain fractional region origins on both axes',
  )
  assert.deepEqual(segmentCrossings(prepared.targets[0].points), [], 'the derived polygon must stay simple')
  const extracted = extractPlanarFaces(complexContours, { tolerance: 0.1, minimumArea: 1 })
  assert.equal(extracted.length, 1)
  const targetArea = Math.abs(prepared.targets[0].points.reduce((sum, point, index, points) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x * next.y - point.y * next.x
  }, 0) / 2)
  assert.ok(
    Math.abs(targetArea - extracted[0].area * 0.4 ** 2) < 20,
    'tessellated split polygon area must agree with the analytic planar face area',
  )
  assert.equal(prepared.holes.length, 1, 'the closed inner hexagon must be forwarded as one cutout')
  assert.equal(prepared.holes[0].length, 6)

  const selectedArc = prepareSplitGeometry(
    [...complexContours, innerHexagon],
    0.4,
    { selectedContourId: 'large-arc', idPrefix: 'selected' },
  )
  assert.equal(selectedArc.targets.length, 1, 'selecting one open arc must select its complete face')
  assert.ok(selectedArc.targets[0].sourceIds.includes('small-arc'))

  const secondFace = [
    openLine('rect-top', [{ x: 700, y: 100 }, { x: 820, y: 100 }]),
    openLine('rect-right', [{ x: 820, y: 100 }, { x: 820, y: 180 }]),
    openLine('rect-bottom', [{ x: 820, y: 180 }, { x: 700, y: 180 }]),
    openLine('rect-left', [{ x: 700, y: 180 }, { x: 700, y: 100 }]),
  ]
  const multiple = prepareSplitGeometry(
    [...complexContours, ...secondFace, innerHexagon],
    0.4,
    { idPrefix: 'multiple' },
  )
  assert.equal(multiple.targets.length, 2, 'two disconnected open graphs must produce two split sources')
  assert.ok(multiple.targets.some(target => target.sourceIds.length === 4 && target.sourceIds.includes('rect-top')))

  // 通过真实 Zustand action 验证 runAutoSplit，而不只验证几何助手。Node 环境没有
  // Web Worker，store 会走与浏览器协议一致的同步降级分割器。
  const initial = useAppStore.getState()
  const sketch = {
    id: 'complex-split-sketch',
    name: '复杂圆弧分割回归',
    type: 'sketch',
    plane: 'xy',
    contours: [...complexContours, innerHexagon],
  }
  useAppStore.setState({
    project: {
      ...initial.project,
      config: { ...initial.project.config, pixelToMM: 0.4 },
      parts: [{ ...initial.project.parts[0], features: [sketch] }],
    },
    ui: {
      ...initial.ui,
      activeSketchId: sketch.id,
      selectedContourId: null,
      selectedConstraintId: null,
    },
    // An empty result must regenerate on the first click, not toggle off.
    splitResult: {sources: [], panels: [], config: initial.splitConfig, ts: 0},
    splitJob: null,
  })
  await useAppStore.getState().runAutoSplit()
  let result = useAppStore.getState().splitResult
  assert.ok(result, 'runAutoSplit must commit a result for the visual closed graph')
  assert.equal(result.sources.length, 1)
  assert.ok(result.panels.length > 0, 'the derived face must reach the actual partition engine')
  assert.ok(result.sources[0].coverageRatio > 0.99)
  assert.deepEqual(
    new Set(result.sources[0].sourceIds),
    new Set(['large-arc', 'top-link', 'small-arc', 'return-chain']),
  )
  assert.ok(
    result.panels.some(panel => (panel.cutouts?.length ?? 0) > 0),
    'the inner hexagon must survive through panel boolean subtraction',
  )

  await useAppStore.getState().runAutoSplit({ regenerate: true })
  const regenerated = useAppStore.getState().splitResult
  assert.ok(regenerated?.panels.length, 'regenerate must replace, not clear, an existing result')
  assert.notEqual(regenerated, result)
  result = regenerated

  // 已有预览时修改开放源链，syncSplitToSketch 必须用相同的面提取路径重算，
  // 不能退回旧正交链合并器并让曲线板突然消失。
  const returnChain = sketch.contours.find(contour => contour.id === 'return-chain')
  assert.ok(returnChain)
  const originalMiddle = { ...returnChain.points[1] }
  const movedMiddle = { x: originalMiddle.x - 18, y: originalMiddle.y - 12 }
  const applyMiddle = (point) => { returnChain.points[1] = { ...point } }
  useAppStore.getState().execute({
    label: '复杂圆弧同步回归',
    execute: () => applyMiddle(movedMiddle),
    undo: () => applyMiddle(originalMiddle),
    redo: () => applyMiddle(movedMiddle),
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = useAppStore.getState()
    if (state.splitResult && state.splitResult !== result && !state.splitJob) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const synced = useAppStore.getState().splitResult
  assert.ok(synced && synced !== result, 'sketch edits must refresh an existing complex split preview')
  assert.ok(synced.sources[0].coverageRatio > 0.99)
  assert.ok(synced.panels.some(panel => (panel.cutouts?.length ?? 0) > 0))
  assert.deepEqual(
    new Set(synced.sources[0].sourceIds),
    new Set(['large-arc', 'top-link', 'small-arc', 'return-chain']),
  )

  const cutoutCount = synced.panels.reduce((sum, panel) => sum + (panel.cutouts?.length ?? 0), 0)
  await useAppStore.getState().runAutoSplit()
  assert.equal(useAppStore.getState().splitResult, null, 'default action still clears an existing preview')
  console.log(
    `complex split entry regression passed: coverage=${synced.sources[0].coverageRatio.toFixed(6)}, `
      + `panels=${synced.panels.length}, cutouts=${cutoutCount}`,
  )
} finally {
  await vite.close()
}
