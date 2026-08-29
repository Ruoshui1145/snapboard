import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-edge-hole-phase')
const tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [
  tscPath,
  '--ignoreConfig',
  'src/utils/pegboardSplit.ts', 'src/types/geometry.ts',
  '--outDir', outDir, '--module', 'esnext', '--moduleResolution', 'bundler',
  '--target', 'es2023', '--skipLibCheck', 'true',
], { cwd: root, stdio: 'inherit' })

const split = await import(`${pathToFileURL(path.join(outDir, 'utils', 'pegboardSplit.js')).href}?t=${Date.now()}`)
const near = (a, b, tolerance = 1e-4) => Math.abs(a - b) <= tolerance
const rect = (width, height) => [
  { x: 0, y: 0 }, { x: width, y: 0 },
  { x: width, y: height }, { x: 0, y: height },
]
const coords = holes => holes.map(hole => [
  Math.round(hole.x * 1000) / 1000,
  Math.round(hole.y * 1000) / 1000,
])
const row = (panel, y) => panel.edge_holes
  .filter(hole => near(hole.y, y)).map(hole => hole.x).sort((a, b) => a - b)
const column = (panel, x) => panel.edge_holes
  .filter(hole => near(hole.x, x)).map(hole => hole.y).sort((a, b) => a - b)
const localKeys = (items, panel) => items.map(item =>
  `${Math.round((item.x - panel.x) * 1000) / 1000},${Math.round((item.y - panel.y) * 1000) / 1000}`,
).sort()

assert.equal(split.PEGBOARD_DEFAULT_CONFIG.jointDiameter, 5, '用户确认圆孔制造规格必须为 φ5')
assert.equal(split.PEGBOARD_DEFAULT_CONFIG.slotStaggerX, 20, '四板拼接 DXF 的 B 相横向错位必须为 20mm')

// 权威 200×200 边孔：孔线严格距边 10mm，四边按最近椭圆孔的互补相位错列。
const standard = split.splitOrthogonalPolygon({ points: rect(200, 200) }).panels[0]
assert.deepEqual(row(standard, 10), [10, 50, 90, 130, 170], '标准板底边 A 相错误')
assert.deepEqual(column(standard, 190), [30, 70, 110, 150, 190], '标准板右边 B 相错误')
assert.deepEqual(row(standard, 190), [30, 70, 110, 150, 190], '标准板顶边 B 相错误')
assert.deepEqual(column(standard, 10), [10, 50, 90, 130, 170], '标准板左边 A 相错误')
assert.equal(standard.edge_holes.length, 18, '标准板应有 18 个去重边孔')
const expectedSlots = []
for (let rowIndex = 0; rowIndex < 10; rowIndex++) {
  const y = 10 + rowIndex * 20
  const x0 = rowIndex % 2 === 0 ? 30 : 10
  for (let x = x0; x <= 190; x += 40) expectedSlots.push(`${x},${y}`)
}
assert.equal(standard.slots.length, 50, '标准 200×200 板应有 50 个长圆孔')
assert.deepEqual(localKeys(standard.slots, standard), expectedSlots.sort(), '标准板长圆孔没有严格复现 DXF')

// 用户提供的“四版拼接.DXF”：四块 200×200 板各自重启同一局部孔阵。
const fourBoard = split.splitOrthogonalPolygon({ points: rect(400, 400) })
assert.equal(fourBoard.panels.length, 4, '400×400 应严格分为四块 200×200 板')
const panels = [...fourBoard.panels].sort((a, b) => a.y - b.y || a.x - b.x)
for (const panel of panels) {
  assert.equal(panel.w, 200)
  assert.equal(panel.h, 200)
  assert.deepEqual(localKeys(panel.slots, panel), localKeys(standard.slots, standard), `${panel.id} 长圆孔未按板件局部原点重起`)
  assert.deepEqual(localKeys(panel.edge_holes, panel), localKeys(standard.edge_holes, standard), `${panel.id} 圆孔未复现 DXF 局部模板`)
}
const [bottomLeft, bottomRight, topLeft] = panels
// 水平接缝：下板顶边 B 相、上板底边 A 相，相差 20mm。
const bottom = bottomLeft
const top = topLeft
const bottomTop = row(bottom, bottom.y + bottom.h - 10)
const topBottom = row(top, top.y + 10)
assert.deepEqual(bottomTop, [30, 70, 110, 150, 190], '下板上边相位错误')
assert.deepEqual(topBottom, [10, 50, 90, 130, 170], '上板下边相位错误')
assert.notDeepEqual(bottomTop, topBottom, '接缝上下两排圆孔不应完全一致')
// 垂直接缝同理：左板右边 B 相、右板左边 A 相。
const leftRight = column(bottomLeft, bottomLeft.x + bottomLeft.w - 10)
const rightLeft = column(bottomRight, bottomRight.x + 10)
assert.deepEqual(leftRight.map(y => y - bottomLeft.y), [30, 70, 110, 150, 190])
assert.deepEqual(rightLeft.map(y => y - bottomRight.y), [10, 50, 90, 130, 170])

// 非模数尺寸也必须保持固定边距；旧算法会因吸附不到全局轴而整条缺孔。
const irregular = split.splitOrthogonalPolygon({ points: rect(155, 285) })
for (const panel of irregular.panels) {
  const x0 = panel.x, x1 = panel.x + panel.w
  const y0 = panel.y, y1 = panel.y + panel.h
  assert.ok(panel.edge_holes.some(hole => hole.y - y0 <= 20 + 1e-6), `${panel.id} 下边缺少圆孔`)
  assert.ok(panel.edge_holes.some(hole => y1 - hole.y <= 20 + 1e-6), `${panel.id} 上边缺少圆孔`)
  assert.ok(panel.edge_holes.some(hole => hole.x - x0 <= 20 + 1e-6), `${panel.id} 左边缺少圆孔`)
  assert.ok(panel.edge_holes.some(hole => x1 - hole.x <= 20 + 1e-6), `${panel.id} 右边缺少圆孔`)
  for (const hole of panel.edge_holes) {
    const onOuterHorizontal = near(hole.y, 0, 20) || near(hole.y, 285, 20)
    const onOuterVertical = near(hole.x, 0, 20) || near(hole.x, 155, 20)
    if (onOuterHorizontal) {
      assert.ok(panel.slots.some(slot => near(slot.y, hole.y) && near(Math.abs(slot.x - hole.x), 20)),
        `${panel.id} 外周水平圆孔不在长孔中间: ${hole.x},${hole.y}`)
    }
    if (onOuterVertical) {
      assert.ok(panel.slots.some(slot => near(slot.x, hole.x) && near(Math.abs(slot.y - hole.y), 20)),
        `${panel.id} 外周垂直圆孔不在长孔中间: ${hole.x},${hole.y}`)
    }
  }
  for (let first = 0; first < panel.edge_holes.length; first++) {
    for (let second = first + 1; second < panel.edge_holes.length; second++) {
      const a = panel.edge_holes[first], b = panel.edge_holes[second]
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 20 - 1e-6,
        `${panel.id} 角点产生双圆孔: ${a.x},${a.y} / ${b.x},${b.y}`)
    }
  }
}

// 非模数分板仍必须从整张轮廓唯一母阵裁取，不能按 P1/P2…重新起相位。
const nonModularMother = split.splitOrthogonalPolygon({ points: rect(500, 280) })
const allSlots = nonModularMother.panels.flatMap(panel => panel.slots)
const slotKeys = new Set(allSlots.map(slot => `${slot.x.toFixed(4)},${slot.y.toFixed(4)}`))
assert.equal(slotKeys.size, allSlots.length, '同一母阵长孔被多个分板重复领取')
for (const slot of allSlots) {
  const xPhase = ((slot.x % 40) + 40) % 40
  const yPhase = ((slot.y % 40) + 40) % 40
  const onA = near(xPhase, 10) && near(yPhase, 30)
  const onB = near(xPhase, 30) && near(yPhase, 10)
  assert.ok(onA || onB, `非模数分板重新起了错误长孔相位: ${slot.x},${slot.y}`)
}

// 阶梯/凹角场景复现截图中的边角双孔风险；每块板内部任意两颗圆孔中心距不得小于20mm。
const stepped = split.splitOrthogonalPolygon({ points: [
  { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 },
  { x: 240, y: 200 }, { x: 240, y: 320 }, { x: 120, y: 320 },
  { x: 120, y: 400 }, { x: 0, y: 400 },
] })
for (const panel of stepped.panels) {
  for (let first = 0; first < panel.edge_holes.length; first++) {
    for (let second = first + 1; second < panel.edge_holes.length; second++) {
      const a = panel.edge_holes[first], b = panel.edge_holes[second]
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 20 - 1e-6,
        `${panel.id} 阶梯角仍有双圆孔: ${a.x},${a.y} / ${b.x},${b.y}`)
    }
  }
}

// 截图同类非模数外周：圆孔必须与最近长孔共线，并与某颗长孔沿边相差半节距20mm。
const screenshotOuter = split.splitOrthogonalPolygon({ points: rect(189.15, 174.242) }).panels[0]
for (const hole of screenshotOuter.edge_holes) {
  const nearHorizontalOuter = hole.y <= 30 || screenshotOuter.h - hole.y <= 30
  const nearVerticalOuter = hole.x <= 30 || screenshotOuter.w - hole.x <= 30
  if (nearHorizontalOuter) {
    assert.ok(screenshotOuter.slots.some(slot => near(slot.y, hole.y) && near(Math.abs(slot.x - hole.x), 20)),
      `截图尺寸外周水平圆孔未处于长孔中点: ${hole.x},${hole.y}`)
  }
  if (nearVerticalOuter) {
    assert.ok(screenshotOuter.slots.some(slot => near(slot.x, hole.x) && near(Math.abs(slot.y - hole.y), 20)),
      `截图尺寸外周垂直圆孔未处于长孔中点: ${hole.x},${hole.y}`)
  }
}

console.log(JSON.stringify({
  standard200: { count: standard.edge_holes.length, holes: coords(standard.edge_holes) },
  fourBoardDxf: { panels: panels.length, slotsPerPanel: 50, circlesPerPanel: 18, diameter: 5 },
  seams: { bottomTop, topBottom, leftRight, rightLeft, staggered: true },
  nonModular: irregular.panels.map(panel => ({
    id: panel.id, size: `${panel.w}x${panel.h}`, edgeHoles: panel.edge_holes.length,
  })),
  motherGrid: { panels: nonModularMother.panels.length, uniqueSlots: slotKeys.size },
  steppedCorners: { panels: stepped.panels.length, minimumCircleSpacing: 20 },
  screenshotOuter: { size: `${screenshotOuter.w}x${screenshotOuter.h}`, holes: screenshotOuter.edge_holes.length },
}, null, 2))
