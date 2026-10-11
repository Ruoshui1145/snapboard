import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { createSpatialLayout, faceAxes, faceToWorld, worldToFace, DEFAULT_SPATIAL_LAYOUT, alignSpatialConnectionEdges } = await server.ssrLoadModule('/src/utils/spatialLayout.ts')
  const { resolveSpatialManufacturing } = await server.ssrLoadModule('/src/utils/spatialManufacturingPlan.ts')
  const { createBentFootprint } = await server.ssrLoadModule('/src/utils/spatialBend.ts')
  const { createSpatialPanels, spatialConnectorMountsOpen, spatialHoleKey, splitSpatialHeight } = await server.ssrLoadModule('/src/utils/spatialPanels.ts')
  const { createOnePieceSolid, manifoldToPrinterMesh, spatialManifold, splitSolidForPrint } = await server.ssrLoadModule('/src/utils/spatialSolid.ts')
  const { createPrintedAngleConnector } = await server.ssrLoadModule('/src/utils/spatialConnector.ts')
  const { writeSpatial3MF } = await server.ssrLoadModule('/src/utils/spatial3mf.ts')
  const { createSpatialManufacturing3MF } = await server.ssrLoadModule('/src/utils/spatialManufacturing.ts')
  const { createDefaultAssemblyMarking } = await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
  const { normalizeSpatialLayout, serializeProjectFile, parseProjectFile } = await server.ssrLoadModule('/src/utils/projectFile.ts')
  const { useAppStore } = await server.ssrLoadModule('/src/store/useAppStore.ts')
  const { PEGBOARD_DEFAULT_CONFIG } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const config = { ...DEFAULT_SPATIAL_LAYOUT, enabled: true, template: 'U', width: 120, depth: 80, height: 160 }
  assert.equal(normalizeSpatialLayout(undefined).enabled, false, '旧工程默认仍是平面模式')
  assert.equal(normalizeSpatialLayout({ manufacturingMode: 'auto' }).manufacturingMode, 'monolithic')
  useAppStore.getState().setSpatialLayout({ enabled: true, angleDegrees: 120 })
  assert.equal(useAppStore.getState().spatialLayout.angleDegrees, 120)
  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().spatialLayout.enabled, false)
  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().spatialLayout.angleDegrees, 120)
  const ordinary = resolveSpatialManufacturing(config, PEGBOARD_DEFAULT_CONFIG)
  assert.equal(ordinary.mode, 'monolithic')
  assert.equal(ordinary.printBounds.width, 246)
  assert.equal(ordinary.printHeight, 251)
  const bend = createBentFootprint(ordinary.layout, config)
  assert.ok(bend.polygons[0].length > 30, '一体转角必须包含可见圆弧段')
  assert.ok(bend.trims.every(trim => trim > 10), 'R8 的内圆角应从两侧直板退让')
  const full = await createSpatialPanels(ordinary.layout, PEGBOARD_DEFAULT_CONFIG, 'per-face', true)
  assert.equal(full.length, 3)
  assert.ok(full.every(item => item.panel.slots.length > 0))
  assert.ok(full.every(item => item.panel.edge_holes.some(hole => hole.knocked)))
  assert.ok(spatialConnectorMountsOpen(ordinary.layout, full))
  for (const { face, panel } of full) for (const slot of panel.slots) {
    const unfoldedX = face.phaseU + slot.x
    const column = Math.round((unfoldedX - PEGBOARD_DEFAULT_CONFIG.slotGridX0) / PEGBOARD_DEFAULT_CONFIG.slotStaggerX)
    assert.ok(Math.abs(unfoldedX - PEGBOARD_DEFAULT_CONFIG.slotGridX0 - column * PEGBOARD_DEFAULT_CONFIG.slotStaggerX) < 1e-6)
    const rowBase = PEGBOARD_DEFAULT_CONFIG.slotGridY0 - (column % 2 ? PEGBOARD_DEFAULT_CONFIG.slotStaggerY : 0)
    assert.ok(Math.abs((slot.y - rowBase) / (PEGBOARD_DEFAULT_CONFIG.my * 2) -
      Math.round((slot.y - rowBase) / (PEGBOARD_DEFAULT_CONFIG.my * 2))) < 1e-6,
    '折叠前后长孔须沿同一母阵相位对齐')
  }
  assert.deepEqual([...new Set(full[0].panel.edge_holes.filter(hole => hole.knocked).map(hole => hole.y))],
    [...new Set(full[1].panel.edge_holes.filter(hole => hole.knocked).map(hole => hole.y))],
    '折叠前同高的连接圆孔，折叠后仍应对齐')
  const solidPanels = await createSpatialPanels(ordinary.layout, PEGBOARD_DEFAULT_CONFIG, 'monolithic')
  assert.ok(solidPanels.every(item => item.panel.edge_holes.every(hole => !hole.knocked)))
  const candidate = solidPanels[0].panel.edge_holes[0]
  const holeKey = spatialHoleKey(solidPanels[0].face.phaseU + candidate.x, candidate.y)
  const holeDesign = { ...config, holeOverrides: { [holeKey]: true } }
  const openedPanels = await createSpatialPanels(ordinary.layout, PEGBOARD_DEFAULT_CONFIG,
    'monolithic', false, undefined, undefined, holeDesign)
  assert.ok(openedPanels[0].panel.edge_holes[0].knocked)
  assert.equal(normalizeSpatialLayout(holeDesign).holeOverrides[holeKey], true)
  const { solid } = await createOnePieceSolid(ordinary.layout, solidPanels, PEGBOARD_DEFAULT_CONFIG, config)
  try {
    assert.equal(solid.decompose().length, 1)
    const opened = await createOnePieceSolid(ordinary.layout, openedPanels, PEGBOARD_DEFAULT_CONFIG, holeDesign)
    assert.ok(solid.volume() - opened.solid.volume() > 90, '手动开启的圆孔必须进入一体 3MF 实体')
    opened.solid.delete()
    const wasm = await spatialManifold()
    for (const y of [30, 110]) {
      const section = new wasm.CrossSection([[[49, y - 1], [51, y - 1], [51, y + 1], [49, y + 1]]])
      const probe = section.extrude(20, 0, 0, [1, 1], true)
      section.delete()
      const overlap = solid.intersect(probe)
      assert.ok(overlap.volume() < 0.01, `一体板在 y=${y} mm 的长孔未贯穿板厚`)
      overlap.delete(); probe.delete()
    }
    const mesh = manifoldToPrinterMesh(solid, ordinary.printCfg, 'U-one-piece')
    for (let index = 0; index < mesh.vertices.length; index += 3) {
      assert.ok(mesh.vertices[index] >= 5 - 1e-5 && mesh.vertices[index] <= 251 + 1e-5)
      assert.ok(mesh.vertices[index + 1] >= 5 - 1e-5 && mesh.vertices[index + 1] <= 251 + 1e-5)
      assert.ok(mesh.vertices[index + 2] >= -1e-5 && mesh.vertices[index + 2] <= 251 + 1e-5)
    }
    const zip = unzipSync(writeSpatial3MF([mesh], 'U-test'))
    const xml = strFromU8(zip['3D/3dmodel.model'])
    assert.match(xml, /unit="millimeter"/)
    assert.match(xml, /<triangle /)
  } finally { solid.delete() }

  const smallBed = { ...PEGBOARD_DEFAULT_CONFIG, printerPreset: 'custom', bedW: 100, bedH: 100,
    bedKeepouts: [], minW: 40, minH: 40, minFeatureWidth: 40 }
  const oversized = resolveSpatialManufacturing(config, smallBed)
  assert.equal(oversized.mode, 'monolithic', '超床切分应保留折弯实体路线')
  assert.equal(oversized.error, null)
  assert.equal(oversized.needsBedSplit, true)
  const splitDesign = { ...config, manufacturingMode: 'bed-split' }
  const planned = resolveSpatialManufacturing(splitDesign, smallBed)
  assert.equal(planned.mode, 'bed-split')
  const pieces = await createSpatialPanels(planned.layout, smallBed, planned.mode, true)
  assert.ok(pieces.length > 3, '小热床必须将 U 型的侧面继续拆成更多板件')
  assert.ok(spatialConnectorMountsOpen(planned.layout, pieces), '角连接件固定孔应在所有面片保留')

  const angled = createSpatialLayout({ template: 'L', width: 120, depth: 80, height: 160, thickness: 5, angleDegrees: 120 })
  assert.ok(Math.abs(angled.junctions[0].angleDegrees - 120) < 1e-8)
  const wasm = await spatialManifold()
  for (const angle of [45, 53, 90, 120, 150]) {
    const connector = createPrintedAngleConnector(wasm, angle)
    try {
      assert.ok(connector.volume() > 0 && connector.decompose().length === 1)
      const model = manifoldToPrinterMesh(connector, smallBed, `M3-${angle}`)
      assert.ok(unzipSync(writeSpatial3MF([model], `M3-${angle}`))['3D/3dmodel.model'])
    } finally { connector.delete() }
  }
  for (const angleDegrees of [45, 90, 120, 150]) {
    const layout = createSpatialLayout({ template: 'L', width: 120, depth: 80,
      height: 160, thickness: 5, angleDegrees })
    const [from, to] = layout.faces
    const outside = 5
    const shift = outside * Math.tan((180 - angleDegrees) * Math.PI / 360)
    const mountDistance = 20 + shift
    const root = faceToWorld(from, from.width + shift, 10, outside)
    const actualA = root.map((value, index) => value - from.u[index] * mountDistance + (index === 1 ? 15 : 0))
    const actualB = root.map((value, index) => value + to.u[index] * mountDistance + (index === 1 ? 15 : 0))
    const targetA = faceToWorld(from, from.width - 20, 25, outside)
    const targetB = faceToWorld(to, 20, 25, outside)
    assert.ok(Math.hypot(...actualA.map((value, index) => value - targetA[index])) < 1e-7)
    assert.ok(Math.hypot(...actualB.map((value, index) => value - targetB[index])) < 1e-7)
  }
  const boardWithMounts = await createOnePieceSolid(ordinary.layout, full, PEGBOARD_DEFAULT_CONFIG, config)
  const firstJoint = ordinary.layout.junctions[0]
  const fromFace = ordinary.layout.faces.find(face => face.id === firstJoint.from)
  const bracket = createPrintedAngleConnector(wasm, firstJoint.angleDegrees, PEGBOARD_DEFAULT_CONFIG.thickness)
  const turnedBracket = bracket.rotate(0, -Math.atan2(fromFace.u[2], fromFace.u[0]) * 180 / Math.PI, 0)
  const offset = (PEGBOARD_DEFAULT_CONFIG.thickness + 5) / 2
  const shift = offset * Math.tan((180 - firstJoint.angleDegrees) * Math.PI / 360)
  const placedBracket = turnedBracket.translate(faceToWorld(fromFace, fromFace.width + shift, 10, offset))
  const overlap = boardWithMounts.solid.intersect(placedBracket)
  assert.ok(overlap.volume() < 0.01, `连接件与板件发生实体干涉：${overlap.volume()} mm³`)
  overlap.delete(); placedBracket.delete(); turnedBracket.delete(); bracket.delete(); boardWithMounts.solid.delete()
  const produced = await createSpatialManufacturing3MF({ layout: splitDesign, cfg: smallBed,
    projectName: 'U-small-bed', assemblyMarking: createDefaultAssemblyMarking() })
  const packageFiles = unzipSync(produced.data)
  const assemblyMap = JSON.parse(strFromU8(packageFiles['立体装配数据.json']))
  assert.equal(assemblyMap.faces.length, 3)
  assert.ok(assemblyMap.faces.reduce((sum, face) => sum + face.panelIds.length, 0) > 3)
  assert.ok(Object.keys(packageFiles).filter(name => name.startsWith('连接件/')).length === 4)
  assert.match(strFromU8(packageFiles['立体装配俯视图.svg']), /<svg[^>]+>/)
  assert.ok(packageFiles['U-small-bed-平放板件.3mf'])
  const mount = full[0].panel.edge_holes.find(hole => hole.y === 25 && hole.knocked)
  const disabledMount = { ...splitDesign, holeOverrides: {
    [spatialHoleKey(full[0].face.phaseU + mount.x, mount.y)]: false,
  } }
  const disabledPieces = await createSpatialPanels(planned.layout, planned.printCfg, planned.mode,
    true, undefined, undefined, disabledMount)
  assert.equal(spatialConnectorMountsOpen(planned.layout, disabledPieces), false)
  const withoutBracket = await createSpatialManufacturing3MF({ layout: disabledMount, cfg: smallBed,
    projectName: 'U-no-mount', assemblyMarking: createDefaultAssemblyMarking() })
  assert.ok(!Object.keys(unzipSync(withoutBracket.data)).some(file => file.startsWith('连接件/')))
  const onePiece = await createSpatialManufacturing3MF({
    layout: { ...config, template: 'L', angleDegrees: 120, manufacturingMode: 'monolithic' },
    cfg: PEGBOARD_DEFAULT_CONFIG, projectName: 'L-120', assemblyMarking: createDefaultAssemblyMarking(),
  })
  assert.match(onePiece.fileName, /一体\.3mf$/)
  assert.ok(unzipSync(onePiece.data)['3D/3dmodel.model'])
  const chamfered = await createSpatialManufacturing3MF({
    layout: { ...config, template: 'L', angleDegrees: 120, bendStyle: 'chamfer', manufacturingMode: 'monolithic' },
    cfg: PEGBOARD_DEFAULT_CONFIG, projectName: 'L-chamfer', assemblyMarking: createDefaultAssemblyMarking(),
  })
  assert.ok(unzipSync(chamfered.data)['3D/3dmodel.model'])
  const prismDesign = { ...config, template: 'prism', width: 120, depth: 80, height: 160 }
  for (const bendSizeMm of [4, 8]) {
    const design = { ...prismDesign, bendSizeMm }
    const plan = resolveSpatialManufacturing(design, PEGBOARD_DEFAULT_CONFIG)
    assert.equal(plan.error, null)
    const bend = createBentFootprint(plan.layout, design)
    assert.equal(bend.polygons.length, 2, '三棱柱必须保留外轮廓和中空内轮廓')
    assert.equal(bend.trims.length, 3, '第三个闭合转角也必须圆润过渡')
    const panels = await createSpatialPanels(plan.layout, plan.printCfg, 'monolithic',
      false, undefined, undefined, design)
    for (const [index, { face, panel }] of panels.entries()) {
      assert.ok(panel.slots.length, '每个直面应保留功能长孔')
      const start = bend.trims[(index + 2) % 3], end = face.width - bend.trims[index]
      assert.ok(panel.slots.every(hole => hole.x >= start + PEGBOARD_DEFAULT_CONFIG.slotWidth / 2 &&
        hole.x <= end - PEGBOARD_DEFAULT_CONFIG.slotWidth / 2), '长孔不能切入任一圆角，包括闭合转角')
      assert.ok(panel.edge_holes.every(hole => hole.x >= start + PEGBOARD_DEFAULT_CONFIG.jointDiameter / 2 &&
        hole.x <= end - PEGBOARD_DEFAULT_CONFIG.jointDiameter / 2), '候选圆孔不能切入圆角')
    }
    const { solid } = await createOnePieceSolid(plan.layout, panels, plan.printCfg, design)
    try {
      assert.equal(solid.status(), 'NoError')
      const components = solid.decompose()
      assert.equal(components.length, 1, '圆角三棱柱应为一个连续闭合实体')
      components.forEach(part => part.delete())
      for (const [index, junction] of plan.layout.junctions.entries()) {
        const from = plan.layout.faces.find(face => face.id === junction.from)
        const to = plan.layout.faces.find(face => face.id === junction.to)
        const radius = bendSizeMm + plan.layout.thickness / 2
        const start = faceToWorld(from, from.width - bend.trims[index], 80)
        const center = [start[0] + from.u[2] * radius, 80, start[2] - from.u[0] * radius]
        const angle = Math.atan2(start[2] - center[2], start[0] - center[0]) -
          (180 - junction.angleDegrees) * Math.PI / 360
        const radial = [Math.cos(angle), 0, Math.sin(angle)]
        const point = center.map((value, axis) => value + radial[axis] * radius)
        const hits = solid.rayCast(point.map((value, axis) => value - radial[axis] * 5),
          point.map((value, axis) => value + radial[axis] * 5))
        assert.equal(hits.length, 2, `转角 ${index + 1} 缺少实际圆弧实体`)
        assert.ok(Math.abs(Math.hypot(...hits[1].position.map((value, axis) => value - hits[0].position[axis])) -
          plan.layout.thickness) < 0.1, '圆弧转角应保持板厚')
        assert.equal(solid.rayCast([to.origin[0], 20, to.origin[2]],
          [to.origin[0], 140, to.origin[2]]).length, 0, '尖角处不能残留融合直板的凸出接头')
      }
      assert.equal(solid.rayCast([60, -1, -80 / 3], [60, 161, -80 / 3]).length, 0,
        '倒角挤出不得把三棱柱的中空区域封成实体')
    } finally { solid.delete() }
  }
  const prismFile = await createSpatialManufacturing3MF({ layout: prismDesign, cfg: PEGBOARD_DEFAULT_CONFIG,
    projectName: 'prism-round', assemblyMarking: createDefaultAssemblyMarking() })
  assert.match(prismFile.fileName, /一体\.3mf$/)
  assert.equal(prismFile.panelCount, 1)
  assert.ok(resolveSpatialManufacturing({ ...prismDesign, width: 60, depth: 60, bendSizeMm: 80 },
    PEGBOARD_DEFAULT_CONFIG).error?.includes('转角尺寸过大'))
  const largePrism = await createSpatialManufacturing3MF({ layout: { ...prismDesign, width: 360, depth: 280, height: 500 },
    cfg: PEGBOARD_DEFAULT_CONFIG, projectName: 'prism-XYZ', assemblyMarking: createDefaultAssemblyMarking() })
  const prismFiles = unzipSync(largePrism.data)
  const prismMap = JSON.parse(strFromU8(prismFiles['立体制造分件.json']))
  assert.ok(prismMap.parts.length > 3, '三棱柱横向和高度超限时必须同时切分')
  assert.equal(prismMap.parts.length, largePrism.panelCount)
  for (const part of prismMap.parts) {
    const xml = strFromU8(unzipSync(prismFiles[part.file])['3D/3dmodel.model'])
    assert.equal([...xml.matchAll(/<object /g)].length, 1)
    for (const vertex of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
      const [x, y, z] = vertex.slice(1).map(Number)
      assert.ok(x >= 5 - 1e-4 && x <= 251 + 1e-4 && y >= 5 - 1e-4 && y <= 251 + 1e-4 &&
        z >= -1e-4 && z <= 251 + 1e-4, '三棱柱分件必须完整位于打印安全空间')
    }
  }
  console.log(`三棱柱：3 个恒厚圆角、中空实体、圆角孔避让通过；360×280×500 mm 按安全空间导出 ${largePrism.panelCount} 件`)
  assert.equal(normalizeSpatialLayout({ template: 'prism' }).polygonSides, 3, '旧三棱柱工程保持三边形')
  assert.equal(normalizeSpatialLayout({ template: 'prism', polygonSides: 7 }).polygonSides, 7)
  assert.equal(normalizeSpatialLayout({ template: 'prism', polygonSides: 4.5 }).polygonSides, 3)
  assert.throws(() => createSpatialLayout({ ...prismDesign, thickness: 5, polygonSides: 4.5 }), /整数/)
  assert.equal(createSpatialLayout({ ...prismDesign, thickness: 5, polygonSides: 1000000 }).template, 'cylinder',
    '大量细边应进入连续圆筒，不能分配百万个碎面')
  for (const polygonSides of [4, 5, 6, 12]) {
    const design = { ...prismDesign, width: 200, height: 80, polygonSides }
    const plan = resolveSpatialManufacturing(design, PEGBOARD_DEFAULT_CONFIG)
    assert.equal(plan.error, null)
    assert.equal(plan.layout.faces.length, polygonSides)
    assert.equal(plan.layout.junctions.length, polygonSides)
    assert.ok(Math.abs(plan.layout.faces[0].width - plan.layout.faces.at(-1).width) < 1e-6,
      '正多边形的各边应等长')
    const panels = await createSpatialPanels(plan.layout, plan.printCfg, 'monolithic', false,
      undefined, undefined, design)
    const body = await createOnePieceSolid(plan.layout, panels, plan.printCfg, design)
    try {
      assert.equal(body.solid.status(), 'NoError')
      const components = body.solid.decompose()
      assert.equal(components.length, 1)
      components.forEach(part => part.delete())
      manifoldToPrinterMesh(body.solid, plan.printCfg, `${polygonSides}-sides`)
    } finally { body.solid.delete() }
  }
  const cylinder = { ...prismDesign, template: 'cylinder', width: 120, height: 80 }
  assert.equal(normalizeSpatialLayout(cylinder).template, 'cylinder')
  const cylinderPlan = resolveSpatialManufacturing(cylinder, PEGBOARD_DEFAULT_CONFIG)
  assert.equal(cylinderPlan.error, null)
  assert.equal(resolveSpatialManufacturing({ ...cylinder, manufacturingMode: 'bed-split' },
    PEGBOARD_DEFAULT_CONFIG).mode, 'monolithic', '圆筒切分必须保留曲面，不能输出四块直板')
  const cylinderPanels = await createSpatialPanels(cylinderPlan.layout, cylinderPlan.printCfg, 'monolithic',
    false, undefined, undefined, cylinder)
  assert.ok(cylinderPanels.every(item => item.panel.slots.length && item.panel.edge_holes.length))
  const cylinderBody = await createOnePieceSolid(cylinderPlan.layout, cylinderPanels, cylinderPlan.printCfg, cylinder)
  try {
    const components = cylinderBody.solid.decompose()
    assert.equal(components.length, 1)
    components.forEach(part => part.delete())
    for (const { face, panel } of cylinderPanels) {
      const slot = panel.slots.find(hole => hole.x > 10 && hole.x < face.width - 10)
      assert.ok(slot)
      const world = faceToWorld(face, slot.x, slot.y, 0)
      const local = worldToFace(face, world)
      assert.ok(Math.abs(local[0] - slot.x) < 1e-6 && Math.abs(local[1] - slot.y) < 1e-6)
      assert.equal(cylinderBody.solid.rayCast(faceToWorld(face, slot.x, slot.y, -4),
        faceToWorld(face, slot.x, slot.y, 4)).length, 0, '曲面长孔必须沿该列的真实法向贯穿')
      const axes = faceAxes(face, face.width / 2)
      assert.ok(Math.abs(axes.u[0] * axes.normal[0] + axes.u[2] * axes.normal[2]) < 1e-6)
    }
    assert.equal(cylinderBody.solid.rayCast([60, -1, -60], [60, 81, -60]).length, 0, '圆筒必须中空')
    const candidate = cylinderPanels[0].panel.edge_holes[0]
    const key = spatialHoleKey(candidate.x, candidate.y)
    const openedDesign = { ...cylinder, holeOverrides: { [key]: true } }
    const openedPanels = await createSpatialPanels(cylinderPlan.layout, cylinderPlan.printCfg,
      'monolithic', false, undefined, undefined, openedDesign)
    const opened = await createOnePieceSolid(cylinderPlan.layout, openedPanels, cylinderPlan.printCfg, openedDesign)
    try {
      assert.ok(cylinderBody.solid.volume() - opened.solid.volume() > 90, '曲面候选圆孔的手动开关必须改变实体')
      assert.equal(opened.solid.rayCast(faceToWorld(cylinderPanels[0].face, candidate.x, candidate.y, -4),
        faceToWorld(cylinderPanels[0].face, candidate.x, candidate.y, 4)).length, 0)
    } finally { opened.solid.delete() }
  } finally { cylinderBody.solid.delete() }
  const roundFile = await createSpatialManufacturing3MF({ layout: cylinder, cfg: PEGBOARD_DEFAULT_CONFIG,
    projectName: 'round-one-piece', assemblyMarking: createDefaultAssemblyMarking() })
  assert.equal(roundFile.panelCount, 1)
  const roundSplit = await createSpatialManufacturing3MF({ layout: { ...cylinder, width: 300, height: 300 },
    cfg: PEGBOARD_DEFAULT_CONFIG, projectName: 'round-split', assemblyMarking: createDefaultAssemblyMarking() })
  const roundFiles = unzipSync(roundSplit.data)
  const roundMap = JSON.parse(strFromU8(roundFiles['立体制造分件.json']))
  assert.ok(roundMap.parts.length > 2, '圆筒横向及高度超限时也需实际切分')
  for (const part of roundMap.parts) {
    const xml = strFromU8(unzipSync(roundFiles[part.file])['3D/3dmodel.model'])
    for (const vertex of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
      const [x, y, z] = vertex.slice(1).map(Number)
      assert.ok(x >= 5 - 1e-4 && x <= 251 + 1e-4 && y >= 5 - 1e-4 && y <= 251 + 1e-4 &&
        z >= -1e-4 && z <= 251 + 1e-4, '曲面分件应全部处于安全打印空间')
    }
  }
  console.log(`多边形与圆筒：4/5/6/12 边实体、连续曲面长孔/圆孔、旧工程兼容通过；300mm 圆筒导出 ${roundSplit.panelCount} 件`)
  for (const inset of [15, 20]) {
    const short = { ...config, template: 'L', width: 25, depth: 25, height: 80,
      cornerHoleInsetMm: inset, manufacturingMode: 'monolithic' }
    const shortPlan = resolveSpatialManufacturing(short, PEGBOARD_DEFAULT_CONFIG)
    assert.equal(shortPlan.error, null)
    const shortPieces = await createSpatialPanels(shortPlan.layout, shortPlan.printCfg,
      'monolithic', false, undefined, undefined, short)
    for (const { face, panel } of shortPieces) {
      assert.ok(panel.slots.length && panel.edge_holes.length)
      const corner = face.id === shortPlan.layout.faces[0].id ? face.width : 0
      assert.ok(panel.slots.some(slot => Math.abs(slot.x - corner) === inset))
      assert.ok(panel.edge_holes.some(hole => Math.abs(hole.x - corner) === inset))
      assert.ok(panel.edge_holes.some(hole => hole.x === panel.slots[0].x && hole.y === panel.slots[0].y - 20),
        '短角连接件同列圆孔与长孔须上下交替')
    }
  }
  for (const [width, depth, inset] of [[120, 100, 20], [100, 100, 20], [25, 25, 20], [145, 73, 35]]) {
    const design = { ...config, template: 'L', width, depth, height: 200, cornerHoleInsetMm: inset }
    const aligned = alignSpatialConnectionEdges(design, PEGBOARD_DEFAULT_CONFIG)
    assert.equal(aligned.cornerHoleInsetMm, inset, '修齐自由边不得改变用户的转角孔距')
    assert.equal(alignSpatialConnectionEdges(aligned, PEGBOARD_DEFAULT_CONFIG), aligned, '修齐必须幂等')
    const plan = resolveSpatialManufacturing(design, PEGBOARD_DEFAULT_CONFIG)
    for (const mode of ['monolithic', 'bed-split']) {
      const pieces = await createSpatialPanels(plan.layout, plan.printCfg, mode, false, undefined, undefined, design)
      for (const [index, face] of plan.layout.faces.entries()) {
        const facePieces = pieces.filter(piece => piece.face.id === face.id)
        const slots = facePieces.flatMap(piece => piece.panel.slots)
        const circles = facePieces.flatMap(piece => piece.panel.edge_holes)
        const freeEdge = index === 0 ? 0 : face.width
        const bendEdge = index === 0 ? face.width : 0
        for (const [kind, holes] of [['长孔', slots], ['圆孔', circles]]) {
          const freeInset = Math.min(...holes.map(hole => Math.abs(hole.x - freeEdge)))
          assert.ok(Math.abs(freeInset - PEGBOARD_DEFAULT_CONFIG.jointOffsetX) < 1e-6,
            `${width}/${depth}/${inset} ${mode} ${face.id} ${kind}自由拼接边距应为 10mm，实际 ${freeInset}`)
          assert.ok(holes.some(hole => Math.abs(Math.abs(hole.x - bendEdge) - inset) < 1e-6),
            `${kind}的转角孔距必须保持设定值`)
        }
        const edgeColumn = slots.filter(hole => Math.abs(Math.abs(hole.x - freeEdge) - 10) < 1e-6)
        const roundColumn = circles.filter(hole => Math.abs(Math.abs(hole.x - freeEdge) - 10) < 1e-6)
        assert.ok(edgeColumn.length && roundColumn.length)
        assert.ok(roundColumn.every(hole => edgeColumn.some(slot => Math.abs(hole.y - slot.y) === 20)),
          '自由拼接边圆孔与长孔应同列交替，不能单独移动一种孔')
      }
    }
  }
  const bevelDesign = alignSpatialConnectionEdges({ ...config, template: 'L', width: 100, depth: 100,
    height: 80 }, PEGBOARD_DEFAULT_CONFIG)
  const bevelPlan = resolveSpatialManufacturing(bevelDesign, PEGBOARD_DEFAULT_CONFIG)
  let bevelPanels = await createSpatialPanels(bevelPlan.layout, bevelPlan.printCfg,
    'monolithic', false, undefined, undefined, bevelDesign)
  const face = bevelPanels[0].face
  const slot = bevelPanels[0].panel.slots.find(hole => hole.x > 20 && hole.y === 30)
  const circle = bevelPanels[0].panel.edge_holes.find(hole => hole.x === face.width - 20 && hole.y === 50)
  bevelDesign.holeOverrides = { [spatialHoleKey(face.phaseU + circle.x, circle.y)]: true }
  bevelPanels = await createSpatialPanels(bevelPlan.layout, bevelPlan.printCfg,
    'monolithic', false, undefined, undefined, bevelDesign)
  const sharp = await createOnePieceSolid(bevelPlan.layout, bevelPanels,
    { ...bevelPlan.printCfg, manufacturingChamfer: 0 }, bevelDesign)
  const beveled = await createOnePieceSolid(bevelPlan.layout, bevelPanels, bevelPlan.printCfg, bevelDesign)
  try {
    const volumeAt = (solid, coordinates) => {
      const cube = beveled.wasm.Manifold.cube([0.04, 0.04, 0.04], true)
      const placed = cube.translate(faceToWorld(face, ...coordinates))
      const overlap = solid.intersect(placed)
      try { return overlap.volume() } finally { overlap.delete(); placed.delete(); cube.delete() }
    }
    for (const point of [[0.1, 40, 2.4], [45, 79.9, 2.4],
      [slot.x + 2.62, slot.y, 2.42], [circle.x + 2.62, circle.y, 2.42]]) {
      assert.ok(volumeAt(sharp.solid, point) > 0.00006, '未倒角的对照实体应保留原棱边')
      assert.ok(volumeAt(beveled.solid, point) < 1e-8, '自由端、顶边、长孔和圆孔孔口必须真实减材倒角')
    }
    for (const point of [[0.1, 40, 0], [45, 79.9, 0],
      [slot.x + 2.62, slot.y, 0], [circle.x + 2.62, circle.y, 0]]) {
      assert.ok(volumeAt(beveled.solid, point) > 0.00006, '倒角不得移动名义端面或扩大孔的中段截面')
    }
    for (const end of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(sharp.solid.boundingBox()[end][axis] - beveled.solid.boundingBox()[end][axis]) < 1e-4,
        '制造倒角不得外扩尺寸或改变高度')
    }
  } finally { sharp.solid.delete(); beveled.solid.delete() }
  const legacy = { ...config, template: 'L', width: 120, depth: 100, height: 80,
    holeOverrides: { '100000,10000': true, '100000,50000': false, '140000,10000': true } }
  const repaired = normalizeSpatialLayout(legacy)
  assert.equal(repaired.width, 110)
  assert.equal(repaired.depth, 90)
  const legacyPlan = resolveSpatialManufacturing(legacy, PEGBOARD_DEFAULT_CONFIG)
  const migrated = await createSpatialPanels(legacyPlan.layout, legacyPlan.printCfg,
    'monolithic', false, undefined, undefined, legacy)
  assert.ok(migrated[0].panel.edge_holes.some(hole => hole.x === 90 && hole.y === 10 && hole.knocked))
  assert.ok(migrated[0].panel.edge_holes.some(hole => hole.x === 90 && hole.y === 50 && hole.manual && !hole.knocked))
  assert.ok(migrated[1].panel.edge_holes.some(hole => hole.x === 20 && hole.y === 10 && hole.knocked))
  const state = useAppStore.getState()
  const reopened = parseProjectFile(serializeProjectFile({ project: state.project, boards: state.boards,
    placedParts: state.placedParts, splitConfig: state.splitConfig, splitResult: state.splitResult,
    boardTexture: state.boardTexture, assemblyMarking: state.assemblyMarking,
    assemblyScene: state.assemblyScene, spatialLayout: legacy, lastTextureSampling: null }))
  assert.deepEqual(reopened.workspace.spatialLayout, repaired, '旧工程重开也应修齐并保留孔开关')
  for (const design of [{ ...prismDesign, polygonSides: 7 }, { ...cylinder, holeOverrides: { '30000,10000': true } }]) {
    const saved = parseProjectFile(serializeProjectFile({ project: state.project, boards: state.boards,
      placedParts: state.placedParts, splitConfig: state.splitConfig, splitResult: state.splitResult,
      boardTexture: state.boardTexture, assemblyMarking: state.assemblyMarking,
      assemblyScene: state.assemblyScene, spatialLayout: design, lastTextureSampling: null }))
    assert.deepEqual(saved.workspace.spatialLayout, design, '新增边数、圆筒形态及孔开关须随真实工程保存重开')
  }
  useAppStore.getState().setSpatialLayout({ template: 'prism', polygonSides: 7 })
  assert.equal(useAppStore.getState().spatialLayout.polygonSides, 7)
  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().spatialLayout.polygonSides, 3)
  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().spatialLayout.polygonSides, 7)
  const beforeTrim = useAppStore.getState().spatialLayout
  useAppStore.getState().setSpatialLayout({ template: 'L', width: 3000, depth: 100, cornerHoleInsetMm: 20 })
  assert.equal(useAppStore.getState().spatialLayout.width, 2990)
  assert.equal(useAppStore.getState().spatialLayout.depth, 90)
  useAppStore.getState().undo()
  assert.deepEqual(useAppStore.getState().spatialLayout, beforeTrim, '臂长修齐应与参数编辑一起撤销')
  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().spatialLayout.depth, 90)
  const tall = { ...config, template: 'L', width: 25, depth: 25, height: 2000,
    manufacturingMode: 'monolithic' }
  const tallPlan = resolveSpatialManufacturing(tall, PEGBOARD_DEFAULT_CONFIG)
  assert.equal(tallPlan.error, null)
  assert.equal(tallPlan.sectionCount, 9)
  const tallPanels = await createSpatialPanels(tallPlan.layout, tallPlan.printCfg,
    'monolithic', false, undefined, undefined, tall)
  const sections = splitSpatialHeight(tallPlan.layout, tallPanels, tallPlan.printHeight, tallPlan.printCfg)
  assert.equal(sections.length, 9)
  assert.ok(sections.every(section => section.height <= tallPlan.printHeight))
  const originalSlots = new Set(tallPanels.flatMap(({ face, panel }) =>
    panel.slots.map(slot => `${face.id}:${slot.x}:${slot.y}`)))
  assert.equal(sections.reduce((sum, section) => sum + section.panels.reduce((n, piece) => n + piece.panel.slots.length, 0), 0),
    originalSlots.size, '高度切口必须避开孔排，不得靠删除整排长孔形成分节')
  assert.equal(sections.reduce((sum, section) => sum + section.panels.reduce((n, piece) => n + piece.panel.edge_holes.length, 0), 0),
    tallPanels.reduce((sum, piece) => sum + piece.panel.edge_holes.length, 0), '高度切口不得删除原工程的圆孔候选')
  for (const section of sections) for (const { face, panel } of section.panels) for (const slot of panel.slots) {
    assert.ok(originalSlots.has(`${face.id}:${slot.x}:${slot.y + section.offsetY}`),
      '高度分节不得重新计算展开板的孔阵相位')
  }
  const tallExport = await createSpatialManufacturing3MF({ layout: tall,
    cfg: PEGBOARD_DEFAULT_CONFIG, projectName: 'L-tall', assemblyMarking: createDefaultAssemblyMarking() })
  const tallFiles = unzipSync(tallExport.data)
  assert.equal(Object.keys(tallFiles).filter(path => path.startsWith('高度分节/') && path.endsWith('.3mf')).length, 9)
  assert.equal(JSON.parse(strFromU8(tallFiles['立体高度分节.json'])).totalHeightMm, 2000)
  assert.equal(resolveSpatialManufacturing({ ...config, template: 'L', width: 250,
    manufacturingMode: 'monolithic' }, PEGBOARD_DEFAULT_CONFIG).needsBedSplit, true)
  for (const angleDegrees of [45, 150]) {
    const edgeCase = await createSpatialManufacturing3MF({
      layout: { ...config, template: 'L', angleDegrees, cornerHoleInsetMm: 35,
        manufacturingMode: 'monolithic' },
      cfg: PEGBOARD_DEFAULT_CONFIG, projectName: `L-${angleDegrees}`, assemblyMarking: createDefaultAssemblyMarking(),
    })
    assert.ok(unzipSync(edgeCase.data)['3D/3dmodel.model'])
  }
  const smallFold = await createSpatialManufacturing3MF({
    layout: { ...config, manufacturingMode: 'monolithic' }, cfg: smallBed,
    projectName: 'too-large', assemblyMarking: createDefaultAssemblyMarking(),
  })
  assert.ok(smallFold.panelCount > 1, '缩小热床必须把实际折弯实体切成独立对象')
  const conserveDesign = alignSpatialConnectionEdges({ ...config, template: 'L', width: 500, depth: 300,
    height: 80 }, PEGBOARD_DEFAULT_CONFIG)
  const conservePlan = resolveSpatialManufacturing(conserveDesign, { ...PEGBOARD_DEFAULT_CONFIG, manufacturingChamfer: 0 })
  const conservePanels = await createSpatialPanels(conservePlan.layout, conservePlan.printCfg,
    'monolithic', false, undefined, undefined, conserveDesign)
  const source = await createOnePieceSolid(conservePlan.layout, conservePanels, conservePlan.printCfg, conserveDesign)
  try {
    const parts = splitSolidForPrint(source.solid, conservePlan.printCfg, conserveDesign, source.wasm)
    try {
      assert.ok(parts.length > 1)
      assert.ok(Math.abs(parts.reduce((sum, part) => sum + part.solid.volume(), 0) - source.solid.volume()) < 0.01,
        '关闭倒角时切分应完整保留源实体，不丢曲面或材料')
      for (const part of parts) {
        assert.equal(part.solid.status(), 'NoError')
        const components = part.solid.decompose()
        assert.equal(components.length, 1, '制造件不能包含互不连接的隐藏碎片')
        components.forEach(component => component.delete())
        manifoldToPrinterMesh(part.solid, conservePlan.printCfg, 'closed-part')
      }
    } finally { parts.forEach(part => part.solid.delete()) }
    const manualCfg = { ...conservePlan.printCfg, recommendKnockouts: false }
    const closedParts = splitSolidForPrint(source.solid, manualCfg, conserveDesign, source.wasm, conservePanels)
    const closedVolume = closedParts.reduce((sum, part) => sum + part.solid.volume(), 0)
    try {
      const cutCircle = closedParts.flatMap(part => part.faces).find(item =>
        item.face.id === 'face-1' && item.panel.edge_holes.some(hole => hole.x === 250 && hole.y === 30))
      assert.ok(cutCircle, '新切口应生成与最近长孔同列、距接缝 10mm 的圆孔候选')
      assert.ok(!conservePanels[0].panel.edge_holes.some(hole => hole.x === 250 && hole.y === 30),
        '回归必须覆盖原整板没有的新接缝孔')
      const key = spatialHoleKey(cutCircle.face.phaseU + 250, 30)
      const opened = splitSolidForPrint(source.solid, manualCfg,
        { ...conserveDesign, holeOverrides: { [key]: true } }, source.wasm, conservePanels)
      try {
        assert.ok(closedVolume - opened.reduce((sum, part) => sum + part.solid.volume(), 0) > 90,
          '打开新接缝圆孔必须实际改变独立件实体')
        assert.ok(opened.flatMap(part => part.faces).some(item =>
          item.panel.edge_holes.some(hole => hole.x === 250 && hole.y === 30 && hole.knocked)))
      } finally { opened.forEach(part => part.solid.delete()) }
      const restored = splitSolidForPrint(source.solid, manualCfg,
        { ...conserveDesign, holeOverrides: { [key]: false } }, source.wasm, conservePanels)
      try {
        assert.ok(Math.abs(restored.reduce((sum, part) => sum + part.solid.volume(), 0) - closedVolume) < 0.01,
          '关闭新接缝圆孔应恢复原实体')
      } finally { restored.forEach(part => part.solid.delete()) }
    } finally { closedParts.forEach(part => part.solid.delete()) }
  } finally { source.solid.delete() }
  const wideTall = await createSpatialManufacturing3MF({ layout: { ...config, template: 'L',
    width: 500, depth: 300, height: 600, manufacturingMode: 'monolithic' }, cfg: PEGBOARD_DEFAULT_CONFIG,
    projectName: 'L-XYZ-split', assemblyMarking: createDefaultAssemblyMarking() })
  const splitFiles = unzipSync(wideTall.data)
  const splitMap = JSON.parse(strFromU8(splitFiles['立体制造分件.json']))
  assert.equal(splitMap.parts.length, wideTall.panelCount)
  assert.ok(wideTall.panelCount > 3, 'XY 与 H 同时超限时，不能只沿高度切三节')
  assert.ok(splitMap.parts.some(part => part.holes.some(hole => hole.through)), '独立件应应用平面的接缝孔推荐')
  for (const part of splitMap.parts) {
    const inner = unzipSync(splitFiles[part.file])
    const xml = strFromU8(inner['3D/3dmodel.model'])
    assert.equal([...xml.matchAll(/<object /g)].length, 1, '每个制造文件必须只包含一个独立实体')
    for (const vertex of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
      const [x, y, z] = vertex.slice(1).map(Number)
      assert.ok(x >= 5 - 1e-4 && x <= 251 + 1e-4 && y >= 5 - 1e-4 && y <= 251 + 1e-4,
        `${part.id} 导出坐标超出安全热床`)
      assert.ok(z >= -1e-4 && z <= 251 + 1e-4, `${part.id} 导出坐标超出安全高度`)
    }
  }
  await assert.rejects(createSpatialManufacturing3MF({ layout: { ...config, printSafetyMarginMm: 25 },
    cfg: { ...smallBed, bedW: 60, bedH: 60 }, projectName: 'no-safe-space',
    assemblyMarking: createDefaultAssemblyMarking() }), /安全留边/)
  console.log(`XYZ 切分：500×300×600 L 型生成 ${wideTall.panelCount} 个独立 3MF，全部通过安全空间坐标检查`)
  console.log(`立体工程集成：U 型 ${full.length} 面，小热床 ${pieces.length} 件，L 型 120°、自由拼接边长孔/圆孔 10mm、外缘/孔口真实倒角、旧工程孔开关迁移通过`)
} finally { await server.close() }
