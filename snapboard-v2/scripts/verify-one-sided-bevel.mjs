import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const [{ generateSplitPanelMesh }, { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon }] = await Promise.all([
    server.ssrLoadModule('/src/utils/boardMesh.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
  ])
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, manufacturingChamfer: 0.35 }
  const panel = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 100 }, { x: 0, y: 100 }], holes: [] }, cfg).panels[0]
  assert.ok(panel.slots.length > 0 && panel.edge_holes.length > 0)
  const inspect = side => {
    const root = generateSplitPanelMesh({ panel, cfg: { ...cfg, thickness: 4 }, color: 0xffffff,
      curveSegments: 20, slotCapSegments: 6, includeGuides: false,
      manufacturingChamfer: 0.35, manufacturingBevelSide: side })
    const mesh = root.children.filter(child => child.isMesh)
    assert.equal(mesh.length, 1, 'one-sided bevel must be one solid, not overlapping shells')
    const source = mesh[0].geometry.clone()
    for (const name of Object.keys(source.attributes)) if (name !== 'position') source.deleteAttribute(name)
    const indexed = mergeVertices(source, 1e-5)
    const ids = indexed.getIndex().array
    const positions = indexed.getAttribute('position')
    const edges = new Map()
    for (let i = 0; i < ids.length; i += 3) for (const [a, b] of [[ids[i], ids[i + 1]], [ids[i + 1], ids[i + 2]], [ids[i + 2], ids[i]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    const bad = [...edges].filter(([, value]) => value !== 2)
    assert.equal(bad.length, 0, `${side}: ${bad.length} open/nonmanifold edges`)
    const z = Array.from({ length: positions.count }, (_, i) => positions.getZ(i))
    assert.ok(Math.min(...z) >= -1e-5 && Math.max(...z) <= 4 + 1e-5)
    assert.ok(z.some(value => Math.abs(value - 4) < 1e-5) && z.some(value => Math.abs(value) < 1e-5))
    indexed.dispose(); source.dispose()
    root.traverse(object => { object.geometry?.dispose(); object.material?.dispose() })
    return { vertices: positions.count, triangles: ids.length / 3 }
  }
  console.log(JSON.stringify({ bottom: inspect('bottom'), top: inspect('top') }))
  console.log('verify:one-sided-bevel OK')
} finally { await server.close() }
