import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const file = process.argv[2] ?? path.join(process.cwd(), '已保存项目', '长亮.snapboard')
const workspace = JSON.parse(readFileSync(file, 'utf8')).workspace
const saved = workspace.splitResult
assert.ok(saved?.sources.length === 1, '此核验器针对单一来源分板工程')
const source = saved.sources[0]
const sketch = workspace.project.parts.flatMap(part => part.features)
  .filter(feature => feature.type === 'sketch')
  .find(feature => feature.contours.some(contour => contour.id === source.contourId))
assert.ok(sketch, '找不到保存分板对应的草图')

const server = await createServer({
  root: process.cwd(), appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
})
try {
  const { prepareSplitGeometry, useAppStore } = await server.ssrLoadModule('/src/store/useAppStore.ts')
  const { splitOrthogonalPolygon } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const prepared = prepareSplitGeometry(sketch.contours, workspace.project.config.pixelToMM,
    { selectedContourId: source.contourId, idPrefix: 'project-check' })
  const target = prepared.targets.find(item => item.sourceIds.includes(source.contourId))
  assert.ok(target, '草图无法还原为原分板轮廓')
  const start = performance.now()
  const generated = splitOrthogonalPolygon({
    points: target.points, holes: prepared.holes, cornerPolicy: target.cornerPolicy,
  }, workspace.splitConfig)
  const elapsedMs = Math.round(performance.now() - start)

  const geometry = panels => panels.map(panel => ({
    bbox: [panel.x, panel.y, panel.w, panel.h],
    contour: panel.contour,
    slots: panel.slots.map(hole => [hole.x, hole.y]),
    candidates: panel.edge_holes.map(hole => [hole.x, hole.y]),
    defaultOpen: panel.edge_holes.filter(hole => hole.knocked && !hole.manual).map(hole => [hole.x, hole.y]),
    cutouts: panel.cutouts ?? [],
  }))
  const actualGeometry = geometry(generated.panels)
  const savedGeometry = geometry(saved.panels)
  for (let index = 0; index < savedGeometry.length; index++) {
    for (const key of ['bbox', 'contour', 'slots', 'candidates', 'cutouts']) {
      assert.equal(JSON.stringify(actualGeometry[index]?.[key]), JSON.stringify(savedGeometry[index][key]),
        `当前分板会改变已保存工程的板形或孔位：板 ${index + 1} 的 ${key}`)
    }
  }
  const holeKey = hole => `${hole.x.toFixed(3)},${hole.y.toFixed(3)}`
  const savedDefaults = new Set(saved.panels.flatMap(panel => panel.edge_holes.filter(hole => hole.knocked && !hole.manual)).map(holeKey))
  const savedOpen = new Set(saved.panels.flatMap(panel => panel.edge_holes.filter(hole => hole.knocked)).map(holeKey))
  const manualOpen = new Set(saved.panels.flatMap(panel => panel.edge_holes.filter(hole => hole.manual && hole.knocked)).map(holeKey))
  const manualClosed = new Set(saved.panels.flatMap(panel => panel.edge_holes.filter(hole => hole.manual && !hole.knocked)).map(holeKey))
  const currentDefaults = new Set(generated.panels.flatMap(panel => panel.edge_holes.filter(hole => hole.knocked)).map(holeKey))
  const candidateKeys = new Set(generated.panels.flatMap(panel => panel.edge_holes).map(holeKey))
  assert.ok([...currentDefaults].every(key => candidateKeys.has(key)), '默认贯通孔必须取自安全候选圆孔')
  const missedManualOpen = [...manualOpen].filter(key => !currentDefaults.has(key))
  const violatedManualClosed = [...manualClosed].filter(key => currentDefaults.has(key))
  const opened = generated.panels.flatMap(panel => panel.edge_holes.filter(hole => hole.knocked))
  for (let first = 0; first < opened.length; first++) for (let second = first + 1; second < opened.length; second++) {
    assert.ok(Math.hypot(opened[first].x - opened[second].x, opened[first].y - opened[second].y) >=
      workspace.splitConfig.jointDiameter + workspace.splitConfig.gapTolerance,
    '默认推荐的圆孔不能实体干涉')
  }
  if (manualOpen.size) {
    assert.ok(missedManualOpen.length <= Math.floor(manualOpen.size / 10), '默认推荐未充分覆盖人工标注开孔')
    assert.deepEqual(violatedManualClosed, [], '默认推荐违反人工标注关孔')
    const junctionOwners = new Map()
    for (const panel of saved.panels) for (const point of panel.contour) {
      const key = holeKey(point)
      if (!junctionOwners.has(key)) junctionOwners.set(key, new Set())
      junctionOwners.get(key).add(panel.id)
    }
    const junctions = [...junctionOwners].filter(([, owners]) => owners.size >= 2)
      .map(([key]) => key.split(',').map(Number))
    for (const key of missedManualOpen) {
      const [x, y] = key.split(',').map(Number)
      assert.ok(junctions.every(([jx, jy]) => Math.hypot(x - jx, y - jy) >= 55),
        `未覆盖的人工开孔必须位于无接缝的外露角：${key}`)
    }
  }

  useAppStore.getState().loadProjectWorkspace(workspace)
  const loaded = useAppStore.getState().splitResult
  const contour = sketch.contours.find(item => item.id === source.contourId)
  const anchor = contour.originAnchorIdx
  const referenceCommand = {
    label: 'reference anchor',
    execute: () => { contour.originAnchorIdx = 0 },
    undo: () => { contour.originAnchorIdx = anchor },
    redo() { this.execute() },
  }
  useAppStore.getState().execute(referenceCommand)
  assert.equal(useAppStore.getState().splitResult, loaded, '非分板几何命令不能覆盖保存孔位状态')
  assert.equal(loaded.panels.reduce((sum, panel) => sum + panel.edge_holes.filter(hole => hole.knocked).length, 0),
    savedOpen.size, '保存工程贯通状态应保持原样')
  const manualStates = new Map(saved.panels.flatMap(panel => panel.edge_holes
    .filter(hole => hole.manual).map(hole => [holeKey(hole), !!hole.knocked])))
  const assertManualStates = result => {
    const holes = new Map(result.panels.flatMap(panel => panel.edge_holes.map(hole => [holeKey(hole), hole])))
    for (const [key, state] of manualStates) {
      const hole = holes.get(key)
      assert.ok(hole?.manual, `重算丢失手动孔状态：${key}`)
      assert.equal(!!hole.knocked, state, `重算覆盖手动开/关孔：${key}`)
    }
  }
  await useAppStore.getState().runAutoSplit({ regenerate: true })
  const regenerated = useAppStore.getState().splitResult
  assertManualStates(regenerated)

  const pending = useAppStore.getState().runAutoSplit({ regenerate: true })
  const panelToToggle = useAppStore.getState().splitResult.panels.find(panel =>
    panel.edge_holes.some(hole => !hole.manual))
  const holeToToggle = panelToToggle.edge_holes.find(hole => !hole.manual)
  const expectedToggle = !holeToToggle.knocked
  useAppStore.getState().toggleEdgeHole(panelToToggle.id, panelToToggle.x, panelToToggle.y,
    holeToToggle.x, holeToToggle.y)
  manualStates.set(holeKey(holeToToggle), expectedToggle)
  await pending
  assertManualStates(useAppStore.getState().splitResult)

  const previousResult = useAppStore.getState().splitResult
  const previousName = contour.name
  useAppStore.getState().execute({
    label: 'rename source',
    execute: () => { contour.name = `${previousName} updated` },
    undo: () => { contour.name = previousName },
    redo: () => { contour.name = `${previousName} updated` },
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && (useAppStore.getState().splitJob || useAppStore.getState().splitResult === previousResult)) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.notEqual(useAppStore.getState().splitResult, previousResult, '来源名称命令应同步分板标签')
  assertManualStates(useAppStore.getState().splitResult)
  const count = (panels, pick) => panels.reduce((sum, panel) => sum + pick(panel).length, 0)
  console.log(JSON.stringify({
    project: workspace.project.metadata.name,
    panels: generated.panels.length,
    longSlots: count(generated.panels, panel => panel.slots),
    edgeCandidates: count(generated.panels, panel => panel.edge_holes),
    defaultOpen: count(generated.panels, panel => panel.edge_holes.filter(hole => hole.knocked)),
    savedDefaultOpen: savedDefaults.size,
    removedDefaults: [...savedDefaults].filter(key => !currentDefaults.has(key)),
    addedDefaults: [...currentDefaults].filter(key => !savedDefaults.has(key)),
    manualOpen: manualOpen.size,
    manualClosed: manualClosed.size,
    missedManualOpen,
    violatedManualClosed,
    elapsedMs,
    savedPanelAndCandidateGeometryUnchanged: true,
    loadedProjectDefaultStatePreserved: true,
    manualStatesPreservedAcrossExplicitAndSourceRename: true,
    midJobManualTogglePreserved: true,
  }, null, 2))
} finally {
  await server.close()
}
