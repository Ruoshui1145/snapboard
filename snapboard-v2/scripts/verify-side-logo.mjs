import assert from 'node:assert/strict'
import { createServer } from 'vite'
import * as THREE from 'three'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
try {
  const [logo, board, defaults, native] = await Promise.all([
    server.ssrLoadModule('/src/utils/sideLogo.ts'),
    server.ssrLoadModule('/src/utils/boardMesh.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/spatialSolid.ts'),
  ])
  const wasm = await native.spatialManifold()
  const panel = { id: 'side-logo', x: 350, y: 170, w: 120, h: 100,
    contour: [{ x: 350, y: 170 }, { x: 470, y: 170 }, { x: 470, y: 270 }, { x: 350, y: 270 }],
    roundIdx: [0, 1, 2, 3], outerCorners: [true, true, true, true],
    slots: [{ x: 370, y: 200 }], round_holes: [], edge_holes: [] }
  const toSolid = root => {
    root.updateMatrixWorld(true)
    const vertices = [], triangles = []
    root.traverse(object => {
      if (!object.isMesh) return
      const position = object.geometry.getAttribute('position'), index = object.geometry.getIndex()
      const base = vertices.length / 3
      for (let i = 0; i < position.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld)
        vertices.push(v.x, v.y, v.z)
      }
      const ids = index?.array ?? Array.from({ length: position.count }, (_, i) => i)
      triangles.push(...Array.from(ids, id => id + base))
    })
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(vertices), triVerts: Uint32Array.from(triangles), tolerance: 1e-5 })
    mesh.merge()
    const solid = new wasm.Manifold(mesh)
    assert.equal(solid.status(), 'NoError')
    return solid
  }
  for (const [thickness, chamfer, radius] of [[5, 0.35, 2], [4, 0.35, 2], [8, 0.35, 12], [5, 1, 2]]) {
    const cfg = { ...defaults.PEGBOARD_DEFAULT_CONFIG, thickness, manufacturingChamfer: chamfer, cornerRadius: radius }
    const cutter = logo.createSideLogoCutterGeometry(panel, cfg, 'SNAPBOARD')
    assert.ok(cutter)
    cutter.computeBoundingBox()
    assert.ok(cutter.boundingBox.min.z >= chamfer + 0.15 - 1e-5, `T=${thickness} C=${chamfer} minZ=${cutter.boundingBox.min.z} maxZ=${cutter.boundingBox.max.z}`)
    assert.ok(cutter.boundingBox.max.z <= thickness - chamfer - 0.15 + 1e-5)
    assert.ok(cutter.boundingBox.min.x >= panel.x + radius + 0.5 - 1e-5)
    assert.ok(cutter.boundingBox.max.x <= panel.x + panel.w - radius - 0.5 + 1e-5)
    cutter.dispose()
    const root = board.generateSplitPanelMesh({ panel, cfg, color: 0x334b55, includeGuides: false, manufacturingChamfer: chamfer })
    const before = toSolid(root)
    assert.equal(await logo.engraveSideLogoPreview(root, panel, cfg, 'SNAPBOARD'), true)
    assert.equal(root.children.filter(object => object.isMesh).length, 1, 'no added letter objects')
    const after = toSolid(root)
    assert.ok(before.volume() - after.volume() > 0.5, 'letters must remove real material')
    const added = after.subtract(before)
    // A Three Float32 round-trip at x=350 mm leaves sub-micron boolean slivers.
    assert.ok(added.volume() < 0.001, `engraving grew the board: T=${thickness} C=${chamfer} added=${added.volume()}`)
    const beforeBox = before.boundingBox(), afterBox = after.boundingBox()
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(afterBox.min[axis] >= beforeBox.min[axis] - 0.00005)
      assert.ok(afterBox.max[axis] <= beforeBox.max[axis] + 0.00005)
    }
    const removed = before.subtract(after)
    const guardedVolume = (origin, dimensions) => {
      const cube = wasm.Manifold.cube(dimensions), region = cube.translate(origin), overlap = removed.intersect(region)
      try { return overlap.volume() } finally { overlap.delete(); region.delete(); cube.delete() }
    }
    assert.ok(guardedVolume([panel.x, panel.y, 0], [panel.w, panel.h, chamfer + 0.15]) < 0.001)
    assert.ok(guardedVolume([panel.x, panel.y, thickness - chamfer - 0.15], [panel.w, panel.h, chamfer + 0.15]) < 0.001)
    assert.ok(guardedVolume([panel.x, panel.y, 0], [panel.w, panel.h - 0.241, thickness]) < 0.001, 'engraving exceeded 0.24 mm recess depth')
    const neighbor = before.translate([0, panel.h, 0]), overlap = after.intersect(neighbor)
    assert.ok(overlap.volume() < 0.001, 'two adjacent boards must still meet without interference')
    for (const solid of [before, after, added, removed, neighbor, overlap]) solid.delete()
    root.traverse(object => { object.geometry?.dispose(); object.material?.dispose() })
  }
  assert.equal(logo.createSideLogoCutterGeometry(panel, { ...defaults.PEGBOARD_DEFAULT_CONFIG, thickness: 4, manufacturingChamfer: 1 }, 'SNAPBOARD'), null)
  assert.equal(logo.createSideLogoCutterGeometry({ ...panel, w: 10, contour: undefined }, defaults.PEGBOARD_DEFAULT_CONFIG, 'SNAPBOARD'), null)
  console.log('侧边凹刻：4/5/8 mm 板、双侧倒角和圆角避让、真实减材、无凸字、相邻板零干涉通过')
} finally { await server.close() }
