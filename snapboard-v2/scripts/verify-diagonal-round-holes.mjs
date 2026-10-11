import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const split = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const { createRoundedRectangleOutline } = await server.ssrLoadModule('/src/features/shapeLibrary/presets/generators.ts')
  const { createSplitPanelShape } = await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const cfg = { ...split.PEGBOARD_DEFAULT_CONFIG }
  const outline = (w, h, r, dx = 0, dy = 0) => createRoundedRectangleOutline({ width: w, height: h, cornerRadius: r })
    .map(p => ({ x: p.x + w / 2 + dx, y: p.y + h / 2 + dy }))
  const key = p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
  const has = (panel, x, y) => panel.edge_holes.some(p => Math.hypot(p.x - x, p.y - y) < 1e-4)
  const rows = []
  for (const [w, h] of [[80,80],[100,100],[120,120],[160,160],[200,200],[200,120]]) {
    for (const [dx, dy] of [[0,0],[-125,57]]) {
      const baseline = split.splitOrthogonalPolygon({ points: outline(w, h, 0, dx, dy) }, cfg).panels[0]
      assert.ok(baseline)
      for (const radius of [4,8,12,20]) {
        const points = outline(w, h, radius, dx, dy)
        const result = split.splitOrthogonalPolygon({ points }, cfg)
        assert.equal(result.panels.length, 1)
        const panel = result.panels[0]
        for (const hole of baseline.edge_holes) {
          if (split.sweptCircleFitsMaterial(hole, hole, cfg.jointDiameter / 2, cfg.holeBoundaryClearance, points, []))
            assert.ok(has(panel, hole.x, hole.y), `${w}×${h} R${radius} 漏掉安全圆孔 ${key(hole)}`)
        }
        assert.equal(panel.edge_holes.filter(p => p.knocked).length, 0, '单板候选孔仍由用户决定开启')
        for (const hole of panel.edge_holes)
          assert.ok(split.sweptCircleFitsMaterial(hole, hole, cfg.jointDiameter / 2, cfg.holeBoundaryClearance, panel.contour, panel.cutouts))
        rows.push({ w, h, radius, dx, dy, candidates: panel.edge_holes.length })
      }
    }
  }
  const points = outline(200, 200, 12)
  const panel = split.splitOrthogonalPolygon({ points }, cfg).panels[0]
  assert.equal(panel.edge_holes.length, 18, '截图中的 200×200 圆角板须恢复 18 个候选孔')
  assert.ok(has(panel, 10, 10) && has(panel, 190, 190), '两个对角位置都必须有候选孔')
  const closedShape = createSplitPanelShape(panel, cfg, 24)
  const opened = { ...panel, edge_holes: panel.edge_holes.map(p => ({ ...p, knocked: key(p) === key({x:10,y:10}) || key(p) === key({x:190,y:190}) })) }
  assert.equal(createSplitPanelShape(opened, cfg, 24).holes.length, closedShape.holes.length + 2, '开启后两颗圆孔须进入制造轮廓')
  const wideRadius = split.splitOrthogonalPolygon({ points: outline(200, 200, 32) }, cfg).panels[0]
  assert.ok(!has(wideRadius, 10, 10) && !has(wideRadius, 190, 190), '大圆角导致壁厚不足时仍应避让')
  const cutout = [{x:5,y:5},{x:15,y:5},{x:15,y:15},{x:5,y:15}]
  const cut = split.splitOrthogonalPolygon({ points, holes:[cutout] }, cfg).panels[0]
  assert.ok(!has(cut, 10, 10) && has(cut, 190, 190), '内孔冲突不可用补角孔绕过')
  await mkdir('output/diagonal-hole-fix', { recursive:true })
  await writeFile('output/diagonal-hole-fix/report.json', JSON.stringify({ rows, screenshot200:{ points, slots:panel.slots, holes:panel.edge_holes }, manufacturingAddedHoles:2 }, null, 2))
  console.log(`Diagonal round holes: ${rows.length} rounded-board cases; 200×200 R12 has 18 candidates; material safety and two manufactured holes passed`)
} finally { await server.close() }
