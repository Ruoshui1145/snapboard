import assert from 'node:assert/strict'
import {checkModule} from './check-module.mjs'
const presets=await checkModule('src/features/shapeLibrary/presets/index.ts')
const EPSILON = 1e-7

const signedArea = points => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]
  return sum + point.x * next.y - next.x * point.y
}, 0) / 2

const orientation = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const onSegment = (a, b, point) =>
  Math.min(a.x, b.x) - EPSILON <= point.x && point.x <= Math.max(a.x, b.x) + EPSILON &&
  Math.min(a.y, b.y) - EPSILON <= point.y && point.y <= Math.max(a.y, b.y) + EPSILON
const segmentsIntersect = (a, b, c, d) => {
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  if (o1 * o2 < -EPSILON && o3 * o4 < -EPSILON) return true
  if (Math.abs(o1) <= EPSILON && onSegment(a, b, c)) return true
  if (Math.abs(o2) <= EPSILON && onSegment(a, b, d)) return true
  if (Math.abs(o3) <= EPSILON && onSegment(c, d, a)) return true
  if (Math.abs(o4) <= EPSILON && onSegment(c, d, b)) return true
  return false
}

const assertSimplePolygon = (id, points) => {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length
      if (first === second || firstNext === second || secondNext === first) continue
      assert.ok(
        !segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext]),
        `${id} has a self-intersection between edges ${first} and ${second}`,
      )
    }
  }
}

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= EPSILON * Math.max(1, Math.abs(expected)), `${message}: ${actual} !== ${expected}`)

const verifyShape = (definition, input = {}) => {
  const shape = definition.generate(input)
  assert.equal(shape.presetId, definition.id)
  assert.equal(shape.closed, true, `${definition.id} must be closed`)
  assert.ok(shape.points.length >= 3 && shape.points.length <= 512, `${definition.id} point count is not controlled: ${shape.points.length}`)
  assert.ok(shape.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), `${definition.id} contains a non-finite point`)
  assert.ok(shape.arcs.every(arc => Number.isFinite(arc.radius) && Number.isFinite(arc.center.x) && Number.isFinite(arc.center.y)), `${definition.id} contains a non-finite arc`)

  for (let index = 0; index < shape.points.length; index += 1) {
    const point = shape.points[index]
    const next = shape.points[(index + 1) % shape.points.length]
    assert.ok(Math.hypot(point.x - next.x, point.y - next.y) > EPSILON, `${definition.id} has duplicate adjacent points at ${index}`)
  }
  assert.ok(signedArea(shape.points) > EPSILON, `${definition.id} has zero or inconsistent signed area`)
  assertSimplePolygon(definition.id, shape.points)
  close(shape.bounds.width, shape.params.width, `${definition.id} width`)
  close(shape.bounds.height, shape.params.height, `${definition.id} height`)
  close(shape.bounds.minX, -shape.params.width / 2, `${definition.id} minX`)
  close(shape.bounds.maxX, shape.params.width / 2, `${definition.id} maxX`)
  close(shape.bounds.minY, -shape.params.height / 2, `${definition.id} minY`)
  close(shape.bounds.maxY, shape.params.height / 2, `${definition.id} maxY`)
  return shape
}

assert.deepEqual(presets.SHAPE_PRESETS.map(definition => definition.id), presets.SHAPE_PRESET_IDS)
assert.equal(presets.SHAPE_PRESETS.length, 13)

const report = {}
for (const definition of presets.SHAPE_PRESETS) {
  const base = verifyShape(definition)
  const resized = verifyShape(definition, { width: 517, height: 263, detail: 1, smoothing: 0.2 })
  const flipped = verifyShape(definition, { width: 311, height: 197, flipX: true, flipY: true, detail: 0 })
  const locked = verifyShape(definition, { width: 360, height: 999, lockAspect: true })
  close(locked.params.height, 360 / definition.nativeAspectRatio, `${definition.id} locked height`)
  assert.deepEqual(definition.generate(), base, `${definition.id} generation must be deterministic`)
  report[definition.id] = {
    defaultSize: `${base.params.width}x${base.params.height}`,
    points: `${flipped.points.length}-${resized.points.length}`,
    area: Number(signedArea(base.points).toFixed(2)),
  }
}

assert.throws(() => presets.generatePreset('cloud', { width: 0 }), /positive/)
assert.throws(() => presets.generatePreset('cloud', { height: Number.NaN }), /positive/)

console.log(JSON.stringify({ presets: report, checks: ['finite', 'closed', 'area', 'bounds', 'duplicates', 'simple-polygon', 'deterministic'] }, null, 2))
