import assert from 'node:assert/strict'
import { checkModule } from './check-module.mjs'
const split = await checkModule('src/utils/pegboardSplit.ts')
const rect = (x0, y0, x1, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
]
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance
const pointSegmentDistance = (point, a, b) => {
  const vx = b.x - a.x, vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2))
  return Math.hypot(point.x - (a.x + t * vx), point.y - (a.y + t * vy))
}
const segmentDistance = (a, b, c, d) => Math.min(
  pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
  pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
)
const verifySlotClearance = result => {
  const required = result.config.slotWidth / 2 + result.config.holeBoundaryClearance
  const straightHalf = (result.config.slotLength - result.config.slotWidth) / 2
  for (const panel of result.panels) {
    const loops = [panel.contour, ...(panel.cutouts ?? [])]
    for (const slot of panel.slots) {
      const a = { x: slot.x, y: slot.y - straightHalf }
      const b = { x: slot.x, y: slot.y + straightHalf }
      for (const loop of loops) {
        const distance = Math.min(...loop.map((point, index) =>
          segmentDistance(a, b, point, loop[(index + 1) % loop.length])))
        assert.ok(distance + 1e-5 >= required,
          `${panel.id} 槽孔 (${slot.x},${slot.y}) 距轮廓仅 ${distance.toFixed(3)}mm，应至少 ${required}mm`)
      }
    }
  }
}
const verifyCoverage = (name, result) => {
  assert.ok(close(result.coverageRatio, 1, 1e-3), `${name} 覆盖率错误: ${result.coverageRatio}`)
  assert.ok(result.panels.length > 0, `${name} 没有输出板件`)
  verifySlotClearance(result)
}

const rectangle = split.splitOrthogonalPolygon({ points: rect(0, 0, 500, 280) })
verifyCoverage('规则矩形', rectangle)
assert.equal(rectangle.panels.length, 6, '500×280 应生成 3×2 对齐网格，不能带 20mm 细条')
assert.deepEqual([...new Set(rectangle.panels.map(panel => panel.y))], [0, 140])
assert.ok(rectangle.panels.every(panel => Math.min(panel.w, panel.h) >= 140), '规则矩形出现细长板')
const rectangleAgain = split.splitOrthogonalPolygon({ points: rect(0, 0, 500, 280) })
assert.deepEqual(
  rectangleAgain.panels.map(panel => [panel.x, panel.y, panel.w, panel.h]),
  rectangle.panels.map(panel => [panel.x, panel.y, panel.w, panel.h]),
  '同一矩形重复分割必须完全确定，不能随机错位',
)

// 圆角外轮廓在进入分割器前由 App 离散为多边形；分割器仍需保持完整覆盖、
// 不生成零面积板件，并把最终边界交给原始矢量布尔裁剪，而不是按包围盒裁掉圆角。
const roundedRect = (x0, y0, x1, y1, radius, steps = 8) => {
  const corners = [
    [x1 - radius, y0 + radius, -Math.PI / 2, 0],
    [x1 - radius, y1 - radius, 0, Math.PI / 2],
    [x0 + radius, y1 - radius, Math.PI / 2, Math.PI],
    [x0 + radius, y0 + radius, Math.PI, Math.PI * 1.5],
  ]
  return corners.flatMap(([cx, cy, start, end]) => Array.from({ length: steps }, (_, index) => {
    const angle = start + (end - start) * index / steps
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  }))
}
const rounded = split.splitOrthogonalPolygon({ points: roundedRect(0, 0, 500, 280, 8) })
verifyCoverage('圆角矩形外轮廓', rounded)
assert.ok(rounded.panels.every(panel => panel.w > 0 && panel.h > 0), '圆角矩形生成了退化板件')
assert.ok(rounded.coverageRatio > 0.999, `圆角矩形覆盖率错误: ${rounded.coverageRatio}`)

// 用户回归：矩形边框裁掉多余边后，由两条直线 + 四分之一圆弧闭合的曲线扇形。
// 这类轮廓不能退回包围盒，也不能因非正交边只生成一块不可打印大板。
const curvedSector = [
  { x: 0, y: 0 },
  ...Array.from({ length: 25 }, (_, index) => {
    const angle = (Math.PI / 2) * index / 24
    return { x: Math.cos(angle) * 500, y: Math.sin(angle) * 500 }
  }),
]
const curved = split.splitOrthogonalPolygon({ points: curvedSector })
verifyCoverage('直线+圆弧闭合扇形', curved)
assert.ok(curved.panels.length > 1, '500mm 曲线扇形没有按热床尺寸分板')
assert.ok(curved.panels.some(panel => panel.contour.length > 4), '曲线扇形分板丢失了圆弧离散边界')
assert.ok(curved.coverageRatio > 0.999, `曲线扇形覆盖率错误: ${curved.coverageRatio}`)

const lShape = split.splitOrthogonalPolygon({ points: [
  { x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 220 },
  { x: 400, y: 220 }, { x: 400, y: 360 }, { x: 0, y: 360 },
] })
verifyCoverage('L 形', lShape)
assert.ok(lShape.panels.every(panel => Math.min(panel.w, panel.h) >= 100), 'L 形仍产生不可固定细条')
assert.ok(!lShape.warnings.some(warning => warning.includes('局部结构宽度')), lShape.warnings.join('; '))

const uShape = split.splitOrthogonalPolygon({ points: [
  { x: 0, y: 0 }, { x: 360, y: 0 }, { x: 360, y: 360 }, { x: 280, y: 360 },
  { x: 280, y: 140 }, { x: 80, y: 140 }, { x: 80, y: 360 }, { x: 0, y: 360 },
] })
verifyCoverage('U 形', uShape)
assert.ok(uShape.panels.every(panel => Math.min(panel.w, panel.h) >= 80), 'U 形支臂被切成细条')

const notched = split.splitOrthogonalPolygon({ points: [
  { x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 300 },
  { x: 340, y: 300 }, { x: 340, y: 240 }, { x: 280, y: 240 },
  { x: 280, y: 300 }, { x: 0, y: 300 },
] })
verifyCoverage('缺口形', notched)
const notchedSlots = notched.panels.flatMap(panel => panel.slots)
assert.ok(!notchedSlots.some(slot => close(slot.x, 290) && close(slot.y, 270)),
  '位于缺口内部的 A 相槽孔没有被自动删除')
assert.ok(!notchedSlots.some(slot => close(slot.x, 312.2648) && close(slot.y, 250)),
  '位于缺口内部的 B 相槽孔没有被自动删除')

const trapezoid = split.splitOrthogonalPolygon({ points: [
  { x: 0, y: 0 }, { x: 500, y: 0 }, { x: 420, y: 300 }, { x: 60, y: 300 },
] })
verifyCoverage('梯形', trapezoid)
assert.ok(trapezoid.warnings.some(warning => warning.includes('原始矢量轮廓')), '梯形应明确保留原始斜边')

const cutout = split.splitOrthogonalPolygon({
  points: rect(0, 0, 400, 240),
  holes: [rect(165, 70, 235, 170)],
})
verifyCoverage('带内孔', cutout)
assert.ok(cutout.panels.some(panel => (panel.cutouts?.length ?? 0) > 0), '内孔没有进入制造轮廓')

console.log(JSON.stringify({
  rectangle: { panels: rectangle.panels.length, grid: '3x2', deterministic: true },
  rounded: { panels: rounded.panels.length, coverage: rounded.coverageRatio },
  curvedSector: { panels: curved.panels.length, coverage: curved.coverageRatio },
  lShape: { panels: lShape.panels.length, minBBoxSide: Math.min(...lShape.panels.map(p => Math.min(p.w, p.h))) },
  uShape: { panels: uShape.panels.length },
  notched: { panels: notched.panels.length, slotClearance: notched.config.holeBoundaryClearance },
  trapezoid: { panels: trapezoid.panels.length, coverage: trapezoid.coverageRatio },
  cutout: { panels: cutout.panels.length, slots: cutout.panels.reduce((sum, panel) => sum + panel.slots.length, 0) },
}, null, 2))
