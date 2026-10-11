import assert from 'node:assert/strict'
import {checkModule} from './check-module.mjs'
const {normalizeMultiTrimRanges,planMultiTrim,restoreMultiTrimSource}=await checkModule('src/utils/multiTrim.ts')

const coords = pathResult => pathResult.points.map(point => [point.x, point.y])

// 闭合矩形同时删除上下对边：不能连续删边后误接对角线，也不能只剩第一段。
const rectangle = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
]
const oppositeEdges = planMultiTrim(rectangle, true, [
  { edgeIdx: 0, t1: 0, t2: 1 },
  { edgeIdx: 2, t1: 0, t2: 1 },
])
assert.equal(oppositeEdges.changed, true)
assert.equal(oppositeEdges.after.length, 2, 'removing opposite rectangle edges must retain two components')
assert.deepEqual(oppositeEdges.after.map(coords), [
  [[10, 0], [10, 6]],
  [[0, 6], [0, 0]],
])
assert.ok(oppositeEdges.after.every(component => !component.closed))
assert.deepEqual([...oppositeEdges.after[0].oldEdgeMap], [[1, 0]])
assert.deepEqual([...oppositeEdges.after[1].oldEdgeMap], [[3, 0]])

// 开放折线删除两个非相邻区间：保留左、中、右三个连通分量。
const openLine = [0, 10, 20, 30, 40].map(x => ({ x, y: 0 }))
const openResult = planMultiTrim(openLine, false, [
  { edgeIdx: 0, t1: 0.5, t2: 1 },
  { edgeIdx: 2, t1: 0.25, t2: 0.75 },
])
assert.equal(openResult.after.length, 3, 'all retained components of an open chain must be returned')
assert.deepEqual(openResult.after.map(coords), [
  [[0, 0], [5, 0]],
  [[10, 0], [20, 0], [22.5, 0]],
  [[27.5, 0], [30, 0], [40, 0]],
])
assert.deepEqual(openResult.after[1].fragments.map(fragment => [
  fragment.sourceEdgeIdx, fragment.sourceT1, fragment.sourceT2, fragment.newEdgeIdx,
]), [
  [1, 0, 1, 0],
  [2, 0, 0.25, 1],
], 'fragment provenance must survive partial-edge output for later constraint remapping')

// 同一旧边擦除两个区间：参数域先求并集，再保留全部三个片段。
const sameEdgeRanges = [
  { edgeIdx: 0, t1: 0.6, t2: 0.8 },
  { edgeIdx: 0, t1: 0.3, t2: 0.2 },
]
const sameEdge = planMultiTrim([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, sameEdgeRanges)
assert.equal(sameEdge.after.length, 3)
assert.deepEqual(sameEdge.after.map(coords), [
  [[0, 0], [2, 0]],
  [[3, 0], [6, 0]],
  [[8, 0], [10, 0]],
])
assert.deepEqual(sameEdge.removed, [
  { edgeIdx: 0, t1: 0.2, t2: 0.3 },
  { edgeIdx: 0, t1: 0.6, t2: 0.8 },
])

assert.deepEqual(normalizeMultiTrimRanges(2, [
  { edgeIdx: 0, t1: 0.2, t2: 0.4 },
  { edgeIdx: 0, t1: 0.35, t2: 0.6 },
  { edgeIdx: 0, t1: 0.9, t2: 0.8 },
  { edgeIdx: 9, t1: 0, t2: 1 },
  { edgeIdx: 1, t1: Number.NaN, t2: 1 },
]), [
  { edgeIdx: 0, t1: 0.2, t2: 0.6 },
  { edgeIdx: 0, t1: 0.8, t2: 0.9 },
], 'overlap, reversed parameters and invalid edge references must normalize deterministically')

// Undo 所需 before 与 after 必须互不别名；现场修改 after 或调用方原数组不能污染恢复快照。
rectangle[0].x = 999
oppositeEdges.after[0].points[0].x = 777
oppositeEdges.removed[0].t1 = 0.5
assert.deepEqual(restoreMultiTrimSource(oppositeEdges), {
  points: [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 },
  ],
  closed: true,
}, 'before snapshot must be sufficient to restore source geometry atomically')

const unchanged = planMultiTrim([{ x: 0, y: 0 }, { x: 4, y: 0 }], false, [])
assert.equal(unchanged.changed, false)
assert.equal(unchanged.after.length, 1)
assert.deepEqual(coords(unchanged.after[0]), [[0, 0], [4, 0]])

console.log('multi trim regression: opposite edges, multiple components, same-edge ranges and undo snapshot passed')
