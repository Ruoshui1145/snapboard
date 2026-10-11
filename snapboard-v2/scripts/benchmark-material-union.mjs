import { readFileSync } from 'node:fs'
import polygonClipping from 'polygon-clipping'

const [geojsonPath, mapPath, materialArg, mode] = process.argv.slice(2)
const material = Number(materialArg)
if (!geojsonPath || !mapPath || !Number.isInteger(material) || material < 0 || material > 3) throw new Error('Usage: benchmark-material-union.mjs <regions.geojson> <material-map.json> <material:0-3>')
const source = JSON.parse(readFileSync(geojsonPath, 'utf8')).features
const colorMap = JSON.parse(readFileSync(mapPath, 'utf8')).colors
const [minX, minY, maxX, maxY] = [-90, -220, 110, 0] // Real Longliang p5 rectangle; holes omitted for this isolated benchmark.
const board = [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]]
const pieces = []
const vertices = polygon => polygon.reduce((sum, rings) => sum + rings.reduce((n, ring) => n + ring.length, 0), 0)
const ringArea = ring => Math.abs(ring.reduce((sum, point, i) => {
  const next = ring[(i + 1) % ring.length]
  return sum + point[0] * next[1] - next[0] * point[1]
}, 0) / 2)
const area = multi => multi.reduce((sum, polygon) => sum + ringArea(polygon[0]) - polygon.slice(1).reduce((n, hole) => n + ringArea(hole), 0), 0)
let inputVertices = 0
const start = performance.now()
for (const feature of source) {
  if (colorMap[feature.properties.color][0] !== material) continue
  const points = feature.geometry.coordinates.flat()
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity
  for (const [x, y] of points) { left = Math.min(left, x); right = Math.max(right, x); bottom = Math.min(bottom, y); top = Math.max(top, y) }
  if (right < minX || left > maxX || top < minY || bottom > maxY) continue
  const clipped = polygonClipping.intersection([feature.geometry.coordinates], board)
  if (!clipped.length) continue
  inputVertices += vertices(clipped)
  pieces.push(clipped)
}
console.log(JSON.stringify({ material, pieces: pieces.length, inputVertices, clippingSeconds: Math.round((performance.now() - start) / 10) / 100 }))
const productionUnion = mode === '--production-union' || mode === '--production-mesh'
const united = productionUnion
  ? (await import('../src/utils/texturePolygon.ts')).texturePolygon.union(...pieces)
  : polygonClipping.union(...pieces)
console.log(JSON.stringify({ material, outputPolygons: united.length, outputVertices: vertices(united),
  inputAreaMm2: pieces.reduce((sum, piece) => sum + area(piece), 0), outputAreaMm2: area(united),
  totalSeconds: Math.round((performance.now() - start) / 10) / 100, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), productionUnion }))
if (mode === '--mesh' || mode === '--production-mesh') {
  const { createServer } = await import('vite')
  const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
  try {
    const { extrudeTexturePartition } = await server.ssrLoadModule('/src/utils/textureRegionExtrusion.ts')
    const asRegions = multi => multi.map(rings => ({ outer: rings[0].slice(0, -1), holes: rings.slice(1).map(ring => ring.slice(0, -1)) }))
    for (const [label, polygons] of [['before', pieces.flat()], ['after', united]]) {
      const meshStart = performance.now()
      try {
        const result = extrudeTexturePartition(asRegions(polygons), 0, 0.08)
        const edges = new Map()
        for (let i = 0; i < result.triangles.length; i += 3) for (let j = 0; j < 3; j++) {
          const a = result.triangles[i + j], b = result.triangles[i + (j + 1) % 3]
          const key = a < b ? `${a}:${b}` : `${b}:${a}`
          edges.set(key, (edges.get(key) ?? 0) + 1)
        }
        console.log(JSON.stringify({ label, material, triangles: result.triangles.length / 3,
          badEdges: [...edges.values()].filter(count => count !== 2).length,
          meshSeconds: Math.round((performance.now() - meshStart) / 10) / 100 }))
      } catch (error) {
        console.log(JSON.stringify({ label, material, error: error instanceof Error ? error.message : String(error),
          meshSeconds: Math.round((performance.now() - meshStart) / 10) / 100 }))
      }
    }
  } finally { await server.close() }
}
