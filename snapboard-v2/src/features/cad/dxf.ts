import type { ArcEntity, Contour, Point2D } from '../../types/geometry'
import { arcSpan } from '../../utils/arc'
import { firstSelfIntersection, pointInRing, ringsIntersect, signedArea } from '../shapeLibrary/import/geometry'

type Pair = [number, string]
export type CadRole = 'outer' | 'inner' | 'construction' | 'skip'
export interface CadPath { contour: Contour; layer: string; role: CadRole; valid: boolean; issue?: string; preview: Point2D[] }
export interface CadDrawing { paths: CadPath[]; unit: number; warnings: string[] }
const units: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 9: .0254, 10: 914.4, 13: .001, 14: 100, 15: 10000 }
export const dxfUnitScale = (unit: number) => units[unit]
const near = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-8
interface Edge { a: Point2D; b: Point2D; arc?: Omit<ArcEntity, 'p1' | 'p2'>; layer: string }

/** ASCII DXF only. Unsupported entities are explicitly reported, never traced or flattened. */
export function parseCadDxf(text: string): CadDrawing {
  if (text.length > 12_000_000) throw new Error('DXF exceeds 12 MB')
  if (text.includes('\0')) throw new Error('Binary DXF is not supported. Export ASCII DXF.')
  const lines = text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/)
  if (lines.length % 2) throw new Error('Invalid DXF code/value pairs')
  const pairs: Pair[] = []
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim())
    if (!Number.isInteger(code) || !lines[i].trim()) throw new Error('Invalid DXF group code')
    pairs.push([code, lines[i + 1].trim()])
  }
  if (!pairs.some(([c, v]) => c === 0 && v === 'EOF')) throw new Error('Incomplete DXF: missing EOF')
  let unit = 0
  const unitIndex = pairs.findIndex(([c, v]) => c === 9 && v === '$INSUNITS')
  if (unitIndex >= 0 && pairs[unitIndex + 1]?.[0] === 70) unit = Number(pairs[unitIndex + 1][1])
  const paths: CadPath[] = [], edges: Edge[] = [], warnings = new Set<string>()
  let serial = 0
  const id = () => `cad-${++serial}`
  const add = (points: Point2D[], closed: boolean, layer: string, arcs: ArcEntity[] = [], circle?: { center: Point2D; radius: number }) => {
    const finitePoint = (p: Point2D) => Number.isFinite(p.x) && Number.isFinite(p.y)
    if (points.some(p => !finitePoint(p)) || arcs.some(a => !finitePoint(a.center) || !Number.isFinite(a.radius) || a.radius <= 0)) throw new Error('Invalid or numerically unstable geometry')
    const contour: Contour = { id: id(), name: `${layer} · ${serial}`, points, closed, arcs, type: 'outer', constraints: [], geometryLocked: true, ...(circle ? { shape: 'circle' as const, ...circle } : {}) }
    const preview: Point2D[] = []
    if (circle) {
      for (let i = 0; i < 128; i++) preview.push({ x: circle.center.x + circle.radius * Math.cos(i * Math.PI / 64), y: circle.center.y + circle.radius * Math.sin(i * Math.PI / 64) })
    } else {
      points.forEach((p, i) => {
        preview.push(p)
        const arc = arcs.find(a => a.p1 === i)
        if (!arc) return
        const span = arcSpan(arc.center, p, points[arc.p2], arc.sweep)
        const start = Math.atan2(p.y - arc.center.y, p.x - arc.center.x)
        const count = Math.max(2, Math.ceil(span / (Math.PI / 128)))
        for (let j = 1; j < count; j++) {
          const angle = start + (arc.sweep === 'cw' ? -1 : 1) * span * j / count
          preview.push({ x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) })
        }
      })
    }
    if (preview.length > 2048 || paths.reduce((n, p) => n + p.preview.length, preview.length) > 12000) throw new Error('Drawing too complex: split into smaller DXF files')
    const valid = closed && preview.length >= 3 && Math.abs(signedArea(preview)) > 1e-10 && !firstSelfIntersection(preview)
    paths.push({ contour, preview, layer, valid, role: valid ? 'outer' : 'construction', issue: valid ? undefined : closed ? 'Invalid or self-intersecting outline — auxiliary only' : 'Open path — auxiliary only' })
  }
  const poly = (vertices: { p: Point2D; bulge: number }[], closed: boolean, layer: string) => {
    if (vertices.length > 2000) throw new Error('Polyline exceeds 2000 vertices')
    if (vertices.length < 2) throw new Error('Polyline has too few vertices')
    const points = vertices.map(v => v.p), arcs: ArcEntity[] = []
    if (closed && near(points[0], points[points.length - 1])) { points.pop(); vertices = vertices.slice(0, -1) }
    for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
      const a = points[i], b = points[(i + 1) % points.length], bulge = vertices[i].bulge
      if (near(a, b)) throw new Error('Zero-length polyline edge')
      if (!bulge) continue
      const dx = b.x - a.x, dy = b.y - a.y
      // Input Y is already inverted, so the DXF left normal becomes the right normal.
      const k = (1 - bulge * bulge) / (4 * bulge)
      const center = { x: (a.x + b.x) / 2 + dy * k, y: (a.y + b.y) / 2 - dx * k }
      arcs.push({ id: id(), p1: i, p2: (i + 1) % points.length, center, radius: Math.hypot(a.x - center.x, a.y - center.y), sweep: bulge > 0 ? 'cw' : 'ccw' })
    }
    if (closed) add(points, true, layer, arcs)
    else for (let i = 0; i < points.length - 1; i++) edges.push({ a: points[i], b: points[i + 1], layer, arc: arcs.find(a => a.p1 === i) })
  }
  let section = '', legacy: { layer: string; closed: boolean; vertices: { p: Point2D; bulge: number }[] } | null = null
  for (let i = 0; i < pairs.length;) {
    if (pairs[i][0] !== 0) { i++; continue }
    const type = pairs[i++][1], data: Pair[] = []
    while (i < pairs.length && pairs[i][0] !== 0) data.push(pairs[i++])
    const str = (code: number, fallback = '') => data.find(p => p[0] === code)?.[1] ?? fallback
    const num = (code: number, fallback?: number) => {
      const value = str(code, fallback === undefined ? '' : String(fallback))
      if (value === '' || !Number.isFinite(Number(value))) throw new Error(`${type}: invalid/missing group ${code}`)
      if (Math.abs(Number(value)) > 1e12) throw new Error(`${type}: numeric value exceeds supported range`)
      return Number(value)
    }
    if (type === 'SECTION') { section = str(2); continue }
    if (type === 'ENDSEC') { section = ''; continue }
    if (section !== 'ENTITIES') continue
    if (paths.length + edges.length > 2000) throw new Error('DXF exceeds 2000 geometry entities')
    const layer = str(8, '0')
    if (num(67, 0) !== 0) { warnings.add('Paper-space entities excluded'); continue }
    if (['TEXT', 'MTEXT', 'DIMENSION', 'LEADER', 'HATCH', 'POINT'].includes(type)) { warnings.add(`${type}: annotation/fill excluded (not manufacturing geometry)`); continue }
    if (!['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'SEQEND'].includes(type)) { warnings.add(`${type}: unsupported; export/explode to lines, arcs or polylines in CAD`); continue }
    if (num(210, 0) !== 0 || num(220, 0) !== 0 || num(230, 1) !== 1 || num(30, 0) !== 0 || num(31, 0) !== 0 || num(38, 0) !== 0) throw new Error(`${type}: only the XY plane at Z=0 is supported`)
    const point = (x: number, y: number) => ({ x: num(x), y: -num(y) })
    if (type === 'POLYLINE') { if (num(70, 0) & ~1) throw new Error('Only ordinary 2D POLYLINE is supported'); legacy = { layer, closed: !!(num(70, 0) & 1), vertices: [] }; continue }
    if (type === 'VERTEX') { if (!legacy) throw new Error('Orphan VERTEX'); legacy.vertices.push({ p: point(10, 20), bulge: num(42, 0) }); continue }
    if (type === 'SEQEND') { if (legacy) poly(legacy.vertices, legacy.closed, legacy.layer); legacy = null; continue }
    if (type === 'LINE') { const a = point(10, 20), b = point(11, 21); if (near(a, b)) throw new Error('Zero-length LINE'); edges.push({ a, b, layer }); continue }
    if (type === 'CIRCLE' || type === 'ARC') {
      const center = point(10, 20), radius = num(40)
      if (radius <= 0) throw new Error('Invalid radius')
      const at = (a: number) => ({ x: center.x + radius * Math.cos(a * Math.PI / 180), y: center.y - radius * Math.sin(a * Math.PI / 180) })
      if (type === 'CIRCLE') add([at(0), at(90), at(180), at(270)], true, layer, [], { center, radius })
      else { const a = at(num(50)), b = at(num(51)); if (near(a, b)) throw new Error('Ambiguous full-circle ARC'); edges.push({ a, b, layer, arc: { id: id(), center, radius, sweep: 'cw' } }) }
      continue
    }
    if (type === 'LWPOLYLINE') {
      if (data.some(([code, value]) => [40, 41, 43].includes(code) && Number(value) !== 0)) warnings.add('Polyline stroke widths excluded; centerline geometry only')
      const vertices: { p: Point2D; bulge: number }[] = []
      for (const [code, value] of data) {
        if (![10, 20, 42].includes(code)) continue
        const n = Number(value); if (!Number.isFinite(n)) throw new Error('Invalid polyline coordinate')
        if (code === 10) vertices.push({ p: { x: n, y: NaN }, bulge: 0 })
        else { const v = vertices.at(-1); if (!v) throw new Error('Invalid polyline vertex'); if (code === 20) v.p.y = -n; else v.bulge = n }
      }
      if (vertices.length !== num(90) || vertices.some(v => !Number.isFinite(v.p.y))) throw new Error('Invalid polyline vertex count')
      poly(vertices, !!(num(70, 0) & 1), layer)
    }
  }
  if (legacy) throw new Error('Incomplete POLYLINE')
  // Join only degree-two endpoint chains on the same layer; never bridge a gap or branch.
  const seenLines = new Set<string>()
  const uniqueEdges = edges.filter(edge => {
    if (edge.arc) return true
    const a = `${edge.a.x},${edge.a.y}`, b = `${edge.b.x},${edge.b.y}`
    const key = `${edge.layer}\0${a < b ? `${a}|${b}` : `${b}|${a}`}`
    if (seenLines.has(key)) { warnings.add('Duplicate line entities excluded'); return false }
    seenLines.add(key)
    return true
  })
  const available = new Set(uniqueEdges)
  while (available.size) {
    const seed = available.values().next().value as Edge
    available.delete(seed)
    const chain: Edge[] = [seed]
    const extend = () => {
      while (true) {
        const end = chain[chain.length - 1].b
        const all = uniqueEdges.filter(e => e.layer === seed.layer && (near(e.a, end) || near(e.b, end)))
        const candidates = all.filter(e => available.has(e))
        if (all.length !== 2 || candidates.length !== 1) break
        const e = candidates[0]; available.delete(e)
        chain.push(near(e.a, end) ? e : { ...e, a: e.b, b: e.a, arc: e.arc ? { ...e.arc, sweep: e.arc.sweep === 'cw' ? 'ccw' : 'cw' } : undefined })
      }
    }
    extend()
    if (!near(chain[0].a, chain[chain.length - 1].b)) {
      chain.reverse(); for (let j = 0; j < chain.length; j++) { const e = chain[j]; chain[j] = { ...e, a: e.b, b: e.a, arc: e.arc ? { ...e.arc, sweep: e.arc.sweep === 'cw' ? 'ccw' : 'cw' } : undefined } }
      extend()
    }
    const closed = near(chain[0].a, chain[chain.length - 1].b)
    const points = chain.map(e => e.a); if (!closed) points.push(chain[chain.length - 1].b)
    add(points, closed, seed.layer, chain.flatMap((e, j) => e.arc ? [{ ...e.arc, p1: j, p2: (j + 1) % points.length }] : []))
  }
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const a = paths[i], b = paths[j]
    if (a.valid && b.valid && ringsIntersect(a.preview, b.preview)) {
      a.role = b.role = 'construction'; a.valid = b.valid = false
      a.issue = b.issue = 'Intersecting/touching outlines — auxiliary only'
    }
  }
  for (const p of paths.filter(p => p.valid)) {
    const depth = paths.filter(q => q !== p && q.valid && Math.abs(signedArea(q.preview)) > Math.abs(signedArea(p.preview)) && pointInRing(p.preview[0], q.preview)).length
    p.role = depth % 2 ? 'inner' : 'outer'
  }
  if (!paths.length) throw new Error(`No supported geometry. ${[...warnings].join('; ')}`)
  return { paths, unit, warnings: [...warnings] }
}

export function cadContours(drawing: CadDrawing, mmPerUnit: number, pixelToMM: number, fileName: string): Contour[] {
  if (![mmPerUnit, pixelToMM].every(n => Number.isFinite(n) && n > 0)) throw new Error('Confirm valid drawing units')
  const scale = mmPerUnit / pixelToMM, batch = crypto.randomUUID()
  const point = (p: Point2D) => ({ x: p.x * scale, y: p.y * scale })
  if (drawing.paths.some(p => p.preview.some(v => !Number.isFinite(v.x * scale) || !Number.isFinite(v.y * scale)))) throw new Error('Coordinates overflow after unit conversion')
  return drawing.paths.filter(p => p.role !== 'skip').map((p, i) => {
    if (!p.valid && p.role !== 'construction') throw new Error('Invalid/open paths must remain auxiliary')
    return { ...p.contour, id: `${batch}-${i}`, type: p.role === 'inner' ? 'inner' : 'outer', construction: p.role === 'construction', points: p.contour.points.map(point), center: p.contour.center ? point(p.contour.center) : undefined, radius: p.contour.radius === undefined ? undefined : p.contour.radius * scale, arcs: p.contour.arcs?.map((a, j) => ({ ...a, id: `${batch}-${i}-arc-${j}`, center: point(a.center), radius: a.radius * scale })), source: { kind: 'dxf', fileName, params: { layer: p.layer, mmPerUnit, cadValid: p.valid } } }
  })
}
