import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: projectRoot, appType: 'custom', server: { middlewareMode: true } })

const round = value => Math.round(value * 1e8) / 1e8
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const polygonArea = points => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]
  return sum + point.x * next.y - next.x * point.y
}, 0)) / 2
const signature = primitive => JSON.stringify(primitive, (_, value) => typeof value === 'number' ? round(value) : value)

try {
  const {
    createDefaultTexturePattern,
    generateTexturePattern,
    renderTexturePatternToContext,
    texturePatternCellHash,
  } = await server.ssrLoadModule('/src/utils/texturePatterns.ts')

  const bounds = { minX: -37, minY: -23, width: 220, height: 180 }
  for (const id of ['square', 'triangle', 'hexagon', 'truchet-arcs']) {
    const config = { ...createDefaultTexturePattern(id), seed: 0x1234abcd }
    const first = generateTexturePattern(config, bounds)
    const second = generateTexturePattern(config, bounds)
    assert.deepEqual(first, second, `${id} must be deterministic for the same seed and bounds`)
    assert.ok(first.primitives.length > 0, `${id} must produce visible primitives`)
    assert.equal(new Set(first.primitives.map(item => item.key)).size, first.primitives.length,
      `${id} must not emit duplicate stable keys`)
    assert.equal(first.stats.capped, false, `${id} default generation should not hit its safety cap`)
  }

  assert.equal(texturePatternCellHash(17, -4, 9), texturePatternCellHash(17, -4, 9), 'cell hash must be stable')
  assert.notEqual(texturePatternCellHash(17, -4, 9), texturePatternCellHash(18, -4, 9), 'seed must affect cell hash')

  // Crop invariance: every primitive generated for the smaller viewport keeps the
  // same world-cell key and geometry when it is also present in the larger viewport.
  const largeBounds = { minX: -120, minY: -90, width: 360, height: 300 }
  const cropBounds = { minX: -20, minY: -10, width: 110, height: 80 }
  for (const id of ['square', 'triangle', 'hexagon', 'truchet-arcs']) {
    const config = { ...createDefaultTexturePattern(id), seed: 991827 }
    const large = new Map(generateTexturePattern(config, largeBounds).primitives.map(item => [item.key, signature(item)]))
    const crop = generateTexturePattern(config, cropBounds).primitives
    for (const primitive of crop) {
      assert.equal(large.get(primitive.key), signature(primitive), `${id} crop changed ${primitive.key}`)
    }
  }

  const squareSize = 14
  const square = generateTexturePattern({ ...createDefaultTexturePattern('square'), cellSizeMm: squareSize }, bounds)
    .primitives.find(item => item.kind === 'polygon')
  assert.ok(square)
  assert.equal(square.points.length, 4)
  assert.deepEqual(square.points.map((point, index) => round(distance(point, square.points[(index + 1) % 4]))),
    Array(4).fill(squareSize), 'square edges must equal cellSizeMm')
  assert.equal(round(polygonArea(square.points)), squareSize ** 2)

  const triangleSize = 18
  const triangle = generateTexturePattern({ ...createDefaultTexturePattern('triangle'), cellSizeMm: triangleSize }, bounds)
    .primitives.find(item => item.kind === 'polygon')
  assert.ok(triangle)
  assert.equal(triangle.points.length, 3)
  assert.deepEqual(triangle.points.map((point, index) => round(distance(point, triangle.points[(index + 1) % 3]))),
    Array(3).fill(triangleSize), 'triangle edges must be equilateral')
  assert.equal(round(polygonArea(triangle.points)), round(Math.sqrt(3) / 4 * triangleSize ** 2))

  const hexagonSize = 11
  const hexagon = generateTexturePattern({ ...createDefaultTexturePattern('hexagon'), cellSizeMm: hexagonSize }, bounds)
    .primitives.find(item => item.kind === 'polygon')
  assert.ok(hexagon)
  assert.equal(hexagon.points.length, 6)
  assert.deepEqual(hexagon.points.map((point, index) => round(distance(point, hexagon.points[(index + 1) % 6]))),
    Array(6).fill(hexagonSize), 'hexagon edges must equal its circumradius')
  assert.equal(round(polygonArea(hexagon.points)), round(3 * Math.sqrt(3) / 2 * hexagonSize ** 2))

  const truchetConfig = { ...createDefaultTexturePattern('truchet-arcs'), seed: 72491, cellSizeMm: 20 }
  const truchet = generateTexturePattern(truchetConfig, { minX: 0, minY: 0, width: 200, height: 200 })
  assert.ok(truchet.primitives.every(item => item.kind === 'arc'))
  assert.ok(truchet.primitives.every(item => round(item.radius) === 10), 'Truchet radius must be half a cell')
  const changed = generateTexturePattern({ ...truchetConfig, seed: 72492 }, { minX: 0, minY: 0, width: 200, height: 200 })
  const currentByKey = new Map(truchet.primitives.map(item => [item.key, signature(item)]))
  const changedCount = changed.primitives.filter(item => currentByKey.get(item.key) !== signature(item)).length
  assert.ok(changedCount > truchet.primitives.length * 0.2, 'changing the Truchet seed should visibly change orientations')
  assert.equal(truchet.stats.periodicity, 'seeded-stochastic')

  const drawCalls = []
  const fakeContext = new Proxy({
    imageSmoothingEnabled: true,
    save() {}, restore() {}, beginPath() {}, closePath() {},
    setTransform() {}, clearRect() {}, fillRect() {}, translate() {}, scale() {},
    moveTo() {}, lineTo() {}, fill() { drawCalls.push('fill') },
    stroke() { drawCalls.push('stroke') }, arc() { drawCalls.push('arc') },
  }, {
    set(target, property, value) { target[property] = value; return true },
  })
  const rendered = renderTexturePatternToContext(fakeContext, 512, 384, truchetConfig,
    { minX: 0, minY: 0, width: 160, height: 120 })
  assert.equal(rendered.stats.primitiveCount, drawCalls.filter(call => call === 'stroke').length)
  assert.equal(rendered.stats.primitiveCount, drawCalls.filter(call => call === 'arc').length)
  assert.equal(fakeContext.imageSmoothingEnabled, false, 'mathematical patterns must disable bitmap smoothing')

  const capped = generateTexturePattern({
    ...createDefaultTexturePattern('square'), cellSizeMm: 1, maxPrimitives: 37,
  }, { minX: 0, minY: 0, width: 1000, height: 1000 })
  assert.equal(capped.primitives.length, 37)
  assert.equal(capped.stats.capped, true)

  const performanceBounds = { minX: 0, minY: 0, width: 440, height: 440 }
  for (const id of ['square', 'triangle', 'hexagon', 'truchet-arcs']) {
    const started = performance.now()
    const result = generateTexturePattern({
      ...createDefaultTexturePattern(id), seed: 0xdecafbad, cellSizeMm: 6,
    }, performanceBounds)
    const elapsed = performance.now() - started
    assert.ok(result.primitives.length < 50_000, `${id} exceeded the phase-one primitive budget`)
    assert.ok(elapsed < 1000, `${id} generation took ${elapsed.toFixed(1)}ms`)
    console.log(`${id.padEnd(13)} ${String(result.primitives.length).padStart(6)} primitives · ${elapsed.toFixed(1)}ms`)
  }

  console.log('Texture pattern geometry verification passed')
} finally {
  await server.close()
}
