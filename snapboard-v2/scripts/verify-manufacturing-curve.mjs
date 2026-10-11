import assert from 'node:assert/strict'
import { createServer } from 'vite'

// 方案 §3.2 / §5.B：外缘、长孔端部和紧固件孔用两套独立精度预算，且孔的功能尺寸一个都不能变。
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { createSplitPanelShape, slotCapSegments } = await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const { manufacturingCurveSegments } = await server.ssrLoadModule('/src/utils/export3mf.ts')

  const cfg = { ...PEGBOARD_DEFAULT_CONFIG }
  const panel = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 150 }, { x: 0, y: 150 }], holes: [] }, cfg).panels[0]
  assert.ok(panel?.slots.length, 'regression fixture needs slots')

  const divisions = manufacturingCurveSegments(cfg)
  const caps = slotCapSegments(cfg.slotWidth)
  const fine = createSplitPanelShape(panel, cfg).extractPoints(divisions)
  const manufacturing = createSplitPanelShape(panel, cfg, caps).extractPoints(divisions)

  // 1. 孔数量与顺序不变；关键尺寸（长孔宽度由两段直边给出）逐孔实测。
  assert.equal(manufacturing.holes.length, fine.holes.length, '孔数量不得变化')
  const slotWidth = ring => {
    const xs = ring.map(p => p.x)
    const spread = Math.max(...xs) - Math.min(...xs)
    // 胶囊：直边处达到最大宽度；取最大横跨作为关键宽度。
    return spread
  }
  const slotLength = ring => Math.max(...ring.map(p => p.y)) - Math.min(...ring.map(p => p.y))
  const center = ring => [(Math.max(...ring.map(p => p.x)) + Math.min(...ring.map(p => p.x))) / 2,
    (Math.max(...ring.map(p => p.y)) + Math.min(...ring.map(p => p.y))) / 2]
  let widthChecked = 0
  for (let i = 0; i < fine.holes.length; i++) {
    const a = fine.holes[i], b = manufacturing.holes[i]
    const [ax, ay] = center(a), [bx, by] = center(b)
    assert.ok(Math.hypot(ax - bx, ay - by) < 1e-9, `第 ${i} 个孔中心漂移`)
    if (Math.abs(slotWidth(a) - cfg.slotWidth) < 1e-6) {
      widthChecked++
      assert.ok(Math.abs(slotWidth(b) - cfg.slotWidth) < 1e-9, `第 ${i} 个长孔宽度必须精确保持 ${cfg.slotWidth}mm`)
      assert.ok(Math.abs(slotLength(b) - slotLength(a)) < 1e-9, `第 ${i} 个长孔长度必须精确保持`)
    }
  }
  assert.ok(widthChecked > 0, '该工程应包含长孔')

  // 2. 端部圆弧偏差落在 0.10mm 弦高预算内；紧固件圆孔保持原来的更细预算。
  const perpendicularDistance = (point, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y
    const length2 = dx * dx + dy * dy
    const t = length2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy)
  }
  const ringDeviation = (reference, candidate) => Math.max(...reference.map(point =>
    Math.min(...candidate.map((a, i) => perpendicularDistance(point, a, candidate[(i + 1) % candidate.length])))))
  let maximumSlotDeviation = 0, maximumCircleDeviation = 0
  for (let i = 0; i < fine.holes.length; i++) {
    const deviation = ringDeviation(fine.holes[i], manufacturing.holes[i])
    if (Math.abs(slotWidth(fine.holes[i]) - cfg.slotWidth) < 1e-6) maximumSlotDeviation = Math.max(maximumSlotDeviation, deviation)
    else maximumCircleDeviation = Math.max(maximumCircleDeviation, deviation)
  }
  assert.ok(maximumSlotDeviation <= 0.1 + 1e-6, `长孔端部弦高 ${maximumSlotDeviation}mm 超出 0.10mm 预算`)
  assert.ok(maximumCircleDeviation < 0.025, `紧固件圆孔弦高 ${maximumCircleDeviation}mm 超出 0.025mm 预算`)

  // 3. 直线不添点：外轮廓顶点数一个不改，长孔的每段直边只有两个端点。
  assert.equal(manufacturing.shape.length, fine.shape.length, '外轮廓顶点数不得变化（直线不添点）')
  const sideEndpoints = ring => {
    const left = Math.min(...ring.map(p => p.x))
    const right = Math.max(...ring.map(p => p.x))
    const distinctY = x => new Set(ring.filter(p => Math.abs(p.x - x) < 1e-9).map(p => p.y.toFixed(9))).size
    return [distinctY(left), distinctY(right)]
  }
  const slotRing = manufacturing.holes.find(ring => Math.abs(slotWidth(ring) - cfg.slotWidth) < 1e-6)
  assert.deepEqual(sideEndpoints(slotRing), [2, 2], '长孔两段直边各只保留上下两个端点（直线不添点）')

  // 4. 收益：制造截面顶点数显著下降，且端部段数不低于外观最少分段。
  const vertices = result => result.shape.length + result.holes.reduce((n, hole) => n + hole.length, 0)
  assert.ok(caps >= 4, '端部段数不得低于外观最少分段 4')
  assert.equal(caps, 6, '5mm 长孔在 0.10mm 弦高下应为 6 段')
  assert.ok(vertices(manufacturing) < vertices(fine) * 0.5,
    `制造截面顶点应至少减半：${vertices(fine)} → ${vertices(manufacturing)}`)

  console.log(JSON.stringify({ slotCapSegments: caps, holeDivisions: divisions, slotCount: panel.slots.length,
    slotVerticesBefore: vertices(fine), slotVerticesAfter: vertices(manufacturing),
    reductionPercent: +((1 - vertices(manufacturing) / vertices(fine)) * 100).toFixed(1),
    maximumSlotCapDeviationMm: +maximumSlotDeviation.toFixed(4),
    maximumCircleDeviationMm: +maximumCircleDeviation.toFixed(6) }, null, 1))
  console.log('verify:manufacturing-curve OK')
} finally {
  await server.close()
}
