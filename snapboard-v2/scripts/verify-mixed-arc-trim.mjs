import assert from 'node:assert/strict'
import {checkModule} from './check-module.mjs'
const {planClosedMixedArcTrim}=await checkModule('src/utils/mixedArcTrim.ts')

const EPS = 1e-6
const pointClose = (actual, expected, message) => {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) <= EPS,
    `${message}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`)
}

// 直线链为 arcEnd -> corner -> arcStart，闭合边由四分之一圆弧 arcStart -> arcEnd 补齐。
const targetArc = {
  id: 'closing-arc', p1: 2, p2: 0,
  center: { x: 40, y: 40 }, radius: 40, sweep: 'ccw',
}
const contour = {
  id: 'mixed', type: 'outer', name: 'mixed border', closed: true,
  points: [{ x: 40, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 40 }],
  arcs: [targetArc],
  constraints: [{
    id: 'radius', type: 'radius', edgeIndex: 2, value: 20,
    labelPos: { x: 10, y: 10 }, driving: true, label: 'R20',
  }],
}

// 1) 删除整条弧：只留下真实直线链，轮廓打开，最后点到第一点绝不能成为闭合弦。
const full = planClosedMixedArcTrim(contour, targetArc.id, { t1: 0, t2: 1 })
assert.ok(full, 'full mixed-arc deletion must produce a topology plan')
assert.equal(full.components.length, 1)
assert.equal(full.components[0].closed, false, 'deleting a closing arc must open the contour')
assert.deepEqual(full.components[0].points, contour.points, 'remaining backbone must preserve its vertex order')
assert.deepEqual(full.components[0].arcs, [], 'the deleted arc must not survive as an ArcEntity')
assert.notDeepEqual(
  full.components[0].points.at(-1),
  full.components[0].points[0],
  'the open component must expose two distinct cut endpoints',
)

// 2) 删除弧中段：一个开放组件包含首尾两条真实余弧，不存在 cutBefore -> cutAfter 直弦。
const partial = planClosedMixedArcTrim(contour, targetArc.id, { t1: 0.25, t2: 0.75 })
assert.ok(partial, 'partial mixed-arc deletion must produce a topology plan')
const component = partial.components[0]
assert.equal(component.closed, false)
assert.equal(component.points.length, 5, 'two cut points must be added around the preserved backbone')
pointClose(component.points[1], contour.points[0], 'tail residual must attach to original arc end')
pointClose(component.points[2], contour.points[1], 'backbone corner must remain')
pointClose(component.points[3], contour.points[2], 'head residual must attach to original arc start')
assert.equal(component.arcs.length, 2, 'both residual arc intervals must remain explicit arcs')
const leadingArc = component.arcs.find(arc => arc.p1 === 0 && arc.p2 === 1)
const trailingArc = component.arcs.find(arc => arc.p1 === 3 && arc.p2 === 4)
assert.ok(leadingArc, 'tail residual must be the first edge of the open component')
assert.ok(trailingArc, 'head residual must be the last edge of the open component')
assert.equal(trailingArc.id, targetArc.id, 'one residual keeps the source arc identity')
assert.notEqual(leadingArc.id, targetArc.id, 'the second residual receives a collision-free derived id')
assert.equal(
  component.arcs.some(arc => arc.p1 === component.points.length - 1 && arc.p2 === 0),
  false,
  'no residual arc or implicit topology may bridge the two cut endpoints',
)

// 单侧部分删除只保留一条余弧，并沿用源 id。
const headOnly = planClosedMixedArcTrim(contour, targetArc.id, { t1: 0.5, t2: 1 })
assert.ok(headOnly)
assert.equal(headOnly.components[0].arcs.length, 1)
assert.equal(headOnly.components[0].arcs[0].id, targetArc.id)
assert.equal(headOnly.components[0].closed, false)

// 3) 目标弧位于内部边时旋转点序；其它 ArcEntity 仍正确重映射到开放链相邻边。
const internal = {
  id: 'internal', type: 'outer', name: 'internal target', closed: true,
  points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
  arcs: [
    { id: 'target', p1: 1, p2: 2, center: { x: 20, y: 20 }, radius: 28.284271, sweep: 'ccw' },
    { id: 'other', p1: 3, p2: 0, center: { x: 0, y: 20 }, radius: 20, sweep: 'ccw' },
  ],
  constraints: [],
  originAnchorIdx: 0,
}
const internalPlan = planClosedMixedArcTrim(internal, 'target')
assert.ok(internalPlan)
assert.deepEqual(internalPlan.components[0].points, [
  internal.points[2], internal.points[3], internal.points[0], internal.points[1],
])
assert.deepEqual(
  internalPlan.components[0].arcs.map(arc => [arc.id, arc.p1, arc.p2]),
  [['other', 1, 2]],
  'non-target arcs must survive with remapped adjacent indices',
)
assert.equal(internalPlan.components[0].originAnchorIdx, 2)

// 4) before/removedArc 必须为深拷贝，命令层可据此可靠撤销。
assert.notEqual(partial.before, contour)
assert.notEqual(partial.before.arcs[0], contour.arcs[0])
assert.notEqual(partial.before.arcs[0].center, contour.arcs[0].center)
assert.notEqual(partial.removedArc, contour.arcs[0])
const originalSnapshotX = partial.before.arcs[0].center.x
component.arcs[0].center.x = 999
contour.arcs[0].center.x = 777
assert.equal(partial.before.arcs[0].center.x, originalSnapshotX, 'undo snapshot must not alias result or source arcs')
assert.equal(partial.removedArc.center.x, 40, 'removed arc snapshot must stay immutable from source mutation')

assert.equal(planClosedMixedArcTrim({ ...contour, closed: false }, targetArc.id), null)
assert.equal(planClosedMixedArcTrim(contour, 'missing'), null)
assert.equal(planClosedMixedArcTrim(contour, targetArc.id, { t1: 0.5, t2: 0.5 }), null)

console.log('mixed arc trim regression: full deletion, partial residuals, remap and undo snapshot passed')
