import assert from 'node:assert/strict'
import { checkModule } from './check-module.mjs'
const [chainModule,mergeModule] = await Promise.all(["src/utils/collinearChain.ts","src/utils/contourMerge.ts"].map(checkModule))
const {
  collinearChainContainingVertices,
  resolveCollinearEdgeChain,
  sameCollinearEdgeChain,
} = chainModule
const { mergeOpenContourGeometries } = mergeModule

// D 形：右边由两条共线短边组成，左边是一个半圆弧。
const dContour = {
  id: 'd-shape',
  type: 'outer',
  name: 'D shape',
  closed: true,
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ],
  arcs: [{ p1: 4, p2: 0, center: { x: 0, y: 50 }, radius: 50, sweep: 'cw' }],
  constraints: [],
}

const upperRight = resolveCollinearEdgeChain(dContour, 1)
assert.ok(upperRight)
assert.deepEqual(upperRight.edgeIndices, [1, 2], '两条短边必须成为一条逻辑直线')
assert.deepEqual(upperRight.vertexIndices, [1, 2, 3])
assert.equal(upperRight.startVertex, 1)
assert.equal(upperRight.endVertex, 3)
assert.equal(upperRight.totalLength, 100)
assert.deepEqual(sameCollinearEdgeChain(dContour, 1, 2)?.edgeIndices, [1, 2])
assert.deepEqual(collinearChainContainingVertices(dContour, 1, 3)?.edgeIndices, [1, 2], '点长边两端也应选中整条链')
assert.equal(resolveCollinearEdgeChain(dContour, 4), null, '圆弧不能误判为直线链')

// 擦掉右边的两条短边后，混合弧线开放轮廓与新画直线必须合并成同一闭合拓扑。
const openMixed = {
  points: [
    { x: 100, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ],
  arcs: [{ p1: 1, p2: 2, center: { x: 0, y: 50 }, radius: 50, sweep: 'cw' }],
}
const replacement = { points: [{ x: 100, y: 100 }, { x: 100, y: 0 }], arcs: [] }
const repaired = mergeOpenContourGeometries(openMixed, replacement)
assert.ok(repaired)
assert.equal(repaired.closed, true)
assert.equal(repaired.points.length, 4, '闭合点不能重复存储')
assert.equal(repaired.arcs.length, 1)
assert.equal(repaired.arcs[0].p1, 1)
assert.equal(repaired.arcs[0].p2, 2)

const repairedReverse = mergeOpenContourGeometries(openMixed, {
  points: [...replacement.points].reverse(),
  arcs: [],
})
assert.ok(repairedReverse, '补线的绘制方向不应影响自动闭合')
assert.equal(repairedReverse.points.length, 4)

console.log('collinear dimension + mixed contour repair regression: passed')
