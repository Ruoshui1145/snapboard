import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { planTextureSamples } = await server.ssrLoadModule('/src/utils/textureSampling.ts')
  const { generateSplitPanelMesh } = await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const { PEGBOARD_DEFAULT_CONFIG } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const validate = (panel, cfg, label) => {
    for (const thickness of [0.6,4]) {
    const root = generateSplitPanelMesh({ panel, cfg: { ...cfg, thickness }, color: 0xffffff, curveSegments:64, includeGuides: false, manufacturingChamfer: 0 })
    root.traverse(mesh => {
      if (!mesh.geometry) return
      const geometry = mesh.geometry.clone()
      for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name)
      const indexed = mergeVertices(geometry, 1e-5)
      const ids = indexed.index.array, edges = new Map()
      for (let i = 0; i < ids.length; i += 3) {
        const [a,b,c] = ids.slice(i,i+3)
        if (a === b || b === c || c === a) continue
        for (const [u,v] of [[a,b],[b,c],[c,a]]) { const key = u < v ? `${u}:${v}` : `${v}:${u}`; edges.set(key,(edges.get(key) ?? 0)+1) }
      }
      const bad = [...edges.values()].filter(n => n !== 2).length
      indexed.dispose(); geometry.dispose(); mesh.geometry.dispose(); mesh.material.dispose()
      assert.equal(bad,0,`${label}/${thickness}mm: ${bad} nonmanifold edges`)
    })
    }
  }
  let count = 0
  const regression = JSON.parse(fs.readFileSync('scripts/fixtures/sampling-s02.json','utf8'))
  const actual = planTextureSamples([regression.panel],regression.cfg,{sizeMm:20,locations:[{panelIndex:0,...regression.center}]})[0]
  validate(actual.panel,regression.cfg,'S02 regression fixture'); count++
  const tangentCenter = {panelIndex:0,x:250,y:112.5}
  const tangent = planTextureSamples([regression.panel],regression.cfg,{sizeMm:20,locations:[tangentCenter]})[0]
  assert.equal(tangent.boundaryReliefMm,0.002)
  assert.ok(tangent.boundaryReliefAreaMm2>0 && tangent.boundaryReliefAreaMm2<0.1,'relief removes less than 0.1 square millimeter')
  assert.deepEqual(tangent.center,{x:250,y:112.5},'no relocation')
  assert.equal(tangent.panel.x,240); assert.equal(tangent.panel.y,102.5)
  assert.equal(tangent.panel.w,20); assert.equal(tangent.panel.h,20)
  validate(tangent.panel,regression.cfg,'actual S02 tangency'); count++
  const ordinary = planTextureSamples([regression.panel],regression.cfg,{sizeMm:20,locations:[{panelIndex:0,x:250,y:110}]})[0]
  assert.equal(ordinary.boundaryReliefMm,undefined,'ordinary fully-contained hole has no relief')
  assert.equal(ordinary.panel.cutouts.length,1,'fully-contained hole remains intact')
  const saved = '已保存项目/未命名项目.snapboard'
  if (fs.existsSync(saved)) {
    const { workspace } = JSON.parse(fs.readFileSync(saved,'utf8'))
    const panels = workspace.splitResult.panels, cfg = workspace.splitConfig
    for (const sample of planTextureSamples(panels,cfg,{sizeMm:20,locations:panels.map((p,panelIndex)=>({panelIndex,x:p.x+p.w/2,y:p.y+p.h/2}))})) {
      validate(sample.panel,cfg,`saved ${sample.panel.id}`); count++
    }
  }
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, manufacturingChamfer: 0 }
  // Reproducible fractional crop origins: the world-coordinate float32 mesh
  // quantization must not open a cut boundary when it intersects a curved hole.
  let seed = 0x53424f41
  const random = () => ((seed = (Math.imul(seed,1664525)+1013904223) >>> 0) / 4294967296)
  for (const kind of ['slots','round_holes']) for (let i=0;i<150;i++) {
    const source = { id:'fractional', x:200, y:0, w:200, h:240, slots:[], round_holes:[], edge_holes:[], cutouts:[], roundIdx:[], outerCorners:[false,false,false,false] }
    source[kind] = [{x:300,y:120}]
    const sizeMm = 10+random()*30
    const point = { panelIndex:0, x:300+random()*sizeMm-sizeMm/2, y:120+random()*sizeMm-sizeMm/2 }
    let sample
    try { sample=planTextureSamples([source],cfg,{sizeMm,locations:[point]})[0] }
    catch(error) { assert.match(error.message,/多片|面积不足/); continue }
    validate(sample.panel,cfg,`${kind}/fractional/${JSON.stringify({sizeMm,point})}`); count++
  }
  for (const kind of ['slots','round_holes']) for (const sizeMm of [10,20,30,40]) for (const delta of [-1e-4,-1e-7,0,1e-7,1e-4,0.025,0.5,2.5]) for (const axis of ['x','y']) for (const edge of [-1,0,1]) {
    const source = { id:'fixture', x:200, y:0, w:200, h:240, slots:[], round_holes:[], edge_holes:[], cutouts:[], roundIdx:[], outerCorners:[false,false,false,false] }
    source[kind] = [{x:300,y:120}]
    const r = kind === 'slots' && axis === 'y' ? cfg.slotLength / 2 : (kind === 'slots' ? cfg.slotWidth : cfg.jointDiameter)/2
    const point = {panelIndex:0,x:300,y:120}; point[axis] += sizeMm/2+r*edge+delta
    let sample
    try { sample = planTextureSamples([source],cfg,{sizeMm,locations:[point]})[0] }
    catch(error) { assert.match(error.message,/多片|面积不足/); continue }
    validate(sample.panel,cfg,`${kind}/${sizeMm}/${axis}/${edge}/${delta}`); count++
  }
  console.log(`Sample closure regression passed: ${count} crops at both 0.6mm and 4mm depths (${count*2} prisms)`)
} finally { await server.close() }
