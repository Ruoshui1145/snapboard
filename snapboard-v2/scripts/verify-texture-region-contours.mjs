import assert from 'node:assert/strict'
import { createServer } from 'vite'
import polygonClipping from 'polygon-clipping'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { buildTextureRegionContours: build, extrudeTextureRegions: extrude } = await server.ssrLoadModule('/src/utils/textureRegionContours.ts')
  const areaRing = r => r.reduce((s, a, i) => { const b = r[(i + 1) % r.length]; return s + a[0] * b[1] - b[0] * a[1] }, 0) / 2
  const multi = polygons => polygons.map(p => [p.outer, ...p.holes])
  const areaMulti = polygons => polygons.reduce((s, p) => s + Math.abs(areaRing(p[0])) - p.slice(1).reduce((a, r) => a + Math.abs(areaRing(r)), 0), 0)
  const fixture = (width, height, cell, pitch = 0.1) => ({ width, height, materials: Int16Array.from({ length: width * height }, (_, i) => cell(i % width, Math.floor(i / width))), xBoundaries: Float64Array.from({ length: width + 1 }, (_, i) => i * pitch), yBoundaries: Float64Array.from({ length: height + 1 }, (_, i) => i * pitch) })
  const segments = rings => rings.flatMap(r => r.map((p, i) => [p, r[(i + 1) % r.length]]))
  const distance = (p, [a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const maxSampledDistance = (from, to) => Math.max(...from.flatMap(([a, b]) => [0, 0.25, 0.5, 0.75, 1].map(t => {
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    return Math.min(...to.map(edge => distance(p, edge)))
  })))
  const checkBoundaryError = (input, result, material) => {
    const original = []
    const get = (x, y) => x < 0 || y < 0 || x >= input.width || y >= input.height ? -1 : input.materials[y * input.width + x]
    for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) if (get(x, y) === material) {
      const x0 = input.xBoundaries[x], x1 = input.xBoundaries[x + 1], y0 = input.yBoundaries[y], y1 = input.yBoundaries[y + 1]
      if (get(x - 1, y) !== material) original.push([[x0, y0], [x0, y1]])
      if (get(x + 1, y) !== material) original.push([[x1, y0], [x1, y1]])
      if (get(x, y - 1) !== material) original.push([[x0, y0], [x1, y0]])
      if (get(x, y + 1) !== material) original.push([[x0, y1], [x1, y1]])
    }
    const output = segments(result.regions.get(material).flatMap(p => [p.outer, ...p.holes]))
    const bound = result.diagnostics.toleranceMm + 1e-8
    assert.ok(maxSampledDistance(original, output) <= bound, 'source-to-output contour distance')
    assert.ok(maxSampledDistance(output, original) <= bound, 'output-to-source contour distance')
  }
  let closed = 0, fallback = 0
  const verify = (input, name, allowPinch = false) => {
    const result = build(input)
    assert.deepEqual(result, build(input), `${name}: deterministic`)
    assert.ok(result.diagnostics.maximumDisplacementMm <= (input.toleranceMm ?? 0.05) + 1e-10, `${name}: fitting tolerance`)
    const regions = [...result.regions.values()]
    let expected = 0, correction = 0
    for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) if (input.materials[y * input.width + x] >= 0) {
      const cell = (input.xBoundaries[x + 1] - input.xBoundaries[x]) * (input.yBoundaries[y + 1] - input.yBoundaries[y]) - correction
      const next = expected + cell; correction = (next - expected) - cell; expected = next
    }
    assert.ok(Math.abs(regions.reduce((s, p) => s + areaMulti(multi(p)), 0) - expected) < 1e-8, `${name}: full partition area`)
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) assert.ok(areaMulti(polygonClipping.intersection(multi(regions[i]), multi(regions[j]))) < 1e-10, `${name}: materials do not overlap`)
      try {
        const mesh = extrude(regions[i], 0.32, 0.4)
        assert.ok(mesh.triangles.length > 0); closed++
        const edges = new Map()
        for (let k = 0; k < mesh.triangles.length; k += 3) for (let j = 0; j < 3; j++) {
          const a = mesh.triangles[k + j], b = mesh.triangles[k + (j + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`
          const edge = edges.get(key) ?? { count: 0, winding: 0 }; edge.count++; edge.winding += a < b ? 1 : -1; edges.set(key, edge)
        }
        assert.ok([...edges.values()].every(e => e.count === 2 && e.winding === 0), `${name}: serialized index closure and normals`)
        let volume = 0
        for (let k = 0; k < mesh.triangles.length; k += 3) {
          const [a, b, c] = mesh.triangles.slice(k, k + 3).map(id => mesh.vertices.slice(id * 3, id * 3 + 3))
          volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
        }
        assert.ok(Math.abs(volume - areaMulti(multi(regions[i])) * 0.08) < 1e-8, `${name}: closed volume with correct winding`)
      } catch (error) {
        if (!allowPinch || !String(error).includes('nonmanifold')) throw error
        fallback++
      }
    }
    return result
  }
  const diagonal = verify(fixture(64, 64, (x, y) => x > y ? 0 : 1), 'staircase')
  assert.ok(diagonal.diagnostics.movedVertices > 0, 'actually smooths staircase')
  assert.ok(diagonal.diagnostics.outputVertices < diagonal.diagnostics.originalVertices / 4, 'meaningfully reduces path vertices')
  const slopes = {}
  for (const slope of [0.1, 0.3, 0.5, 1, 2]) {
    const input = fixture(128, 128, (x, y) => y > slope * x + 20 ? 0 : 1)
    const result = verify(input, `slope ${slope}`)
    checkBoundaryError(input, result, 0)
    slopes[slope] = result.diagnostics.outputVertices
  }
  const standard = build({ ...fixture(128, 128, (x, y) => y > 0.3 * x + 20 ? 0 : 1), straightFit: false })
  assert.equal(standard.diagnostics.maximumFitErrorMm, 0, 'standard mode keeps its previous local smoothing')
  assert.ok(standard.diagnostics.outputVertices > slopes[0.3], 'fine mode actually simplifies beyond standard mode')
  const corner = verify(fixture(40, 40, (x, y) => (x < 20 && y < 20) || (x < 10 && y >= 20) ? 1 : 0), 'long-run corners')
  assert.ok(corner.regions.get(1).some(p => p.outer.some(([x, y]) => x === 2 && y === 2)), 'square corner retained exactly')
  verify(fixture(30, 30, (x, y) => x < 8 && y > 10 ? -1 : x > y ? 0 : y < 15 ? 1 : 2), 'three-material junction and exterior')
  verify(fixture(30, 30, (x, y) => (x - 15) ** 2 + (y - 15) ** 2 < 36 ? -1 : x > y ? 0 : 1), 'hole')
  const manyHoles = build(fixture(96, 96, (x, y) => {
    const localX = x % 12, localY = y % 12
    return localX >= 1 && localX <= 10 && localY >= 1 && localY <= 10
      && !(localX >= 4 && localX <= 7 && localY >= 4 && localY <= 7) ? 1 : 0
  }))
  assert.equal(manyHoles.regions.get(1).length, 64, 'spatial hole owners retain all islands')
  assert.equal(manyHoles.regions.get(1).reduce((sum, polygon) => sum + polygon.holes.length, 0), 64, 'each island retains its own hole')
  verify(fixture(70, 70, (x, y) => (x - 35) ** 2 + (y - 35) ** 2 < 400 ? 1 : 0), 'curved shared boundary')
  verify(fixture(30, 30, (x, y) => x === 15 || x < 10 || x > 20 ? 0 : 1), 'one-cell bridge')
  const island = verify(fixture(20, 20, (x, y) => x === 10 && y === 10 ? 1 : 0), 'tiny island')
  assert.ok(Math.abs(areaMulti(multi(island.regions.get(1))) - 0.01) < 1e-12, 'single cell not shrunk')
  const touching = verify(fixture(8, 8, (x, y) => (x + y) % 2), 'independent diagonal contact shells')
  assert.ok([...touching.regions.values()].every(p => p.length === 32), 'each diagonal cell remains an independent closed island')
  assert.throws(() => extrude([{ outer: [[0,0],[1,0],[1,1],[2,1],[2,2],[1,2],[1,1],[0,1]], holes: [] }], 0, 0.08), /nonmanifold/, 'self-touch within one shell still rejected')
  assert.throws(() => extrude([{ outer: [[0,0],[4,0],[4,4],[0,4]], holes: [[[0,0],[1,2],[2,1]]] }], 0, 0.08), /nonmanifold/, 'hole touching outer shell still rejected')
  verify(fixture(12, 12, (x, y) => x === y && x > 3 && x < 8 ? -1 : 0), 'hole corner contacts', true)
  const protectedInput = { ...fixture(30, 30, (x, y) => x > y ? 7 : 0), fixedMaterials: [7] }
  const protectedResult = verify(protectedInput, 'edge seal protected')
  assert.equal(protectedResult.diagnostics.movedVertices, 0)
  const clipped = fixture(30, 30, (x, y) => x > y ? 0 : 1)
  clipped.xBoundaries[30] = 2.933; clipped.yBoundaries[30] = 2.955
  verify(clipped, 'clipped final cells')
  const exact = verify({ ...fixture(30, 30, (x, y) => x > y ? 0 : 1), toleranceMm: 0 }, 'exact domain mode')
  assert.equal(exact.diagnostics.movedVertices, 0)
  const cap = extrude([{ outer: [[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]], holes: [[[1, 1], [1, 2], [1, 3], [3, 3], [3, 1]]] }], 0, 0.08)
  assert.ok(cap.triangles.length > 0, 'cap collinear T junction repair')
  // Reproducible small adversarial partitions include holes, islands and pinches.
  let seed = 98127
  for (let n = 0; n < 30; n++) verify(fixture(12, 12, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % 4 - 1 }), `random${n}`, true)
  // Long nearly collinear cap diagonals formerly retained numerical zero-area
  // triangles, producing duplicate edges after repair on large circles.
  verify(fixture(1000, 1000, (x, y) => {
    const distance = Math.hypot(x - 500, y - 500)
    return distance < 1000 / 3 - 1 ? 0 : distance < 1000 / 3 + 1 ? 2 : 1
  }), 'large three-material circle roundoff')
  const large = fixture(1600, 1200, (x, y) => x < y ? 0 : x < y + 300 ? 1 : 2)
  const start = performance.now(), big = build(large), elapsed = performance.now() - start
  assert.ok(elapsed < 15000, `representative 1.92M-cell layer took ${elapsed}ms`)
  assert.ok(big.diagnostics.outputVertices < big.diagnostics.originalVertices / 10)
  console.log(JSON.stringify({ status: 'pass', closedMaterialMeshes: closed, explicitPinchFallbacks: fallback, staircase: diagonal.diagnostics, slopes, large: { cells: large.materials.length, milliseconds: Math.round(elapsed), ...big.diagnostics } }, null, 2))
} finally { await server.close() }
