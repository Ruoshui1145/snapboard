import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, appType: 'custom', server: { middlewareMode: true } })
let cases = 0
try {
  const { pixelTextPolygons } = await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
  const { createMarkingGeometry } = await server.ssrLoadModule('/src/utils/markingShapes.ts')
  for (const height of [3, 3.6, 4.2, 4.8, 5.4, 6, 8]) {
    for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-') {
      for (const [x, y, rotation, mirror] of [[0, 0, 0, true], [472.94, 353.4, 0, true], [195.8, 120, Math.PI / 2, false]]) {
        const rings = pixelTextPolygons(char, x, y, height, rotation, mirror)
        const geometry = createMarkingGeometry(rings, 0.3)
        geometry.computeBoundingBox()
        const points = rings.flat()
        for (const [axis, values] of [['x', points.map(p => p.x)], ['y', points.map(p => p.y)]]) {
          assert.ok(Math.abs(geometry.boundingBox.min[axis] - Math.min(...values)) < 2e-5)
          assert.ok(Math.abs(geometry.boundingBox.max[axis] - Math.max(...values)) < 2e-5)
        }
        for (const key of Object.keys(geometry.attributes)) if (key !== 'position') geometry.deleteAttribute(key)
        const indexed = mergeVertices(geometry, 1e-5)
        const index = indexed.index, edges = new Map()
        let triangles = 0
        for (let i = 0; i < index.count; i += 3) {
          const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2)
          if (a === b || b === c || a === c) continue
          triangles++
          for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = u < v ? `${u}:${v}` : `${v}:${u}`
            edges.set(key, (edges.get(key) ?? 0) + 1)
          }
        }
        assert.ok(triangles > 0)
        assert.equal([...edges.values()].filter(count => count !== 2).length, 0,
          `${char} at ${height} mm / ${x},${y},${rotation},mirror=${mirror}: cap and wall must share closed edges`)
        // Cap subdivision must preserve both the inner counters and solid volume.
        const expectedArea = rings.reduce((sum, ring) => sum + ring.reduce((area, p, i) => {
          const q = ring[(i + 1) % ring.length]
          return area + p.x * q.y - q.x * p.y
        }, 0) / 2, 0)
        const position = geometry.getAttribute('position')
        let volume = 0
        for (let i = 0; i < position.count; i += 3) {
          const a = [position.getX(i) - x, position.getY(i) - y, position.getZ(i)]
          const b = [position.getX(i+1) - x, position.getY(i+1) - y, position.getZ(i+1)]
          const c = [position.getX(i+2) - x, position.getY(i+2) - y, position.getZ(i+2)]
          volume += (a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6
        }
        assert.ok(Math.abs(Math.abs(volume) - expectedArea * 0.3) < 1e-4, `${char}: glyph volume changed`)
        indexed.dispose(); geometry.dispose(); cases++
      }
    }
  }
  console.log(`PASS: ${cases} actual glyph extrusion and export-weld closure checks`)
  if (process.argv[2]) {
    const { workspace } = JSON.parse(await readFile(path.resolve(process.argv[2]), 'utf8'))
    const { createManufacturing3MF } = await server.ssrLoadModule('/src/utils/export3mf.ts')
    const {buildAssemblyMarkPlan}=await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
    const plan=buildAssemblyMarkPlan(workspace.splitResult.panels,workspace.splitConfig,workspace.assemblyMarking,workspace.project.metadata.name)
    for(const seam of plan.seams){
      const marks=plan.panels.flatMap(p=>p.marks).filter(m=>m.seamId===seam.id)
      assert.equal(marks.length,2,`${seam.id} must remain marked on both sides after enlargement`)
      assert.ok(marks.every(m=>m.textRotation===0&&m.textHeightMm>=4.8),'all real-project seam digits must be upright and enlarged')
    }
    console.log(`PASS: ${plan.seams.length} real seams with enlarged upright paired numbers`)
    const result = await createManufacturing3MF({
      panels: workspace.splitResult.panels, cfg: { ...workspace.splitConfig, thickness: 4 },
      placedParts: [], projectName: workspace.project.metadata.name, assemblyMarking: workspace.assemblyMarking,
    })
    assert.equal(result.markingAppliedCount, workspace.splitResult.panels.length, result.warnings.join('; '))
    assert.ok(!result.warnings.some(warning => warning.includes('安全回退')), result.warnings.join('; '))
    console.log(`PASS: real project ${result.markingAppliedCount}/${result.markingRequestedCount} marked panels; no fallback`)
  }
} finally { await server.close() }
