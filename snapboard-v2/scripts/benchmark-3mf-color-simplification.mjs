// Read-only: node scripts/benchmark-3mf-color-simplification.mjs input.3mf 7
import { createReadStream } from 'node:fs'
import { Unzip, UnzipInflate } from 'fflate'
import sax from 'sax'
import { MeshoptSimplifier } from 'meshoptimizer/simplifier'

const [input, selectedIdText] = process.argv.slice(2)
if (!input || !selectedIdText) throw new Error('Pass a 3MF path and a part ID')
const selectedId = String(Number(selectedIdText))
const readPart = () => new Promise((resolve, reject) => {
  const positions = [], indices = []
  const parser = sax.parser(true)
  const source = createReadStream(input, { highWaterMark: 256 * 1024 })
  let target = false, done = false
  parser.onopentag = node => {
    if (node.name === 'object') target = node.attributes.id === selectedId
    if (!target) return
    if (node.name === 'vertex') positions.push(+node.attributes.x, +node.attributes.y, +node.attributes.z)
    if (node.name === 'triangle') indices.push(+node.attributes.v1, +node.attributes.v2, +node.attributes.v3)
  }
  parser.onclosetag = name => {
    if (name !== 'object' || !target || done) return
    done = true
    target = false
    source.destroy()
    resolve({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) })
  }
  const unzip = new Unzip(file => {
    if (file.name !== '3D/Objects/object_1.model') { file.terminate(); return }
    file.ondata = (error, chunk) => {
      if (error && !done) { done = true; source.destroy(); reject(error); return }
      if (!done && chunk?.length) try { parser.write(Buffer.from(chunk)) }
      catch (cause) { done = true; source.destroy(); reject(cause) }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  source.on('data', chunk => { if (!done) try { unzip.push(new Uint8Array(chunk)) } catch (error) { done = true; source.destroy(); reject(error) } })
  source.on('error', error => { if (!done) { done = true; reject(error) } })
  source.on('end', () => { if (!done) reject(new Error(`Part ${selectedId} was not found`)) })
})

const stats = (indices, positions) => {
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

const start = performance.now()
const { positions, indices } = await readPart()
console.log(JSON.stringify({ partId: selectedId, readMs: Math.round(performance.now() - start),
  vertices: positions.length / 3, triangles: indices.length / 3 }))
await MeshoptSimplifier.ready
const before = stats(indices, positions)
for (const errorMm of [0.025, 0.05, 0.1]) {
  const t = performance.now()
  const [result, actualError] = MeshoptSimplifier.simplify(indices, positions, 3,
    Math.max(12, Math.floor(indices.length * 0.1 / 3) * 3), errorMm, ['ErrorAbsolute'])
  const after = stats(result, positions)
  console.log(JSON.stringify({ targetErrorMm: errorMm, actualErrorMm: actualError,
    originalFaces: indices.length / 3, simplifiedFaces: result.length / 3,
    badEdgesBefore: before.badEdges, badEdgesAfter: after.badEdges,
    volumeDeltaPercent: Math.abs((after.volumeMm3 - before.volumeMm3) / before.volumeMm3) * 100,
    simplifyMs: Math.round(performance.now() - t) }))
}
