/**
 * 异形板边缘优先布局建议器回归。
 *
 * 覆盖：
 *  - L / U 形真实 contour 的边缘距离；
 *  - 同一输入的确定性结果及同分 ID 排序；
 *  - 只推荐 splitPanelTargets 给出的合法孔位；
 *  - 尚未 knocked 的候选圆孔绝不进入结果；
 *  - 推荐前 N 的平均边缘距离不劣于全部候选与固定随机基线；
 *  - 默认平衡模式保护视觉核心区。
 */
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { checkModule } from './check-module.mjs'
const [advisor,snap,overlayModel] = await Promise.all(["src/utils/layoutAdvisor.ts","src/utils/assemblySnap.ts","src/utils/layoutSuggestionOverlay.ts"].map(checkModule))

const cfg = {
  thickness: 5,
  edgeMargin: 20,
}

const hole = (x, y) => ({ x, y })

// L 形：底部横臂 300×80，左侧竖臂 80×300。
const lPanel = {
  id: 'L-panel', x: 0, y: 0, w: 300, h: 300,
  contour: [
    { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 80 },
    { x: 80, y: 80 }, { x: 80, y: 300 }, { x: 0, y: 300 },
  ],
  slots: [
    hole(10, 20), hole(40, 40), hole(120, 20), hole(200, 40), hole(290, 20),
    hole(20, 120), hole(40, 180), hole(20, 220), hole(40, 260), hole(20, 290),
  ],
  round_holes: [hole(60, 20)],
  edge_holes: [
    { x: 100, y: 20, knocked: false },
    { x: 140, y: 20, knocked: true },
  ],
}

// U 形（开口朝上）：底边高 60、两侧臂宽 80。
const uPanel = {
  id: 'U-panel', x: 340, y: 0, w: 400, h: 300,
  contour: [
    { x: 340, y: 0 }, { x: 740, y: 0 }, { x: 740, y: 300 },
    { x: 660, y: 300 }, { x: 660, y: 60 }, { x: 420, y: 60 },
    { x: 420, y: 300 }, { x: 340, y: 300 },
  ],
  slots: [
    hole(350, 20), hole(390, 30), hole(470, 20), hole(540, 30), hole(610, 20), hole(730, 20),
    hole(360, 100), hole(400, 160), hole(360, 220), hole(400, 270),
    hole(680, 100), hole(720, 160), hole(680, 220), hole(720, 270),
  ],
  round_holes: [],
  edge_holes: [
    { x: 500, y: 20, knocked: false },
    { x: 580, y: 20, knocked: true },
  ],
}

const panels = [lPanel, uPanel]
const panelSnapshot = structuredClone(panels)
const rawTargets = snap.splitPanelTargets(panels, cfg, 'front')
const unopenedIds = new Set(rawTargets.filter(target => target.covered).map(target => target.id))
const occupiedId = rawTargets.find(target => target.panelId === 'L-panel' && target.kind === 'slot').id
const options = { occupiedTargetIds: [occupiedId], mode: 'balanced' }

const first = advisor.adviseLayoutTargets(panels, cfg, options)
const second = advisor.adviseLayoutTargets(panels, cfg, options)
assert.deepEqual(first, second, '相同输入必须得到完全一致的建议顺序与数值')
assert.deepEqual(panels, panelSnapshot, '建议器不得修改板件、孔位或 knocked 状态')
assert.ok(first.length > 12, '夹具应提供足够多的合法候选')
assert.equal(first.some(item => item.targetId === occupiedId), false, '已占用目标不能再次推荐')
assert.equal(first.some(item => unopenedIds.has(item.targetId)), false, '未开候选圆孔绝不能进入建议')
assert.ok(first.every(item => item.kind === 'slot' || item.kind === 'round'))
assert.ok(first.every(item => item.reason.includes('距所属板件真实轮廓')))
assert.ok(first.every(item => item.x === item.globalX - snap.splitAssemblyFrame(panels).centerX))
assert.ok(first.every(item => item.y === item.globalY - snap.splitAssemblyFrame(panels).minY))

const legalTargetIds = new Set(rawTargets
  .filter(target => !target.covered && target.id !== occupiedId)
  .map(target => target.id))
assert.ok(first.every(item => legalTargetIds.has(item.targetId)), '每条建议都必须来自正面合法装配目标')
assert.equal(first.length, legalTargetIds.size, '缺省 limit 应返回全部且仅返回合法未占用目标')

// concave contour 必须参与距离：L 形 (120,20) 到底边 20mm；如果错误使用
// 300×300 包围盒，这类点尚能碰巧通过，因此再检查 U 形内凹边附近 (680,100)，
// 它到内侧竖边 x=660 只有 20mm。
const uConcave = first.find(item => item.panelId === 'U-panel' && item.globalX === 680 && item.globalY === 100)
assert.ok(uConcave)
assert.equal(uConcave.edgeDistanceMm, 20, 'U 形凹边应作为真实 contour 边缘参与最短距离')
assert.equal(advisor.distanceToPanelContour(lPanel, 70, 140), 10, 'L 形内凹竖边距离应正确')

const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const topN = advisor.adviseLayoutTargets(panels, cfg, { ...options, limit: 8 })
const topAverage = average(topN.map(item => item.edgeDistanceMm))
const allAverage = average(first.map(item => item.edgeDistanceMm))
assert.ok(topAverage <= allAverage + 1e-9,
  `前 N 建议平均边缘距离 ${topAverage} 不应劣于全部候选 ${allAverage}`)

// 固定 LCG 随机基线，避免 Math.random 使回归漂移。
const shuffled = [...first]
let state = 0x5a17
for (let index = shuffled.length - 1; index > 0; index--) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  const other = state % (index + 1)
  ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
}
const randomAverage = average(shuffled.slice(0, topN.length).map(item => item.edgeDistanceMm))
assert.ok(topAverage <= randomAverage + 1e-9,
  `前 N 建议平均边缘距离 ${topAverage} 不应劣于固定随机基线 ${randomAverage}`)

// 默认即 balanced：只要非核心候选足够，前 N 不应侵入顶部 30% 视觉核心。
const implicitBalanced = advisor.adviseLayoutTargets(panels, cfg, { limit: 8 })
assert.ok(implicitBalanced.every(item => item.zoneId !== 'visual-core'), '默认平衡模式必须保护视觉核心')
const visualItems = first.filter(item => item.zoneId === 'visual-core')
assert.ok(visualItems.length > 0, '夹具必须包含视觉核心候选，才能验证保护逻辑')
assert.ok(visualItems.every(item => item.visualCorePenalty > 1))
assert.ok(visualItems.every(item => item.reason.includes('保护惩罚')))

// 同分时固定按 panelId / targetId，而不是依赖输入数组或引擎 sort 的偶然顺序。
const tieA = {
  id: 'A', x: 0, y: 0, w: 100, h: 100,
  slots: [hole(10, 50), hole(90, 50)], round_holes: [], edge_holes: [],
}
const tieB = {
  id: 'B', x: 120, y: 0, w: 100, h: 100,
  slots: [hole(130, 50)], round_holes: [], edge_holes: [],
}
const tied = advisor.adviseLayoutTargets([tieB, tieA], cfg)
assert.equal(tied.length, 3)
assert.ok(tied.every(item => item.score === tied[0].score))
assert.deepEqual(tied.map(item => item.panelId), ['A', 'A', 'B'], '同分必须先按 panelId 稳定排序')
assert.deepEqual(
  tied.slice(0, 2).map(item => item.targetId),
  [...tied.slice(0, 2).map(item => item.targetId)].sort(),
  '同一板件同分时必须继续按 targetId 稳定排序',
)

assert.deepEqual(advisor.adviseLayoutTargets([], cfg), [])
assert.deepEqual(advisor.adviseLayoutTargets(panels, cfg, { limit: -1 }), [])

// 3D 建议标记只消费装配局部坐标；关闭后必须完整移除并释放引用。
const markerOverlay = overlayModel.createLayoutSuggestionOverlay({ suggestions: topN, surfaceZ: 5 })
const markerParent = new THREE.Group()
markerParent.add(markerOverlay)
assert.equal(markerOverlay.name, 'layout-suggestion-overlay')
assert.equal(markerOverlay.children.length, 5, '默认应显示前 5 个推荐落点')
assert.equal(markerOverlay.children[0].name, 'layout-suggestion-marker-rank-1')
assert.equal(markerOverlay.userData.layoutSuggestionOverlay.coordinateSpace, 'viewport-assembly-local')
overlayModel.disposeLayoutSuggestionOverlay(markerOverlay)
assert.equal(markerParent.children.includes(markerOverlay), false, '关闭建议层后不得残留在场景')
assert.equal(markerOverlay.children.length, 0)
assert.deepEqual(markerOverlay.userData, {})
overlayModel.disposeLayoutSuggestionOverlay(markerOverlay)

console.log('verify-layout: OK')
console.log(`  合法候选: ${first.length}`)
console.log(`  前 ${topN.length} 平均边缘距离: ${topAverage.toFixed(2)} mm`)
console.log(`  全部候选平均边缘距离: ${allAverage.toFixed(2)} mm`)
console.log(`  固定随机基线: ${randomAverage.toFixed(2)} mm`)
