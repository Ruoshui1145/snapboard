import fs from 'node:fs'
import path from 'node:path'

const source = process.argv[2]
if (!source) throw new Error('用法: node scripts/analyze-edge-dxf.mjs <file.dxf>')
const absolute = path.resolve(source)
const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)
const pairs = []
for (let index = 0; index + 1 < lines.length; index += 2) {
  const code = Number.parseInt(lines[index].trim(), 10)
  if (!Number.isFinite(code)) continue
  pairs.push({ code, value: lines[index + 1].trim() })
}

const entities = []
let section = ''
let current = null
for (let index = 0; index < pairs.length; index++) {
  const pair = pairs[index]
  if (pair.code === 0 && pair.value === 'SECTION' && pairs[index + 1]?.code === 2) {
    section = pairs[index + 1].value
    index++
    continue
  }
  if (pair.code === 0 && pair.value === 'ENDSEC') {
    if (current) entities.push(current)
    current = null
    section = ''
    continue
  }
  if (section !== 'ENTITIES') continue
  if (pair.code === 0) {
    if (current) entities.push(current)
    current = { type: pair.value, pairs: [] }
  } else if (current) current.pairs.push(pair)
}
if (current) entities.push(current)

const first = (entity, code, fallback = undefined) => {
  const value = entity.pairs.find(pair => pair.code === code)?.value
  if (value === undefined) return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}
const layer = entity => String(first(entity, 8, '0'))
const point = (entity, xCode, yCode) => ({
  x: Number(first(entity, xCode, 0)),
  y: Number(first(entity, yCode, 0)),
})
const round = value => Math.round(value * 10000) / 10000
const pointsOf = entity => {
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') return [point(entity, 10, 20)]
  if (entity.type === 'LINE') return [point(entity, 10, 20), point(entity, 11, 21)]
  if (entity.type === 'LWPOLYLINE') {
    const xs = entity.pairs.filter(pair => pair.code === 10).map(pair => Number(pair.value))
    const ys = entity.pairs.filter(pair => pair.code === 20).map(pair => Number(pair.value))
    return xs.map((x, index) => ({ x, y: ys[index] ?? 0 }))
  }
  return []
}

const counts = {}
const layers = {}
for (const entity of entities) {
  counts[entity.type] = (counts[entity.type] ?? 0) + 1
  const name = layer(entity)
  layers[name] ??= {}
  layers[name][entity.type] = (layers[name][entity.type] ?? 0) + 1
}
const allPoints = entities.flatMap(pointsOf)
const bbox = allPoints.length ? {
  minX: round(Math.min(...allPoints.map(item => item.x))),
  minY: round(Math.min(...allPoints.map(item => item.y))),
  maxX: round(Math.max(...allPoints.map(item => item.x))),
  maxY: round(Math.max(...allPoints.map(item => item.y))),
} : null
const circles = entities.filter(entity => entity.type === 'CIRCLE').map(entity => ({
  layer: layer(entity),
  ...Object.fromEntries(Object.entries(point(entity, 10, 20)).map(([key, value]) => [key, round(value)])),
  r: round(Number(first(entity, 40, 0))),
})).sort((a, b) => a.y - b.y || a.x - b.x)
const arcs = entities.filter(entity => entity.type === 'ARC').map(entity => ({
  layer: layer(entity),
  ...Object.fromEntries(Object.entries(point(entity, 10, 20)).map(([key, value]) => [key, round(value)])),
  r: round(Number(first(entity, 40, 0))),
  start: round(Number(first(entity, 50, 0))),
  end: round(Number(first(entity, 51, 0))),
})).sort((a, b) => a.y - b.y || a.x - b.x)

if (process.argv.includes('--compact')) {
  const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance
  const slotBottoms = arcs.filter(arc => near(arc.r, 2.5) && near(((arc.start % 360) + 360) % 360, 180))
  const slotCenters = slotBottoms.flatMap(bottom => {
    const top = arcs.find(arc => near(arc.r, 2.5) && near(arc.x, bottom.x) &&
      near(arc.y, bottom.y + 10) && near(((arc.end % 360) + 360) % 360, 180))
    return top ? [{ x: round(bottom.x), y: round((bottom.y + top.y) / 2) }] : []
  }).sort((a, b) => a.y - b.y || a.x - b.x)
  const boardOrigins = arcs
    .filter(arc => near(arc.r, 8) && near(((arc.start % 360) + 360) % 360, 180) && near(arc.end, 270))
    .map(arc => ({ x: round(arc.x - 8), y: round(arc.y - 8) }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const boards = boardOrigins.map((origin, index) => {
    const localCircles = circles
      .filter(circle => circle.x >= origin.x - 1e-3 && circle.x <= origin.x + 200 + 1e-3 &&
        circle.y >= origin.y - 1e-3 && circle.y <= origin.y + 200 + 1e-3)
      .map(circle => ({ x: round(circle.x - origin.x), y: round(circle.y - origin.y), r: circle.r }))
    const localSlots = slotCenters
      .filter(slot => slot.x >= origin.x - 1e-3 && slot.x <= origin.x + 200 + 1e-3 &&
        slot.y >= origin.y - 1e-3 && slot.y <= origin.y + 200 + 1e-3)
      .map(slot => ({ x: round(slot.x - origin.x), y: round(slot.y - origin.y) }))
    return { id: index + 1, origin, circles: localCircles, slots: localSlots }
  })
  console.log(JSON.stringify({ file: absolute, counts, layers, boardOrigins, boards }, null, 2))
} else {
  console.log(JSON.stringify({ file: absolute, counts, layers, bbox, circles, arcs }, null, 2))
}
