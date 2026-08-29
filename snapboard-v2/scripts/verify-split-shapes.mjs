import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-split-shapes')
const tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [
  tscPath,
  '--ignoreConfig',
  'src/utils/pegboardSplit.ts', 'src/types/geometry.ts',
  '--outDir', outDir, '--module', 'esnext', '--moduleResolution', 'bundler',
  '--target', 'es2023', '--skipLibCheck', 'true',
], { cwd: root, stdio: 'inherit' })

const split = await import(`${pathToFileURL(path.join(outDir, 'utils', 'pegboardSplit.js')).href}?t=${Date.now()}`)
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
  lShape: { panels: lShape.panels.length, minBBoxSide: Math.min(...lShape.panels.map(p => Math.min(p.w, p.h))) },
  uShape: { panels: uShape.panels.length },
  notched: { panels: notched.panels.length, slotClearance: notched.config.holeBoundaryClearance },
  trapezoid: { panels: trapezoid.panels.length, coverage: trapezoid.coverageRatio },
  cutout: { panels: cutout.panels.length, slots: cutout.panels.reduce((sum, panel) => sum + panel.slots.length, 0) },
}, null, 2))
