import assert from 'node:assert/strict'
import {checkModule} from './check-module.mjs'
const {extractPlanarFaces}=await checkModule('src/utils/planarFaces.ts')

const line = (id, a, b) => ({
  id, type: 'outer', name: id, closed: false, points: [a, b], constraints: [],
})

// 一条开放折线用重复首点表达闭环时，也应识别为一个简单环。
const simpleRing = extractPlanarFaces([{
  id: 'simple-ring', type: 'outer', name: 'simple ring', closed: false,
  points: [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 },
    { x: 0, y: 30 }, { x: 0, y: 0 },
  ],
  constraints: [],
}])
assert.equal(simpleRing.length, 1)
assert.equal(simpleRing[0].contour.points.length, 4)
assert.equal(simpleRing[0].area, 1200)

// 四条独立直线形成矩形；端点允许小于容差的落点误差。
const rectangle = extractPlanarFaces([
  line('top', { x: 0, y: 0 }, { x: 100, y: 0 }),
  line('right', { x: 100.4, y: 0.2 }, { x: 100, y: 60 }),
  line('bottom', { x: 100, y: 60 }, { x: 0, y: 60 }),
  line('left', { x: 0, y: 60 }, { x: 0.2, y: 0.3 }),
], { tolerance: 1 })
assert.equal(rectangle.length, 1, 'four independent segments must produce one rectangle face')
assert.equal(rectangle[0].contour.closed, true)
assert.equal(rectangle[0].contour.points.length, 4)
assert.ok(Math.abs(rectangle[0].area - 6000) < 50)
assert.deepEqual(new Set(rectangle[0].sourceIds), new Set(['top', 'right', 'bottom', 'left']))

// 默认 0.1px 只吸收数值噪声：0.12px 的端点缺口不能被静默焊接；调用方
// 明确传入更大吸附容差时才允许闭合。
const nearButUnsnapped = [
  line('gap-top', { x: 0.12, y: 0 }, { x: 50, y: 0 }),
  line('gap-right', { x: 50, y: 0 }, { x: 50, y: 50 }),
  line('gap-bottom', { x: 50, y: 50 }, { x: 0, y: 50 }),
  line('gap-left', { x: 0, y: 50 }, { x: 0, y: 0 }),
]
assert.equal(extractPlanarFaces(nearButUnsnapped).length, 0,
  'near endpoints outside the conservative default tolerance must remain open')
assert.equal(extractPlanarFaces(nearButUnsnapped, { tolerance: 0.2 }).length, 1,
  'a larger UI snap tolerance must be explicit')

// 单链接链式误焊保护：每个相邻点差 0.09px，但首尾差 0.18px 时不能全部
// 聚为同一节点，否则两个实际节点会因 A≈B≈C 被错误短接。
const chainedTolerance = extractPlanarFaces([
  line('chain-a', { x: 0, y: 0 }, { x: 20, y: 0 }),
  line('chain-b', { x: 20.09, y: 0 }, { x: 20, y: 20 }),
  line('chain-c', { x: 20.18, y: 0 }, { x: 0, y: 20 }),
  line('chain-d', { x: 0, y: 20 }, { x: 0, y: 0 }),
])
assert.equal(chainedTolerance.length, 0, 'transitive near-neighbour chains must not collapse into one node')

// 两条直线 + 四分之一圆弧形成一个扇形；输出必须保留并重建圆弧索引。
const arcContour = {
  id: 'quarter-arc', type: 'outer', name: 'quarter arc', closed: false,
  points: [{ x: 100, y: 0 }, { x: 0, y: 100 }], constraints: [],
  arcs: [{ id: 'quarter', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 100, sweep: 'ccw' }],
}
const sector = extractPlanarFaces([
  arcContour,
  line('radial-bottom', { x: 0, y: 100 }, { x: 0, y: 0 }),
  line('radial-top', { x: 0, y: 0 }, { x: 100, y: 0 }),
])
assert.equal(sector.length, 1, 'two lines and one arc must produce one bounded sector')
assert.equal(sector[0].contour.arcs?.length, 1)
const outputArc = sector[0].contour.arcs[0]
assert.equal(outputArc.p2, (outputArc.p1 + 1) % sector[0].contour.points.length)
assert.equal(outputArc.radius, 100)
assert.ok(Math.abs(sector[0].area - Math.PI * 100 * 100 / 4) < 1e-6)

// 两个相邻矩形共享一条真实拓扑边，应提取两个面而不是外包矩形或重复面。
const adjacent = extractPlanarFaces([
  line('top-left', { x: 0, y: 0 }, { x: 100, y: 0 }),
  line('top-right', { x: 100, y: 0 }, { x: 200, y: 0 }),
  line('far-right', { x: 200, y: 0 }, { x: 200, y: 80 }),
  line('bottom-right', { x: 200, y: 80 }, { x: 100, y: 80 }),
  line('bottom-left', { x: 100, y: 80 }, { x: 0, y: 80 }),
  line('far-left', { x: 0, y: 80 }, { x: 0, y: 0 }),
  line('shared', { x: 100, y: 0 }, { x: 100, y: 80 }),
])
assert.equal(adjacent.length, 2, 'one shared edge must split the graph into two adjacent faces')
assert.deepEqual(adjacent.map(face => Math.round(face.area)), [8000, 8000])
assert.ok(adjacent.every(face => face.sourceIds.includes('shared')), 'both faces must retain the shared edge source')

// 完全相同（方向可反转）的重复边只能成为一条拓扑边，不得生成零宽面或重复面。
const duplicatedEdge = extractPlanarFaces([
  line('dup-top-a', { x: 0, y: 0 }, { x: 60, y: 0 }),
  line('dup-top-b', { x: 60, y: 0 }, { x: 0, y: 0 }),
  line('dup-right', { x: 60, y: 0 }, { x: 60, y: 40 }),
  line('dup-bottom', { x: 60, y: 40 }, { x: 0, y: 40 }),
  line('dup-left', { x: 0, y: 40 }, { x: 0, y: 0 }),
])
assert.equal(duplicatedEdge.length, 1)
assert.ok(duplicatedEdge[0].sourceIds.includes('dup-top-a'))
assert.ok(duplicatedEdge[0].sourceIds.includes('dup-top-b'))

// 三条共线边构成的拓扑环面积为零，必须过滤。
const zeroArea = extractPlanarFaces([
  line('zero-a', { x: 0, y: 0 }, { x: 50, y: 0 }),
  line('zero-b', { x: 50, y: 0 }, { x: 100, y: 0 }),
  line('zero-c', { x: 100, y: 0 }, { x: 0, y: 0 }),
])
assert.equal(zeroArea.length, 0)

// 顶点不重复但边发生交叉的蝴蝶环不是简单面，即使其有向面积不为零也拒绝。
const selfCrossing = extractPlanarFaces([{
  id: 'self-crossing', type: 'outer', name: 'self crossing', closed: false,
  points: [
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    { x: 80, y: 0 }, { x: 0, y: 0 },
  ], constraints: [],
}])
assert.equal(selfCrossing.length, 0, 'self-intersecting walks must not be emitted as simple faces')

// 树状开放图和分叉不能凭空生成面。
const openBranch = extractPlanarFaces([
  line('stem', { x: 0, y: 0 }, { x: 0, y: 50 }),
  line('branch-left', { x: 0, y: 50 }, { x: -40, y: 100 }),
  line('branch-right', { x: 0, y: 50 }, { x: 40, y: 100 }),
  line('loose', { x: 200, y: 0 }, { x: 250, y: 0 }),
])
assert.equal(openBranch.length, 0, 'open and branching paths must not be misclassified as faces')

// 闭环外接一条尾巴时，叶边应被剔除，已有闭合面仍然有效。
const loopWithTail = extractPlanarFaces([
  line('a', { x: 0, y: 0 }, { x: 50, y: 0 }),
  line('b', { x: 50, y: 0 }, { x: 50, y: 50 }),
  line('c', { x: 50, y: 50 }, { x: 0, y: 50 }),
  line('d', { x: 0, y: 50 }, { x: 0, y: 0 }),
  line('tail', { x: 50, y: 50 }, { x: 90, y: 90 }),
])
assert.equal(loopWithTail.length, 1)
assert.equal(loopWithTail[0].sourceIds.includes('tail'), false)

// T 结点附着在已分段顶点上时只剔除尾枝，不破坏原面。
const tJunction = extractPlanarFaces([
  line('t-top', { x: 0, y: 0 }, { x: 50, y: 0 }),
  line('t-right', { x: 50, y: 0 }, { x: 50, y: 50 }),
  line('t-bottom', { x: 50, y: 50 }, { x: 0, y: 50 }),
  line('t-left', { x: 0, y: 50 }, { x: 0, y: 0 }),
  line('t-stem', { x: 50, y: 0 }, { x: 80, y: -30 }),
])
assert.equal(tJunction.length, 1)
assert.equal(tJunction[0].sourceIds.includes('t-stem'), false)

// 四叉中心与边界都已真实分段时，应稳定提取四个相邻面。
const fourWay = extractPlanarFaces([
  line('fw-t1', { x: 0, y: 0 }, { x: 50, y: 0 }),
  line('fw-t2', { x: 50, y: 0 }, { x: 100, y: 0 }),
  line('fw-r1', { x: 100, y: 0 }, { x: 100, y: 50 }),
  line('fw-r2', { x: 100, y: 50 }, { x: 100, y: 100 }),
  line('fw-b1', { x: 100, y: 100 }, { x: 50, y: 100 }),
  line('fw-b2', { x: 50, y: 100 }, { x: 0, y: 100 }),
  line('fw-l1', { x: 0, y: 100 }, { x: 0, y: 50 }),
  line('fw-l2', { x: 0, y: 50 }, { x: 0, y: 0 }),
  line('fw-up', { x: 50, y: 50 }, { x: 50, y: 0 }),
  line('fw-right', { x: 50, y: 50 }, { x: 100, y: 50 }),
  line('fw-down', { x: 50, y: 50 }, { x: 50, y: 100 }),
  line('fw-left', { x: 50, y: 50 }, { x: 0, y: 50 }),
])
assert.equal(fourWay.length, 4, 'an explicitly split four-way vertex must create four bounded faces')
assert.deepEqual(fourWay.map(face => Math.round(face.area)), [2500, 2500, 2500, 2500])

console.log('planar faces regression: simple/curved/adjacent faces, degeneracy, junctions and tolerance passed')
