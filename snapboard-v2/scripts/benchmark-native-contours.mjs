import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const [path, pitchArg, mode] = process.argv.slice(2)
const pitch = Number(pitchArg)
if (!path || !Number.isFinite(pitch) || pitch <= 0) throw new Error('Usage: benchmark-native-contours.mjs <bottom-up-int16-grid> <pitch-mm>')
const width = Math.ceil(580 / pitch) + 1
const height = Math.ceil(920 / pitch) + 1
const bytes = readFileSync(path)
if (bytes.byteLength !== width * height * 2) throw new Error(`Unexpected raster size ${bytes.byteLength}; expected ${width * height * 2}`)
const materials = new Int16Array(bytes.buffer, bytes.byteOffset, width * height)
const xBoundaries = Float64Array.from({ length: width + 1 }, (_, i) => -290 + i * pitch)
const yBoundaries = Float64Array.from({ length: height + 1 }, (_, i) => -460 + i * pitch)
const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { buildTextureRegionContours } = await server.ssrLoadModule('/src/utils/textureRegionContours.ts')
  const start = performance.now()
  const result = buildTextureRegionContours({
    materials, width, height, xBoundaries, yBoundaries,
    toleranceMm: Math.min(0.05, pitch * 0.1),
    maxBoundaryEdges: 5_000_000,
  })
  console.log(JSON.stringify({ pitchMm: pitch, raster: [width, height], elapsedSeconds: Math.round((performance.now() - start) / 10) / 100, diagnostics: result.diagnostics, regions: [...result.regions.values()].reduce((n, regions) => n + regions.length, 0), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }))
  if (mode === '--extrude') {
    const { extrudeTexturePartition } = await server.ssrLoadModule('/src/utils/textureRegionExtrusion.ts')
    const meshStart = performance.now()
    let totalFaces = 0
    for (const [material, polygons] of result.regions) {
      const part = extrudeTexturePartition(polygons, 0, 0.08)
      totalFaces += part.triangles.length / 3
      console.log(JSON.stringify({ material, regions: polygons.length, faces: part.triangles.length / 3,
        elapsedSeconds: Math.round((performance.now() - meshStart) / 10) / 100, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }))
    }
    console.log(JSON.stringify({ totalFaces, elapsedSeconds: Math.round((performance.now() - meshStart) / 10) / 100 }))
  }
} finally {
  await server.close()
}
