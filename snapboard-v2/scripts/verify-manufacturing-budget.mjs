import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { computeManufacturingBudget, MANUFACTURING_BUDGET_LIMITS } = await server.ssrLoadModule('/src/utils/manufacturingBudget.ts')

  const panel = (x, y, w, h, contour) => ({ id: `P${x}_${y}_${w}x${h}`, x, y, w, h, contour, slots: [], round_holes: [], edge_holes: [] })
  const budgetOf = (panels, artAreaMm2, lineWidthMm = 0.42) => computeManufacturingBudget({ panels, artAreaMm2, lineWidthMm })
  const close = (actual, expected, tolerance, name) => assert.ok(Math.abs(actual - expected) <= tolerance,
    `${name}: 期望 ${expected}±${tolerance}, 实际 ${actual}`)

  // 1. 方案 §3.1 的记录值：580×920 合成范围、最大板 200×240，应得 p≈0.5165mm / 约 49.2 PPI，
  //    并与研究文档“约 200 万整单格、最大板约 18 万格”一致。
  const documented = budgetOf([panel(0, 0, 200, 240), panel(380, 680, 200, 240)], 580 * 920)
  close(documented.artAreaMm2, 533600, 0, 'A_art')
  close(documented.panelAreaMm2, 96000, 0, 'A_all')
  assert.equal(documented.governing, 'project-area', '长亮规模应由整单面积项决定间距')
  close(documented.pitchMm, 0.516526, 1e-6, 'p')
  close(documented.ppi, 49.2, 0.05, '制造 PPI')
  close(documented.totalCells, 2_000_000, 1, '整单格数')
  close(documented.peakPanelCells, 179_910, 1, '最大板格数')
  close(documented.terms['plate-area'], 0.438178, 1e-6, '单床面积项')
  close(documented.terms['plate-edge'], 240 / 512, 1e-9, '单床最长边项')
  close(documented.terms['line-width'], 0.42, 0, '线宽项')

  // 2. 线宽下限：小工程旧公式被 0.1mm 下限压住，比 0.42mm 线宽多出一个数量级的格点。
  const small = budgetOf([panel(0, 0, 120, 90)], 120 * 90)
  assert.equal(small.governing, 'line-width', '小板应由线宽决定间距')
  close(small.pitchMm, 0.42, 0, '线宽下限')
  const previousPitch = Math.max(0.1, Math.sqrt(120 * 90 / 2_000_000))
  const cellsAt = pitch => 120 * 90 / (pitch * pitch)
  assert.ok(cellsAt(previousPitch) / cellsAt(small.pitchMm) > 17,
    `线宽下限至少应减少一个数量级的格点，实际仅 ${(cellsAt(previousPitch) / cellsAt(small.pitchMm)).toFixed(1)} 倍`)

  // 3. 单热床面积上限：一块 1000×1000 大板不得突破 25 万格。
  const huge = budgetOf([panel(0, 0, 1000, 1000)], 1_000_000)
  assert.equal(huge.governing, 'plate-area', '单块大板应由单床面积项决定间距')
  close(huge.pitchMm, 2, 1e-9, '单床面积上限间距')
  close(huge.peakPanelCells, MANUFACTURING_BUDGET_LIMITS.plateCells, 1e-6, '单床格数')

  // 4. 单热床最长边上限：细长板不得突破 512 格/边。
  const slender = budgetOf([panel(0, 0, 100, 2000)], 200_000)
  assert.equal(slender.governing, 'plate-edge', '细长板应由单床最长边项决定间距')
  close(slender.pitchMm, 2000 / 512, 1e-9, '单床最长边上限间距')
  close(slender.peakPanelEdgeMm / slender.pitchMm, 512, 1e-9, '单床最长边格数')

  // 5. 阶段 A 门禁：整单总量与每热床峰值必须同时成立。
  const gate = cases => {
    for (const [name, budget] of cases) {
      assert.ok(budget.totalCells <= MANUFACTURING_BUDGET_LIMITS.totalCells + 1e-6, `${name}: 整单格数超预算 ${budget.totalCells}`)
      assert.ok(budget.peakPanelCells <= MANUFACTURING_BUDGET_LIMITS.plateCells + 1e-6, `${name}: 单板格数超预算 ${budget.peakPanelCells}`)
      assert.ok(budget.peakPanelEdgeMm / budget.pitchMm <= MANUFACTURING_BUDGET_LIMITS.plateEdgeCells + 1e-6, `${name}: 单板最长边超预算`)
      assert.ok(budget.pitchMm >= budget.terms['line-width'] - 1e-12, `${name}: 间距低于线宽`)
    }
  }
  const longliang = Array.from({ length: 11 }, (_, i) => panel((i % 4) * 145, Math.floor(i / 4) * 230, 140, 220))
  gate([
    ['长亮 11 板', budgetOf(longliang, 580 * 920)],
    ['单小板', small], ['单大板', huge], ['细长板', slender], ['记录值', documented],
    ['极密小件', budgetOf([panel(0, 0, 20, 20)], 400)],
  ])

  // 6. 单热床峰值口径：板件数量只影响整单项，不得把单床项变成整单求和，
  //    否则“空热床”会连带把每块小板一起降精度。
  const peakBoard = panel(0, 0, 140, 220)
  const oneBoard = budgetOf([peakBoard], peakBoard.w * peakBoard.h)
  const elevenBoards = budgetOf(longliang, 580 * 920)
  close(elevenBoards.terms['plate-area'], oneBoard.terms['plate-area'], 1e-12, '单床面积项不随板数变化')
  close(elevenBoards.terms['plate-edge'], oneBoard.terms['plate-edge'], 1e-12, '单床最长边项不随板数变化')
  assert.ok(elevenBoards.terms['project-area'] > oneBoard.terms['project-area'], '整单面积项应随板件总量增长')

  // 7. 采样框口径：有轮廓时取轮廓包围盒，无轮廓时退回 (x,y,w,h)。
  const contoured = budgetOf([panel(0, 0, 500, 500, [{ x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 260 }, { x: 10, y: 260 }])], 1_000_000)
  close(contoured.peakPanelAreaMm2, 200 * 240, 0, '轮廓采样框面积')
  close(contoured.peakPanelEdgeMm, 240, 0, '轮廓采样框最长边')

  // 8. 制造导出里的采样精度倍率：杂色斑来自粗格点量化，用户调高时必须真的加密格点，
  //    整单与单床预算同比放大，间距下限同比缩小。
  const detailed = computeManufacturingBudget({ panels: longliang, artAreaMm2: 580 * 920, lineWidthMm: 0.42, detail: 4 })
  close(detailed.pitchMm, documented.pitchMm / 2, 1e-9, '精度 ×4 时间距减半')
  close(detailed.limits.totalCells, MANUFACTURING_BUDGET_LIMITS.totalCells * 4, 0, '整单格数上限随倍率放大')
  close(detailed.limits.plateCells, MANUFACTURING_BUDGET_LIMITS.plateCells * 4, 0, '单床格数上限随倍率放大')
  close(detailed.terms['line-width'], 0.21, 1e-9, '线宽下限随倍率缩小')
  // 浮点除法在这里刚好压在预算边界上，用相对容差而不是绝对容差。
  assert.ok(detailed.totalCells <= detailed.limits.totalCells * (1 + 1e-9), '加密后仍不得超出放大的整单预算')
  assert.ok(detailed.peakPanelCells <= detailed.limits.plateCells * (1 + 1e-9), '加密后单床仍不得超预算')
  assert.ok(detailed.peakPanelEdgeMm / detailed.pitchMm <= detailed.limits.plateEdgeCells * (1 + 1e-9), '加密后单板最长边仍不得超预算')
  assert.equal(budgetOf(longliang, 580 * 920).pitchMm, documented.pitchMm, '默认倍率 1 必须保持方案首轮预算不变')

  // 9. 确定性与信任边界：同一工程多次导出必须得到同一间距；非法配置必须拒绝而不是静默降级。
  assert.deepEqual(budgetOf(longliang, 580 * 920), budgetOf(longliang, 580 * 920), '同一输入必须得到同一预算')
  assert.throws(() => budgetOf([panel(0, 0, 10, 10)], 100, 0), /线宽/, '零线宽必须被拒绝')
  assert.throws(() => budgetOf([panel(0, 0, 10, 10)], Number.NaN), /面积/, '非法面积必须被拒绝')
  assert.equal(budgetOf([], 100), null, '没有可用板件时应返回 null')

  const report = budget => `p=${budget.pitchMm.toFixed(4)}mm ${budget.ppi.toFixed(1)}PPI 主因=${budget.governing} 整单=${Math.round(budget.totalCells)}格 单板峰值=${Math.round(budget.peakPanelCells)}格`
  console.log('制造预算统一计算：')
  console.log(`  记录值(580×920)   ${report(documented)}`)
  console.log(`  长亮 11 板        ${report(budgetOf(longliang, 580 * 920))}`)
  console.log(`  120×90 小板       ${report(small)}  ← 旧公式 ${previousPitch.toFixed(4)}mm / ${Math.round(cellsAt(previousPitch))} 格`)
  console.log(`  1000×1000 大板    ${report(huge)}`)
  console.log(`  100×2000 细长板   ${report(slender)}`)
  console.log('verify:manufacturing-budget OK')
} finally {
  await server.close()
}
