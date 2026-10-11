/**
 * 遮挡度量内核与模式策略回归。
 *
 * 被测模块不依赖 Three.js 或 React，编译 TS 后在 Node.js 中运行，
 * 编译方式与 verify-assembly-snap.mjs 一致。
 *
 * 覆盖：
 *  - 三区面积之和 = 板件实体面积（扣除内孔）
 *  - U 形板分区面积走真实轮廓求交，而不是包围盒比例
 *  - 投影重叠按并集计（遮挡率不会翻倍）
 *  - 空装配 / 背面件 / 尺寸缺失件的边界行为
 *  - 相同输入结果完全可复现
 *  - 三种模式阈值、边界评级与中文提示
 */
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { checkModule } from './check-module.mjs'
const [model,policy,overlayModel] = await Promise.all(["src/utils/occlusionModel.ts","src/utils/occlusionPolicy.ts","src/utils/occlusionOverlay.ts"].map(checkModule))

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const rectPanel = (id, x, y, w, h, cutouts) => ({
  id, x, y, w, h,
  contour: [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ],
  cutouts,
  slots: [], round_holes: [], edge_holes: [],
})

/** U 形（开口朝上）：底 bar 高 60，两侧支臂宽 80，外框 400×300，实体面积 62400。 */
const uPanel = {
  id: 'u1', x: 0, y: 0, w: 400, h: 300,
  contour: [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 320, y: 300 },
    { x: 320, y: 60 }, { x: 80, y: 60 }, { x: 80, y: 300 }, { x: 0, y: 300 },
  ],
  slots: [], round_holes: [], edge_holes: [],
}

const makeDef = (id, dims, orientation = [0, 0, 0], upAxis = 'y') => ({
  id,
  category: 'hook',
  name: id,
  params: [],
  model: dims
    ? { preview: 'x.stl', format: 'stl', unit: 'millimeter', upAxis, scale: 1, dimensionsMm: dims, orientation }
    : { preview: 'x.stl', format: 'stl', unit: 'millimeter', upAxis, scale: 1, orientation },
  mount: { mode: 'single', anchors: [] },
  defaultRotation: 0,
})

const place = (id, defId, x, y, side = 'front', rotationZ = 0) => ({
  id,
  defId,
  rotation: 0,
  params: {},
  placement: { surface: 'split-panel', side, panelId: 'p1', position: [x, y, 5], rotationZ, targetIds: [] },
})

const close = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: 期望 ${expected} ±${tolerance}，实际 ${actual}`,
  )

// ---------------------------------------------------------------------------
// 1. 三区面积之和 = 板件实体面积（扣除内孔）
// ---------------------------------------------------------------------------

{
  // 400×300 矩形，中部挖 100×100 内孔 → 实体面积 110000
  const panels = [rectPanel('p1', 0, 0, 400, 300, [
    [{ x: 150, y: 100 }, { x: 250, y: 100 }, { x: 250, y: 200 }, { x: 150, y: 200 }],
  ])]
  const layout = model.boardZoneLayout(panels)
  close(layout.totalArea, 110000, 550, '矩形板 三区面积之和')
  close(layout.zones[0].area, 36000, 180, '承重收纳区面积')
  close(layout.zones[1].area, 38000, 190, '高频使用区面积（内孔落在此区）')
  close(layout.zones[2].area, 36000, 180, '视觉核心区面积')
  assert.equal(layout.zones.length, 3)
  assert.deepEqual(layout.zones.map(z => z.id), ['load-storage', 'frequent-use', 'visual-core'])
}

// ---------------------------------------------------------------------------
// 2. U 形板必须走真实轮廓求交
// ---------------------------------------------------------------------------

{
  const layout = model.boardZoneLayout([uPanel])
  const bboxArea = 400 * 300
  close(layout.totalArea, 62400, 320, 'U 形板实体面积')
  // 包围盒近似会给出 36000（120000 × 30%）；真实轮廓只有两支臂 = 14400。
  const visual = layout.zones.find(z => z.id === 'visual-core')
  close(visual.area, 14400, 100, 'U 形板视觉核心区面积（两支臂）')
  assert.ok(
    visual.area < bboxArea * 0.30 * 0.6,
    `视觉核心区必须远小于包围盒的 30%（${bboxArea * 0.3}），实际 ${visual.area}`,
  )
  close(layout.zones[1].area, 19200, 120, 'U 形板高频使用区面积')
  close(layout.zones[0].area, 28800, 160, 'U 形板承重收纳区面积')
}

// ---------------------------------------------------------------------------
// 3. 空装配：遮挡率 0、可见面保留率 100%
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 400, 300)]
  const def = makeDef('t:hook', [100, 100, 20])
  const report = model.computeOcclusionReport(panels, [], [def])
  assert.equal(report.occlusionRatio, 0, '无配件时遮挡率必须为 0')
  assert.equal(report.visibleExposureRatio, 1, '无配件时可见面保留率必须为 100%')
  assert.equal(report.footprints.length, 0)
  assert.equal(report.backPartCount, 0)
  // 板面有效面积应等于 120000（栅格统计，允许格距量化误差）
  const materialCells = report.grid.material.reduce((sum, v) => sum + v, 0)
  close(materialCells * report.cellSize * report.cellSize, 120000, 1200, '栅格板材面积')
}

// ---------------------------------------------------------------------------
// 4. 投影重叠按并集计：遮挡率不得翻倍
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 400, 300)]
  const def = makeDef('t:hook', [100, 100, 20])
  const one = model.computeOcclusionReport(panels, [place('a1', 't:hook', 0, 150)], [def])
  // 两件完全重叠、两件部分重叠，都不应让遮挡率翻倍
  const stacked = model.computeOcclusionReport(
    panels,
    [place('a1', 't:hook', 0, 150), place('a2', 't:hook', 0, 150)],
    [def],
  )
  const partial = model.computeOcclusionReport(
    panels,
    [place('a1', 't:hook', 0, 150), place('a2', 't:hook', 50, 150)],
    [def],
  )
  close(one.occlusionRatio, 10000 / 120000, 0.01, '单件遮挡率')
  assert.ok(
    Math.abs(stacked.occlusionRatio - one.occlusionRatio) < 0.005,
    `完全重叠的两件不得重复计数：单件 ${one.occlusionRatio}，两件 ${stacked.occlusionRatio}`,
  )
  assert.ok(
    partial.occlusionRatio > one.occlusionRatio &&
    partial.occlusionRatio < one.occlusionRatio * 2 + 0.005,
    `部分重叠应落在单件与两倍之间，实际 ${partial.occlusionRatio}`,
  )
  // 并集语义：任何输入下遮挡率都必须落在 [0,1]
  for (const r of [one, stacked, partial]) {
    assert.ok(r.occlusionRatio >= 0 && r.occlusionRatio <= 1, `遮挡率越界：${r.occlusionRatio}`)
  }
}

// ---------------------------------------------------------------------------
// 5. 背面件不计入正面遮挡；未标定朝向不崩溃
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 400, 300)]
  const def = makeDef('t:hook', [100, 100, 20])
  const report = model.computeOcclusionReport(panels, [place('b1', 't:hook', 0, 150, 'back')], [def])
  assert.equal(report.occlusionRatio, 0, '背面件不应遮挡正面展示面')
  assert.equal(report.backPartCount, 1)
  assert.equal(report.footprints.length, 1)

  // 旋转 90°：100×100 仍是 100×100，但 40×100 会变成 100×40
  const slim = makeDef('t:slim', [40, 100, 20])
  const flat = model.computeOcclusionReport(panels, [place('c1', 't:slim', 0, 150, 'front', 0)], [slim])
  const turned = model.computeOcclusionReport(panels, [place('c2', 't:slim', 0, 150, 'front', Math.PI / 2)], [slim])
  const flatFp = flat.footprints[0]
  const turnedFp = turned.footprints[0]
  close(flatFp.width, 40, 0.01, '未旋转投影宽')
  close(flatFp.height, 100, 0.01, '未旋转投影高')
  close(turnedFp.width, 100, 0.01, '旋转 90° 后投影宽')
  close(turnedFp.height, 40, 0.01, '旋转 90° 后投影高')
  // 面积不变 → 遮挡率应当一致（误差来自栅格量化）
  assert.ok(Math.abs(flat.occlusionRatio - turned.occlusionRatio) < 0.01, '旋转不应改变投影面积')
}

// ---------------------------------------------------------------------------
// 6. dimensionsMm 缺失 → 标记为 unknown，不能静默当成 0 面积计入
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 400, 300)]
  const noDims = makeDef('t:nodims', null)
  const report = model.computeOcclusionReport(panels, [place('d1', 't:nodims', 0, 150)], [noDims])
  assert.equal(report.unknownFootprintCount, 1, 'dimensionsMm 缺失必须被标记为 unknown')
  assert.equal(report.footprints[0].unknown, true)
  assert.equal(report.footprints[0].grossArea, 0)
}

// ---------------------------------------------------------------------------
// 7. 确定性：相同输入重复调用结果完全一致
// ---------------------------------------------------------------------------

{
  const panels = [uPanel, rectPanel('p2', 0, -200, 200, 200)]
  const def = makeDef('t:hook', [60, 80, 20])
  const parts = [
    place('a1', 't:hook', -100, 120),
    place('a2', 't:hook', 60, 40),
    place('a3', 't:hook', 120, 260, 'back'),
  ]
  const first = model.computeOcclusionReport(panels, parts, [def])
  const second = model.computeOcclusionReport(panels, parts, [def])
  const shape = r => JSON.stringify({
    ratio: r.occlusionRatio,
    visible: r.visibleExposureRatio,
    gross: r.grossOcclusionRatio,
    total: r.board.totalArea,
    zones: r.zones.map(z => [z.id, z.area, z.occludedArea, z.ratio, z.partCount]),
    cell: r.cellSize,
  })
  assert.equal(shape(first), shape(second), '相同输入必须得到完全相同的结果')
  assert.ok(first.board.zones.every(z => z.area > 0))
}

// ---------------------------------------------------------------------------
// 8. 分区比例可覆盖且自动归一化
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 400, 300)]
  const layout = model.boardZoneLayout(panels, { 'visual-core': 0.5, 'frequent-use': 0.3, 'load-storage': 0.2 })
  close(layout.zones[0].area, 400 * 60, 130, '自定义比例 承重收纳区')
  close(layout.zones[2].area, 400 * 150, 300, '自定义比例 视觉核心区')

  // 未归一化（合计 2）时按比例摊回，不留空隙也不重叠
  const scaled = model.boardZoneLayout(panels, { 'visual-core': 1, 'frequent-use': 0.6, 'load-storage': 0.4 })
  close(scaled.totalArea, 120000, 600, '非归一化比例摊回后总面积不变')
}

// ---------------------------------------------------------------------------
// 9. 纹理避让区只改变纹理可见度口径，不改变全板遮挡率
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 100, 100)]
  const def = makeDef('t:block', [20, 20, 10])
  const leftPart = place('left', 't:block', -25, 50)
  const noAvoid = model.computeOcclusionReport(panels, [leftPart], [def])
  const avoided = model.computeOcclusionReport(panels, [leftPart], [def], {
    textureAvoidZones: [{ id: 'left', name: '左侧留白', x: 0, y: 0, width: 0.5, height: 1, enabled: true }],
  })
  const visibleTexturePart = model.computeOcclusionReport(
    panels,
    [leftPart, place('right', 't:block', 25, 50)],
    [def],
    { textureAvoidZones: [{ id: 'left', name: '左侧留白', x: 0, y: 0, width: 0.5, height: 1, enabled: true }] },
  )
  close(noAvoid.texturedAreaRatio, 1, 1e-12, '无避让区时整板具有纹理')
  close(noAvoid.textureVisibleRatio, noAvoid.visibleExposureRatio, 1e-12, '无避让区时纹理可见度等于板面保留率')
  close(avoided.texturedAreaRatio, 0.5, 0.06, '左半板避让后纹理面积约为一半')
  assert.ok(avoided.occlusionRatio > 0, '避让区里的配件仍计入全板遮挡')
  assert.ok(avoided.textureVisibleRatio > 0.99, '只遮挡避让区时剩余纹理应完整可见')
  assert.ok(visibleTexturePart.textureVisibleRatio < 0.99, '纹理区存在配件时纹理可见度必须下降')
}

// ---------------------------------------------------------------------------
// 10. 模式阈值与评级边界
// ---------------------------------------------------------------------------

{
  assert.deepEqual(policy.OCCLUSION_MODE_THRESHOLDS, {
    display: 0.25,
    balanced: 0.40,
    storage: 0.55,
  })

  const boundaries = [
    [0, 'display-first'],
    [0.249999, 'display-first'],
    [0.25, 'balanced'],
    [0.40, 'balanced'],
    [0.400001, 'storage-first'],
    [0.55, 'storage-first'],
    [0.550001, 'overcrowded'],
    [1, 'overcrowded'],
  ]
  for (const [ratio, expected] of boundaries) {
    assert.equal(policy.rateOcclusion(ratio), expected, `遮挡率 ${ratio} 的边界评级`)
    assert.ok(policy.occlusionHint(ratio).length >= 10, `遮挡率 ${ratio} 必须给出中文提示`)
  }

  assert.equal(policy.isWithinOcclusionTarget(0.25, 'display'), true, '展示模式 25% 应达标')
  assert.equal(policy.isWithinOcclusionTarget(0.250001, 'display'), false, '展示模式超过 25% 应超标')
  assert.equal(policy.isWithinOcclusionTarget(0.40, 'balanced'), true, '平衡模式 40% 应达标')
  assert.equal(policy.isWithinOcclusionTarget(0.55, 'storage'), true, '收纳模式 55% 应达标')

  const displayOver = policy.evaluateOcclusionPolicy(0.32, 'display')
  assert.equal(displayOver.status, 'over-target')
  assert.equal(displayOver.rating, 'balanced')
  close(displayOver.excessRatio, 0.07, 1e-12, '展示模式超标量')

  const storageOk = policy.evaluateOcclusionPolicy(0.54, 'storage')
  assert.equal(storageOk.status, 'within-target')
  assert.equal(storageOk.rating, 'storage-first')

  const replan = policy.evaluateOcclusionPolicy(0.56, 'storage')
  assert.equal(replan.status, 'replan')
  assert.equal(replan.statusLabel, '建议重新布局')
}

// ---------------------------------------------------------------------------
// 11. 策略输入归一化与确定性
// ---------------------------------------------------------------------------

{
  assert.equal(policy.normalizeOcclusionRatio(-0.2), 0)
  assert.equal(policy.normalizeOcclusionRatio(1.2), 1)
  assert.equal(policy.normalizeOcclusionRatio(Number.NaN), 0)
  assert.equal(policy.normalizeOcclusionRatio(Infinity), 1)
  assert.equal(policy.normalizeOcclusionRatio(-Infinity), 0)

  for (const mode of ['display', 'balanced', 'storage']) {
    const first = policy.evaluateOcclusionPolicy(0.412345, mode)
    const second = policy.evaluateOcclusionPolicy(0.412345, mode)
    assert.deepEqual(first, second, `${mode} 模式策略必须完全确定`)
    assert.ok(first.hint.length > 0 && first.statusLabel.length > 0)
  }
}

// ---------------------------------------------------------------------------
// 12. 3D 叠加层创建/关闭必须完整移除场景对象
// ---------------------------------------------------------------------------

{
  const panels = [rectPanel('p1', 0, 0, 100, 100)]
  const def = makeDef('t:block', [30, 30, 10])
  const report = model.computeOcclusionReport(panels, [place('center', 't:block', 0, 50)], [def])
  const overlay = overlayModel.createOcclusionOverlay({ report, panels, surfaceZ: 5 })
  const parent = new THREE.Group()
  parent.add(overlay)
  assert.equal(overlay.name, 'occlusion-overlay')
  assert.ok(overlay.children.length >= 4, '叠加层应包含三区边界和热力格')
  assert.ok(overlay.userData.occlusionOverlay, '叠加层应暴露诊断统计')
  overlayModel.disposeOcclusionOverlay(overlay)
  assert.equal(parent.children.includes(overlay), false, '关闭叠加层后不得残留在场景父节点')
  assert.equal(overlay.children.length, 0, '关闭叠加层后必须清空子对象')
  assert.deepEqual(overlay.userData, {}, '关闭叠加层后必须清空诊断引用')
  overlayModel.disposeOcclusionOverlay(overlay)
}

console.log('✓ verify:occlusion — 遮挡度量、模式策略与 3D 叠加生命周期全部断言通过')
