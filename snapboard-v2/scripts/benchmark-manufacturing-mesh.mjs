// Read-only: node scripts/benchmark-manufacturing-mesh.mjs "已保存项目/长亮.snapboard"
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshoptSimplifier } from 'meshoptimizer/simplifier'

const input = process.argv[2]
if (!input) throw new Error('Pass a .snapboard project path')
const workspace = JSON.parse(readFileSync(input, 'utf8')).workspace
const meshStats = (indices, positions) => {
  const edges = new Map()
  let volume = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2]
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2]
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  return { badEdges: [...edges.values()].filter(count => count !== 2).length, volumeMm3: volume }
}
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { generateSplitPanelMesh } = await server.ssrLoadModule('/src/utils/boardMesh.ts')
  const panel = workspace.splitResult.panels[0]
  const cfg = workspace.splitConfig
  await MeshoptSimplifier.ready
  for (const segments of [64, 12]) {
    const root = generateSplitPanelMesh({ panel, cfg, color: 0x3ec6b0, curveSegments: segments,
      includeGuides: false, manufacturingChamfer: cfg.manufacturingChamfer })
    const meshes = []
    root.traverse(object => {
      if (!object.isMesh || !object.geometry) return
      const geometry = object.geometry.clone()
      for (const key of Object.keys(geometry.attributes)) if (key !== 'position') geometry.deleteAttribute(key)
      const welded = mergeVertices(geometry, 1e-5)
      const positions = welded.getAttribute('position').array
      const indices = Uint32Array.from(welded.getIndex().array)
      const start = performance.now()
      const [simplified, error] = MeshoptSimplifier.simplify(indices, positions, 3,
        Math.max(12, Math.floor(indices.length * 0.15 / 3) * 3), 0.025, ['ErrorAbsolute'])
      const before = meshStats(indices, positions), after = meshStats(simplified, positions)
      meshes.push({ originalFaces: indices.length / 3, simplifiedFaces: simplified.length / 3,
        errorMm: error, simplifyMs: Math.round(performance.now() - start),
        badEdgesBefore: before.badEdges, badEdgesAfter: after.badEdges,
        volumeDeltaPercent: Math.abs((after.volumeMm3 - before.volumeMm3) / before.volumeMm3) * 100 })
      welded.dispose()
      geometry.dispose()
    })
    root.traverse(object => { object.geometry?.dispose(); object.material?.dispose?.() })
    console.log(JSON.stringify({ segments, meshes, originalFaces: meshes.reduce((n, mesh) => n + mesh.originalFaces, 0),
      simplifiedFaces: meshes.reduce((n, mesh) => n + mesh.simplifiedFaces, 0) }))
  }
} finally { await server.close() }
