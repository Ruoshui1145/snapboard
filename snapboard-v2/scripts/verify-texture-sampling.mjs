import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, appType: 'custom', server: { middlewareMode: true } })
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const panel = (id, x = 0, y = 0) => ({ id, x, y, w: 100, h: 100, contour: rect(x, y, 100, 100), slots: [], round_holes: [], edge_holes: [], cutouts: [], roundIdx: [], outerCorners: [false, false, false, false] })
const near = (actual, expected, epsilon = 1e-5) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`)
const ringArea = points => Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y }, 0)) / 2
const freezeDeep = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value) } return value }

try {
  assert.equal(typeof document, 'undefined', 'this regression must run without a DOM mock')
  const { planTextureSamples } = await server.ssrLoadModule('/src/utils/textureSampling.ts')
  const { PEGBOARD_DEFAULT_CONFIG } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const { createSplitPanelShape, generateSplitPanelMesh } = await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const { createManufacturing3MF, manufacturing3MFFileName } = await server.ssrLoadModule('/src/utils/export3mf.ts')
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, manufacturingChamfer: 0 }
  const source = freezeDeep([panel('source-A'), panel('source-B', -160, -110)])
  const snapshot = JSON.stringify(source)
  const result = planTextureSamples(source, cfg, { sizeMm: 20, locations: [{ panelIndex: 1, x: -130, y: -70 }, { panelIndex: 0, x: 50, y: 50 }] })
  assert.equal(result.length, 2)
  assert.deepEqual(result.map(sample => sample.sourcePanelId), ['source-A', 'source-B'], 'selection order must not scramble source attribution')
  for (const sample of result) {
    near(sample.panel.w, 20); near(sample.panel.h, 20); near(sample.areaMm2, 400)
    near(sample.panel.x, sample.center.x - 10); near(sample.panel.y, sample.center.y - 10)
    assert.equal(sample.requestedSizeMm, 20)
    assert.equal(sample.panel.slots.length, 0)
    assert.equal(sample.panel.round_holes.length, 0)
    assert.equal(sample.panel.edge_holes.length, 0)
  }
  assert.deepEqual(result[1].panel.contour, rect(-140, -80, 20, 20), 'negative world coordinates must be retained for texture lookup')
  assert.equal(JSON.stringify(source), snapshot, 'planning must not mutate original panels')

  const cutout = panel('hole')
  cutout.cutouts = [rect(47, 48, 6, 4)]
  const sample = planTextureSamples([cutout], cfg, { sizeMm: 20, locations: [{ panelIndex: 0, x: 50, y: 50 }] })[0]
  near(sample.areaMm2, 376)
  assert.equal(sample.panel.cutouts.length, 1)
  near(ringArea(sample.panel.cutouts[0]), 24)
  // Verify rebuilt geometry retains the hole and source XY scale. This generic
  // board mesh is not the sampling exporter (which omits the structural base).
  const shape = createSplitPanelShape(sample.panel, cfg).extractPoints(64)
  assert.equal(shape.holes.length, 1)
  const meshRoot = generateSplitPanelMesh({ panel: sample.panel, cfg, color: 0xffffff, includeGuides: false, manufacturingChamfer: 0 })
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
  meshRoot.traverse(object => {
    const position = object.geometry?.attributes?.position
    if (!position) return
    for (let i = 0; i < position.count; i++) for (const [axis, getter] of [['X', 'getX'], ['Y', 'getY'], ['Z', 'getZ']]) {
      const value = position[getter](i)
      bounds[`min${axis}`] = Math.min(bounds[`min${axis}`], value)
      bounds[`max${axis}`] = Math.max(bounds[`max${axis}`], value)
    }
    object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    materials.forEach(material => material?.dispose())
  })
  near(bounds.maxX - bounds.minX, 20)
  near(bounds.maxY - bounds.minY, 20)
  near(bounds.maxZ - bounds.minZ, cfg.thickness)

  for (const [kind, holeArea] of [['slots', cfg.slotWidth * (cfg.slotLength - cfg.slotWidth) + Math.PI * (cfg.slotWidth / 2) ** 2], ['round_holes', Math.PI * (cfg.jointDiameter / 2) ** 2]]) {
    const perforated = panel(kind); perforated[kind] = [{ x: 50, y: 50 }]
    const cropped = planTextureSamples([perforated], cfg, { sizeMm: 30, locations: [{ panelIndex: 0, x: 50, y: 50 }] })[0]
    assert.equal(cropped.panel.cutouts.length, 1, `${kind} must be retained as a clipped cutout`)
    near(cropped.areaMm2, 900 - holeArea, 0.1)
  }

  const clipped = planTextureSamples([panel('edge')], cfg, { sizeMm: 20, locations: [{ panelIndex: 0, x: 3, y: 50 }] })[0]
  near(clipped.panel.w, 13); near(clipped.panel.h, 20); near(clipped.areaMm2, 260)
  const diamond = panel('diamond')
  diamond.contour = [{ x: 0, y: 50 }, { x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }]
  const triangle = planTextureSamples([diamond], cfg, { sizeMm: 20, locations: [{ panelIndex: 0, x: 0, y: 50 }] })[0]
  near(triangle.areaMm2, 100)
  assert.equal(triangle.panel.contour.length, 3)
  near(ringArea(createSplitPanelShape(triangle.panel, cfg).extractPoints(64).shape), 100)
  const divided = panel('split'); divided.cutouts = [rect(48, 20, 4, 60)]
  assert.throws(() => planTextureSamples([divided], cfg, { sizeMm: 20, locations: [{ panelIndex: 0, x: 50, y: 50 }] }), /多片/)
  for (const x of [200, -8]) assert.throws(() => planTextureSamples([panel('empty')], cfg, { sizeMm: 20, locations: [{ panelIndex: 0, x, y: 50 }] }), /没有实体|面积不足/)
  for (const locations of [[], [{ panelIndex: 0, x: 50, y: 50 }], [{ panelIndex: 0, x: 50, y: 50 }, { panelIndex: 0, x: 60, y: 50 }], [{ panelIndex: 0, x: 50, y: 50 }, { panelIndex: 2, x: 60, y: 50 }]]) {
    assert.throws(() => planTextureSamples(source, cfg, { sizeMm: 20, locations }), /每块板/)
  }
  for (const sizeMm of [9, 41, NaN, Infinity]) assert.throws(() => planTextureSamples([panel('size')], cfg, { sizeMm, locations: [{ panelIndex: 0, x: 50, y: 50 }] }), /边长/)
  assert.throws(() => planTextureSamples([panel('coord')], cfg, { sizeMm: 20, locations: [{ panelIndex: 0, x: NaN, y: 50 }] }), /坐标/)

  const input = { panels: [panel('export')], cfg, placedParts: [], projectName: '取样校验', textureSampling: { sizeMm: 20, locations: [{ panelIndex: 0, x: 50, y: 50 }] } }
  await assert.rejects(() => createManufacturing3MF(input), /启用叠色或纹理/)
  await assert.rejects(() => createManufacturing3MF({ ...input, panels: [], boardTexture: { enabled: true } }), /启用叠色或纹理|没有可导出的板件/)
  assert.match(manufacturing3MFFileName(input, 1), /纹理抽样-排盘-1盘/)
  // Actual veneer and optical texture exports use browser canvas and are verified
  // separately in the browser regression; this test does not replace that check.
  console.log('Texture sampling SSR regression passed: exact-scale, negative coordinates, source immutability, holes, clipping, disconnected rejection, per-panel coverage and export guards')
} finally {
  await server.close()
}
