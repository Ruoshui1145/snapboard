import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'
import { mkdir, writeFile } from 'node:fs/promises'

const server = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false },
  plugins: [{ name: 'hole-editor-isolate-solver', enforce: 'pre',
    resolveId(source, importer) { if (source === '../engine/solveState' && importer?.endsWith('/src/store/useAppStore.ts')) return '\0hole-editor-solver' },
    load(id) { if (id === '\0hole-editor-solver') return 'export async function computeContourState() { return "under" }' } }] })
try {
  const { changePanelHole, panelHoleEntries, holeCoordinateKey, applySpatialHoleTypes, originalPanelHoles } = await server.ssrLoadModule('/src/utils/holeEditing.ts')
  const { splitOrthogonalPolygon, PEGBOARD_DEFAULT_CONFIG } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const { createSplitPanelShape } = await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const { splitPanelTargets } = await server.ssrLoadModule('/src/utils/assemblySnap.ts')
  const { useAppStore } = await server.ssrLoadModule('/src/store/useAppStore.ts')
  const { projectWorkspaceFromState, serializeProjectFile, parseProjectFile } = await server.ssrLoadModule('/src/utils/projectFile.ts')
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG }
  const points = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 120 }, { x: 0, y: 120 }]
  const base = splitOrthogonalPolygon({ points }, cfg).panels[0]
  const untouched = JSON.stringify(base), slot = base.slots[0]
  const beforeCount = createSplitPanelShape(base, cfg).holes.length
  const circle = changePanelHole(base, slot.x, slot.y, 'round', cfg)
  assert.equal(circle.slots.length, base.slots.length - 1)
  assert.ok(circle.round_holes.some(hole => hole.x === slot.x && hole.y === slot.y))
  const closed = changePanelHole(circle, slot.x, slot.y, 'closed', cfg)
  assert.equal(createSplitPanelShape(closed, cfg).holes.length, beforeCount - 1, '关闭孔必须实际填实制造截面')
  assert.deepEqual(changePanelHole(closed, slot.x, slot.y, 'restore', cfg), base, '恢复须返回原数组、孔心与状态')
  assert.equal(JSON.stringify(base), untouched, '不得改原始分板器输出')
  const other = base.slots[1]
  const twoClosed = changePanelHole(closed, other.x, other.y, 'closed', cfg)
  assert.deepEqual(changePanelHole(changePanelHole(twoClosed, slot.x, slot.y, 'restore', cfg), other.x, other.y, 'restore', cfg), base,
    '连续编辑多孔后恢复，原孔序号也必须一致')
  const backToSlot = changePanelHole(circle, slot.x, slot.y, 'slot', cfg)
  const mixed = changePanelHole(backToSlot, other.x, other.y, 'closed', cfg)
  assert.deepEqual(originalPanelHoles(changePanelHole(mixed, other.x, other.y, 'restore', cfg)), base,
    '孔型变回原类型后再恢复另一孔，原锚点顺序也必须一致')
  const { createManufacturing3MF } = await server.ssrLoadModule('/src/utils/export3mf.ts')
  const volume = data => {
    const xml = strFromU8(unzipSync(data)['3D/Objects/object_1.model'])
    const vertices = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\s*\/>/g)].map(match => match.slice(1).map(Number))
    let signed = 0
    for (const triangle of xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
      const [a, b, c] = triangle.slice(1).map(index => vertices[Number(index)])
      signed += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    }
    assert.ok(vertices.length > 100, '必须核验真实3MF顶点')
    return Math.abs(signed / 6)
  }
  const baselineFile = await createManufacturing3MF({ panels: [base], cfg, placedParts: [] })
  const closedFile = await createManufacturing3MF({ panels: [closed], cfg, placedParts: [] })
  assert.ok(volume(closedFile.data) > volume(baselineFile.data) + 200, '关闭长孔后的真实3MF应增加填孔体积')
  await mkdir('../output/hole-editing', { recursive: true })
  await writeFile('../output/hole-editing/closed-hole.3mf', closedFile.data)
  const remaining = new Map(splitPanelTargets([closed], cfg).map(target => [`${target.kind}:${target.x}:${target.y}`, target.id]))
  for (const target of splitPanelTargets([base], cfg)) if (remaining.has(`${target.kind}:${target.x}:${target.y}`)) {
    assert.equal(remaining.get(`${target.kind}:${target.x}:${target.y}`), target.id, '编辑一孔不得改其他配件锚点ID')
  }
  const tooNear = { ...base, edge_holes: [...base.edge_holes, { x: 50, y: 5 }] }
  assert.throws(() => changePanelHole(tooNear, 50, 5, 'slot', cfg), /板边|圆角|开孔/)
  const contour = { id: 'outer', name: 'test', type: 'outer', closed: true, constraints: [],
    points: points.map(p => ({ x: p.x, y: -p.y })) }
  const initial = useAppStore.getState()
  useAppStore.setState({ project: { ...initial.project, config: { ...initial.project.config, pixelToMM: 1 },
    parts: [{ id: 'part', name: 'part', material: { name: 'PETG', thickness: 5 }, features: [{ id: 'sketch', name: 'sketch', type: 'sketch', plane: 'xy', contours: [contour] }] }] },
    ui: { ...initial.ui, activeSketchId: 'sketch' }, splitResult: null, splitConfig: cfg, undoStack: [], redoStack: [] })
  await useAppStore.getState().runAutoSplit()
  const result = useAppStore.getState().splitResult, panel = result.panels[0], target = panel.slots[0]
  useAppStore.getState().selectHole({ panel, x: target.x, y: target.y })
  useAppStore.getState().editSelectedHole('closed')
  assert.ok(useAppStore.getState().splitResult.panels[0].closed_holes.length)
  useAppStore.getState().undo(); assert.equal(useAppStore.getState().splitResult, result)
  useAppStore.getState().redo()
  await useAppStore.getState().runAutoSplit({ regenerate: true })
  assert.ok(useAppStore.getState().splitResult.panels[0].closed_holes.some(hole => hole.x === target.x && hole.y === target.y), '重生成应保留单孔编辑')
  const reopened = parseProjectFile(serializeProjectFile(projectWorkspaceFromState(useAppStore.getState()))).workspace
  assert.deepEqual(reopened.splitResult.panels[0].closed_holes, useAppStore.getState().splitResult.panels[0].closed_holes)
  assert.equal('holeEditMode' in reopened, false, '编辑面板属于会话，不写入工程')

  const { DEFAULT_SPATIAL_LAYOUT } = await server.ssrLoadModule('/src/utils/spatialLayout.ts')
  const { resolveSpatialManufacturing } = await server.ssrLoadModule('/src/utils/spatialManufacturingPlan.ts')
  const { createSpatialPanels, splitSpatialHeight } = await server.ssrLoadModule('/src/utils/spatialPanels.ts')
  const { createOnePieceSolid, splitSolidForPrint } = await server.ssrLoadModule('/src/utils/spatialSolid.ts')
  const design = { ...DEFAULT_SPATIAL_LAYOUT, enabled: true, width: 110, depth: 70, height: 160 }
  const plan = resolveSpatialManufacturing(design, cfg)
  const pieces = await createSpatialPanels(plan.layout, cfg, plan.mode, false, undefined, undefined, design)
  const piece = pieces[0], spatialSlot = piece.panel.slots[0]
  const key = holeCoordinateKey(piece.face.phaseU + spatialSlot.x, spatialSlot.y)
  const baseSolid = await createOnePieceSolid(plan.layout, pieces, cfg, design)
  const baseVolume = baseSolid.solid.volume(); baseSolid.solid.delete()
  const candidate = piece.panel.edge_holes.find(hole => hole.x === 90 && hole.y === 130)
  assert.ok(candidate)
  const slotDesign = { ...design, holeTypeOverrides: { [holeCoordinateKey(piece.face.phaseU + candidate.x, candidate.y)]: 'slot' } }
  const slotPieces = await createSpatialPanels(plan.layout, cfg, plan.mode, false, undefined, undefined, slotDesign)
  const duplicated = { ...slotPieces[0].panel, edge_holes: [...slotPieces[0].panel.edge_holes, candidate] }
  assert.equal(panelHoleEntries(applySpatialHoleTypes(duplicated, piece.face.phaseU, 0, slotDesign.holeTypeOverrides, cfg))
    .filter(item => item.hole.x === candidate.x && item.hole.y === candidate.y).length, 1, '打印切分再生成候选后不可叠加旧圆孔')
  const slotted = await createOnePieceSolid(plan.layout, slotPieces, cfg, slotDesign)
  try {
    const print = splitSolidForPrint(slotted.solid, cfg, slotDesign, slotted.wasm, slotPieces)
    try {
      assert.ok(print[0].solid.volume() < baseVolume - 200, '圆孔候选转长孔必须实际减材')
      assert.equal(panelHoleEntries(print[0].faces[0].panel).filter(item => item.hole.x === candidate.x && item.hole.y === candidate.y).length, 1)
    } finally { print.forEach(part => part.solid.delete()) }
  } finally { slotted.solid.delete() }
  for (const mode of ['round', 'closed']) {
    const edited = { ...design, holeTypeOverrides: { [key]: mode } }
    const editedPieces = await createSpatialPanels(plan.layout, cfg, plan.mode, false, undefined, undefined, edited)
    assert.equal(panelHoleEntries(editedPieces[0].panel).find(item => item.hole.x === spatialSlot.x && item.hole.y === spatialSlot.y).mode, mode)
    const solid = await createOnePieceSolid(plan.layout, editedPieces, cfg, edited)
    try {
      assert.ok(solid.solid.volume() > baseVolume + 10, `${mode}必须实际增加原长孔处的材料，不能只改提示线`)
      const print = splitSolidForPrint(solid.solid, cfg, edited, solid.wasm, editedPieces)
      try { assert.equal(print.length, 1); assert.equal(print[0].solid.status(), 'NoError') }
      finally { print.forEach(part => part.solid.delete()) }
    } finally { solid.solid.delete() }
  }
  const tall = { ...design, height: 400, holeTypeOverrides: { [holeCoordinateKey(piece.face.phaseU + spatialSlot.x, 230)]: 'closed' } }
  const tallPlan = resolveSpatialManufacturing(tall, cfg)
  const tallPieces = await createSpatialPanels(tallPlan.layout, cfg, tallPlan.mode, false, undefined, undefined, tall)
  const sections = splitSpatialHeight(tallPlan.layout, tallPieces, 200, cfg)
  assert.ok(sections.length > 1)
  assert.ok(sections.some(section => section.panels.some(({ panel }) => panel.closed_holes?.some(hole => hole.y + section.offsetY === 230))), '分节后仍使用原高度坐标')
  console.log('PASS: 单孔类型/关闭/恢复，制造截面，安全距，撤销重做，重生成/工程恢复，L型实心布尔与分节坐标')
} finally { await server.close() }
