import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'

const vite = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const [{ applyLatticeFrontLayer, estimateLatticeVolume, generateSvgLattice, currentSvgFace, DEFAULT_SVG_LATTICE_OPTIONS },
    { generateOpenLattice }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }, { pointInRing },
    { createManufacturing3MF }, { useAppStore }, { serializeProjectFile, parseProjectFile }] = await Promise.all([
    vite.ssrLoadModule('/src/utils/svgLattice.ts'), vite.ssrLoadModule('/src/utils/openLattice.ts'),
    vite.ssrLoadModule('/src/utils/pegboardSplit.ts'), vite.ssrLoadModule('/src/features/shapeLibrary/import/geometry.ts'),
    vite.ssrLoadModule('/src/utils/export3mf.ts'), vite.ssrLoadModule('/src/store/useAppStore.ts'), vite.ssrLoadModule('/src/utils/projectFile.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220, thickness: 5 }
  const panel = splitOrthogonalPolygon({ points: [{ x:0,y:0 },{ x:160,y:0 },{ x:160,y:160 },{ x:0,y:160 }], holes: [] }, cfg).panels[0]
  const inside = (p, polygons) => polygons.some(poly => pointInRing(p, poly[0], true) && !poly.slice(1).some(r => pointInRing(p, r, true)))
  let hex
  const reports = []
  for (const style of ['organic', 'hex', 'diamond']) {
    const through = generateOpenLattice(panel, cfg, 3.5, style)
    assert.equal(applyLatticeFrontLayer(panel, cfg, through, 0), through)
    const skin = estimateLatticeVolume(panel, cfg, applyLatticeFrontLayer(panel, cfg, through, 1))
    assert.equal(skin.style, style)
    assert.equal(skin.face.source.templateStyle, style, 'retained face must not merge or substitute template families')
    assert.deepEqual(skin.holes, through.holes)
    assert.equal(skin.face.layers.length, 3)
    const carrier = skin.face.layers.find(layer => layer.role === 'backing')
    assert.equal(carrier.polygons.length, 1, 'whole-face carrier is one connected sheet, not one part per rear pocket')
    assert.equal(skin.face.layers.find(layer=>layer.role==='structure').zMax, carrier.zMin, 'ribs end beneath the carrier instead of cutting across it')
    assert.equal(carrier.polygons[0].length, 1 + panel.slots.length + panel.round_holes.length + panel.edge_holes.filter(h=>h.knocked).length,
      'carrier holes are functional holes only; lattice windows cannot pierce the carrier')
    assert.ok(skin.removedAreaMm2 < 1e-5, 'additional windows must be blind pockets with a continuous front')
    const openVolume = estimateLatticeVolume(panel, cfg, through)
    assert.ok(Math.abs(skin.volumeMm3 - openVolume.volumeMm3 - through.removedAreaMm2) < 1,
      '1mm face adds exactly window area × 1mm, without changing total thickness')
    assert.ok(skin.volumeMm3 < skin.baselineVolumeMm3)
    const thicker = estimateLatticeVolume(panel, cfg, applyLatticeFrontLayer(panel, cfg, through, 1.4))
    assert.ok(Math.abs(thicker.volumeMm3 - skin.volumeMm3 - through.removedAreaMm2 * 0.4) < 1)
    for (const layer of skin.face.layers) for (const hole of [...panel.slots, ...panel.round_holes, ...panel.edge_holes.filter(h => h.knocked)])
      assert.ok(!inside(hole, layer.polygons), 'functional holes must still pierce every retained layer')
    const candidate = panel.edge_holes.find(h => !h.knocked && h.x > 5 && h.x < 155 && h.y > 5 && h.y < 155)
    const changed = { ...panel, latticeCutouts: skin.holes, latticeFace: skin.face,
      edge_holes: panel.edge_holes.map(h => h === candidate ? { ...h, knocked:true } : h) }
    const refreshed = currentSvgFace(changed, cfg)
    assert.equal(refreshed.source.templateStyle, style)
    assert.ok(refreshed.layers.every(layer => !inside(candidate, layer.polygons)))
    const result = await createManufacturing3MF({ panels: [{ ...panel, latticeCutouts: skin.holes, latticeFace: skin.face }], cfg,
      placedParts: [], partDefinitions: [] })
    const files = unzipSync(result.data)
    assert.match(strFromU8(files['Metadata/model_settings.config']), /保留1.0mm正面/)
    const model = strFromU8(Object.entries(files).find(([name]) => /3D\/Objects\/object_\d+\.model$/i.test(name))[1])
    const zs = [...model.matchAll(/<vertex[^>]+z="([^"]+)"/g)].map(m => Number(m[1]))
    assert.equal(zs.reduce((a,b)=>Math.min(a,b),Infinity),0)
    assert.equal(zs.reduce((a,b)=>Math.max(a,b),-Infinity),5)
    reports.push(`${style}: ${Math.round((1-skin.volumeMm3/skin.baselineVolumeMm3)*100)}% geometric reduction`)
    if (style === 'hex') hex = skin
  }
  assert.throws(() => applyLatticeFrontLayer(panel, cfg, generateOpenLattice(panel,cfg,3.5,'hex'),0.4), /0.8/)
  const art = { fills: [], strokes: [{ points:[{x:55,y:55},{x:105,y:55},{x:100,y:100},{x:60,y:100}],width:0.3,closed:true }] }
  const whole = generateSvgLattice(panel, cfg, art, 3.5, 'svg', { ...DEFAULT_SVG_LATTICE_OPTIONS, coverage:'whole' })
  assert.ok(whole.face && whole.removedAreaMm2 < 1e-5)
  const blankPanel = { ...panel, id:'blank', x:200, contour:panel.contour.map(p=>({x:p.x+200,y:p.y})),
    slots:panel.slots.map(p=>({...p,x:p.x+200})), edge_holes:panel.edge_holes.map(p=>({...p,x:p.x+200})) }
  const blank = generateSvgLattice(blankPanel,cfg,art,3.5,'svg',{...DEFAULT_SVG_LATTICE_OPTIONS,coverage:'whole'})
  assert.ok(blank.face && blank.removedAreaMm2 < 1e-5, 'empty areas outside the drawing must also receive the requested full thin face')
  const openPortrait = { fills:[],strokes:[
    {points:[{x:70,y:40},{x:60,y:55},{x:67,y:70},{x:48,y:100},{x:52,y:120}],width:0.3,closed:false},
    {points:[{x:90,y:40},{x:100,y:55},{x:93,y:70},{x:112,y:100},{x:108,y:120}],width:0.3,closed:false},
    {points:[{x:75,y:57},{x:77,y:57}],width:0.3,closed:false},
  ] }
  const silhouette = generateSvgLattice(panel,cfg,openPortrait,3.5,'svg',DEFAULT_SVG_LATTICE_OPTIONS)
  assert.ok(inside({x:80,y:57},silhouette.face.source.silhouette), 'open head contours must still form a continuous backing')
  assert.ok(!inside({x:55,y:57},silhouette.face.source.silhouette), 'portrait backing must follow the outer edge rather than its rectangle')
  assert.ok(silhouette.face.source.silhouette.every(p=>p.length===1), 'internal eye and hair lines must not cut holes in the backing')
  assert.deepEqual(panel.contour,[{x:0,y:0},{x:160,y:0},{x:160,y:160},{x:0,y:160}], 'backing crop must never alter the rectangular board')
  const result = await createManufacturing3MF({ panels:[{...panel,latticeCutouts:silhouette.holes,latticeFace:silhouette.face}],cfg,
    placedParts:[],partDefinitions:[] })
  assert.equal(result.panelCount,1)
  useAppStore.setState({splitConfig:cfg,splitResult:{sources:[],panels:[panel],warnings:[],config:cfg,ts:Date.now()}})
  useAppStore.getState().setOpenLattice([{panel,holes:hex.holes,face:hex.face}],'hex',[],undefined,undefined,undefined,1)
  const state=useAppStore.getState()
  const saved=parseProjectFile(serializeProjectFile({project:state.project,boards:state.boards,placedParts:state.placedParts,
    boardTexture:state.boardTexture,assemblyMarking:state.assemblyMarking,lastTextureSampling:state.lastTextureSampling,
    assemblyScene:state.assemblyScene,splitConfig:state.splitConfig,splitResult:state.splitResult,spatialLayout:state.spatialLayout}))
  assert.equal(saved.workspace.splitResult.openLatticeSurfaceMm,1)
  assert.deepEqual(saved.workspace.splitResult.panels[0].latticeFace,JSON.parse(JSON.stringify(hex.face)))
  useAppStore.getState().clearOpenLattice()
  assert.equal(useAppStore.getState().splitResult.openLatticeSurfaceMm,undefined)
  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().splitResult.openLatticeSurfaceMm,1)
  console.log(`Retained front + cropped backing passed: ${reports.join('; ')}; whole SVG, blank areas, portrait crop, 3MF and persistence OK`)
} finally { await vite.close() }
