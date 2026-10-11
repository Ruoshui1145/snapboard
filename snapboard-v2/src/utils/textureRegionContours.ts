import { ShapeUtils, Vector2 } from 'three'

export type TexturePoint = [number, number]
export interface TextureRegionPolygon { outer: TexturePoint[]; holes: TexturePoint[][] }
export interface TextureContourInput {
  materials: Int16Array
  width: number
  height: number
  xBoundaries: ArrayLike<number>
  yBoundaries: ArrayLike<number>
  toleranceMm?: number
  straightFit?: boolean
  fixedMaterials?: number[]
  /** Offline benchmark may raise this; interactive export keeps the conservative default. */
  maxBoundaryEdges?: number
}
export interface TextureContourDiagnostics {
  boundaryEdges: number
  originalVertices: number
  outputVertices: number
  movedVertices: number
  maximumDisplacementMm: number
  maximumFitErrorMm: number
  toleranceMm: number
  fallbackReason?: string
}

type Node = { point: TexturePoint; next: number[]; fixed: boolean }
type Edge = { a: number; b: number; left: number; right: number }
type FaceRing = { material: number; nodes: number[] }
const cross = (a: TexturePoint, b: TexturePoint, c: TexturePoint) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const area = (ring: TexturePoint[]) => ring.reduce((sum, a, i) => {
  const b = ring[(i + 1) % ring.length]
  return sum + a[0] * b[1] - b[0] * a[1]
}, 0) / 2
const inside = (p: TexturePoint, ring: TexturePoint[]) => {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result
  }
  return result
}

/** Trace one shared material partition; never fit each colour independently.
 * Coordinates must be increasing and include clipped final cell boundaries.
 * Empty (-1), protected materials and every multi-region junction stay fixed.
 * A simultaneous quarter-Laplacian pass and shared-chain straight fitting
 * keep every boundary within tolerance of the source grid. The cap below
 * 0.4 of minimum spacing keeps disjoint grid edges separated.
 */
export function buildTextureRegionContours(input: TextureContourInput): {
  regions: Map<number, TextureRegionPolygon[]>
  diagnostics: TextureContourDiagnostics
} {
  const { materials, width, height, xBoundaries: xs, yBoundaries: ys } = input
  const edgeBudget = input.maxBoundaryEdges ?? 300_000
  if (!Number.isInteger(edgeBudget) || edgeBudget < 1 || edgeBudget > 5_000_000) throw new Error('Invalid texture contour edge budget')
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || materials.length !== width * height || xs.length !== width + 1 || ys.length !== height + 1) throw new Error('Invalid texture contour grid')
  let spacing = Infinity
  for (const values of [xs, ys]) for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || (i && values[i] <= values[i - 1])) throw new Error('Texture contour boundaries must increase')
    if (i) spacing = Math.min(spacing, values[i] - values[i - 1])
  }
  if (!Number.isFinite(input.toleranceMm ?? 0.05) || (input.toleranceMm ?? 0.05) < 0) throw new Error('Invalid contour tolerance')
  const tolerance = Math.min(input.toleranceMm ?? 0.05, 0.05, spacing * 0.4)
  const protectedMaterials = new Set([-1, ...(input.fixedMaterials ?? [])])
  const nodes: Node[] = [], edges: Edge[] = [], byKey = new Map<number, number>()
  const node = (x: number, y: number) => {
    const key = y * (width + 1) + x
    let id = byKey.get(key)
    if (id === undefined) { id = nodes.length; byKey.set(key, id); nodes.push({ point: [xs[x], ys[y]], next: [], fixed: false }) }
    return id
  }
  const add = (ax: number, ay: number, bx: number, by: number, left: number, right: number) => {
    if (left === right) return
    if (edges.length >= edgeBudget) throw new Error('Texture contour boundary budget exceeded; use exact grid fallback')
    const a = node(ax, ay), b = node(bx, by), id = edges.length
    edges.push({ a, b, left, right }); nodes[a].next.push(id); nodes[b].next.push(id)
    if (protectedMaterials.has(left) || protectedMaterials.has(right)) nodes[a].fixed = nodes[b].fixed = true
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const m = materials[y * width + x]
    if (m < -1) throw new Error('Texture contour material must be -1 or nonnegative')
    // Upward edge: west/left cell is on its left. Rightward: north cell on left.
    add(x + 1, y, x + 1, y + 1, m, x + 1 < width ? materials[y * width + x + 1] : -1)
    add(x, y + 1, x + 1, y + 1, y + 1 < height ? materials[(y + 1) * width + x] : -1, m)
    if (!x) add(0, y, 0, y + 1, -1, m)
    if (!y) add(x, 0, x + 1, 0, m, -1)
  }
  const visited = new Uint8Array(edges.length * 2), rings: FaceRing[] = []
  const directed = (id: number) => {
    const e = edges[id >> 1]
    return (id & 1) ? { a: e.b, b: e.a, material: e.right } : { a: e.a, b: e.b, material: e.left }
  }
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || directed(start).material < 0) continue
    const chain: number[] = [], material = directed(start).material
    let current = start
    do {
      if (visited[current]) throw new Error('Texture region ring could not close')
      visited[current] = 1
      const d = directed(current), a = nodes[d.a].point, b = nodes[d.b].point
      chain.push(d.a)
      let best = -1, bestAngle = -Infinity
      for (const edgeId of nodes[d.b].next) {
        const candidate = edges[edgeId].a === d.b ? edgeId * 2 : edgeId * 2 + 1
        const out = directed(candidate)
        if (out.material !== material) continue
        const c = nodes[out.b].point
        const angle = Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]))
        if (angle > bestAngle) { best = candidate; bestAngle = angle }
      }
      if (best < 0) throw new Error('Texture region has an open boundary')
      current = best
    } while (current !== start)
    rings.push({ material, nodes: chain })
    // Single pixels and tiny islands/counters retain their exact coverage.
    if (Math.abs(area(chain.map(id => nodes[id].point))) <= spacing * spacing * 4.01) for (const id of chain) nodes[id].fixed = true
  }
  // Long straight runs on both sides identify a deliberate square corner;
  // alternating one-cell staircase turns have no such runs.
  const neighbor = (id: number, edgeId: number) => edges[edgeId].a === id ? edges[edgeId].b : edges[edgeId].a
  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id]
    if (n.fixed || n.next.length !== 2) continue
    const [a, b] = n.next.map(edgeId => neighbor(id, edgeId))
    if (Math.abs(cross(nodes[a].point, n.point, nodes[b].point)) < 1e-12) continue
    if ([a, b].every(side => {
      if (nodes[side].next.length !== 2) return false
      const other = nodes[side].next.map(edgeId => neighbor(side, edgeId)).find(next => next !== id)!
      return Math.abs(cross(nodes[other].point, nodes[side].point, n.point)) < 1e-12
    })) n.fixed = true
  }
  let movedVertices = 0, maximumDisplacementMm = 0
  const moved = nodes.map(n => {
    if (!tolerance || n.fixed || n.next.length !== 2) return n.point
    // Resolve neighbors by identity; a node can occur on either side of an edge.
    const p = n.next.map(id => { const e = edges[id]; return nodes[e.a] === n ? nodes[e.b].point : nodes[e.a].point })
    let dx = (p[0][0] + p[1][0] - 2 * n.point[0]) * 0.25
    let dy = (p[0][1] + p[1][1] - 2 * n.point[1]) * 0.25
    const distance = Math.hypot(dx, dy)
    if (distance < 1e-12) return n.point
    const scale = Math.min(1, tolerance / distance)
    dx *= scale; dy *= scale; movedVertices++
    maximumDisplacementMm = Math.max(maximumDisplacementMm, Math.hypot(dx, dy))
    return [n.point[0] + dx, n.point[1] + dy] as TexturePoint
  })
  // Fit each graph chain once. Its two material rings then reference the same
  // retained node IDs, so simplification cannot open a seam between colours.
  const keep = new Uint8Array(nodes.length).fill(1)
  const anchor = nodes.map(n => n.fixed || n.next.length !== 2)
  for (const ring of rings) if (!ring.nodes.some(id => anchor[id]) && ring.nodes.length > 3) {
    anchor[ring.nodes[0]] = true
    anchor[ring.nodes[Math.floor(ring.nodes.length / 2)]] = true
  }
  // Leave the first graph edge at each junction intact.
  for (let id = 0; id < nodes.length; id++) if (nodes[id].next.length !== 2) for (const edgeId of nodes[id].next) anchor[neighbor(id, edgeId)] = true
  const seenEdges = new Uint8Array(edges.length)
  let maximumFitErrorMm = 0, comparisons = 0, fitBudgetExceeded = false
  const fitChain = (chain: number[]) => {
    if (chain.length < 3 || !tolerance) return
    const stack: Array<[number, number]> = [[0, chain.length - 1]]
    while (stack.length) {
      const [first, last] = stack.pop()!
      if (last - first < 2) continue
      const a = moved[chain[first]], b = moved[chain[last]]
      const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy
      if (length2 < 1e-16) continue
      let previous = -Infinity, worst = -1, maxError = 0
      for (let i = first; i <= last; i++) {
        if (++comparisons > 2_000_000) { fitBudgetExceeded = true; return }
        const p = nodes[chain[i]].point
        const projection = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2
        const t = Math.max(0, Math.min(1, projection))
        const error = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
        if (error > maxError) { maxError = error; if (i > first && i < last) worst = i }
        if (projection + 1e-10 < previous) { worst = Math.min(i, last - 1); maxError = Infinity; break }
        previous = projection
      }
      if (maxError <= tolerance + 1e-12 && previous + 1e-10 >= 1 - tolerance / Math.sqrt(length2)) {
        for (let i = first + 1; i < last; i++) keep[chain[i]] = 0
        maximumFitErrorMm = Math.max(maximumFitErrorMm, maxError)
      } else if (worst > first && worst < last) stack.push([first, worst], [worst, last])
    }
  }
  for (const ring of input.straightFit === false ? [] : rings) {
    if (fitBudgetExceeded || !tolerance) break
    const ids = ring.nodes, start = ids.findIndex(id => anchor[id])
    if (start < 0) continue
    let chain = [ids[start]]
    for (let step = 1; step <= ids.length; step++) {
      const id = ids[(start + step) % ids.length]
      const from = chain[chain.length - 1]
      const edgeId = nodes[from].next.find(candidate => neighbor(from, candidate) === id)
      if (edgeId === undefined) throw new Error('Texture contour ring edge was lost')
      chain.push(id)
      if (anchor[id]) {
        if (!seenEdges[edgeId]) fitChain(chain)
        for (let i = 1; i < chain.length; i++) {
          const fromId = chain[i - 1], toId = chain[i]
          seenEdges[nodes[fromId].next.find(candidate => neighbor(fromId, candidate) === toId)!] = 1
        }
        chain = [id]
      }
    }
  }
  if (fitBudgetExceeded) { keep.fill(1); maximumFitErrorMm = 0 }
  const makeRegions = (points: TexturePoint[]) => {
    const grouped = new Map<number, TexturePoint[][]>()
    for (const ring of rings) {
      const compact = ring.nodes.filter((id, i) => {
        if (points === moved && !keep[id]) return false
        if (nodes[id].next.length !== 2) return true
        const a = points[ring.nodes[(i + ring.nodes.length - 1) % ring.nodes.length]], b = points[id], c = points[ring.nodes[(i + 1) % ring.nodes.length]]
        return Math.abs(cross(a, b, c)) > 1e-12 || (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0
      }).map(id => points[id])
      if (compact.length < 3 || area(compact) * area(ring.nodes.map(id => nodes[id].point)) <= 0) throw new Error('Texture contour fitting changed region topology')
      const bucket = grouped.get(ring.material) ?? []; bucket.push(compact); grouped.set(ring.material, bucket)
    }
    const regions = new Map<number, TextureRegionPolygon[]>()
    for (const [material, materialRings] of grouped) {
      const polygons = materialRings.filter(r => area(r) > 0).map(outer => ({ outer, holes: [] as TexturePoint[][] }))
      const extents = polygons.map((polygon, index) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [x, y] of polygon.outer) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x)
          minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
        return { index, minX, minY, maxX, maxY, area: area(polygon.outer) }
      })
      // A traced image may contain tens of thousands of disconnected islands.
      // Bucket bounding boxes before the exact point-in-ring test; scanning every
      // outer ring for every hole turns the otherwise linear graph pass quadratic.
      const bins = Math.min(128, Math.max(1, Math.ceil(Math.sqrt(polygons.length) / 2)))
      const world = extents.reduce((box, item) => ({
        minX: Math.min(box.minX, item.minX), minY: Math.min(box.minY, item.minY),
        maxX: Math.max(box.maxX, item.maxX), maxY: Math.max(box.maxY, item.maxY),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
      const cell = (value: number, min: number, max: number) => Math.max(0, Math.min(bins - 1, Math.floor((value - min) / Math.max(max - min, 1e-12) * bins)))
      const buckets = new Map<number, number[]>(), broad: number[] = []
      for (const box of extents) {
        const x0 = cell(box.minX, world.minX, world.maxX), x1 = cell(box.maxX, world.minX, world.maxX)
        const y0 = cell(box.minY, world.minY, world.maxY), y1 = cell(box.maxY, world.minY, world.maxY)
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > bins * bins / 2) { broad.push(box.index); continue }
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const key = y * bins + x, bucket = buckets.get(key) ?? []
          bucket.push(box.index); buckets.set(key, bucket)
        }
      }
      for (const hole of materialRings.filter(r => area(r) < 0)) {
        const point = hole[0], x = cell(point[0], world.minX, world.maxX), y = cell(point[1], world.minY, world.maxY)
        let owner = -1, smallest = Infinity
        for (const index of [...(buckets.get(y * bins + x) ?? []), ...broad]) {
          const box = extents[index]
          if (point[0] < box.minX || point[0] > box.maxX || point[1] < box.minY || point[1] > box.maxY) continue
          if ((box.area < smallest || (box.area === smallest && index < owner)) && inside(point, polygons[index].outer)) { owner = index; smallest = box.area }
        }
        if (owner < 0) throw new Error('Texture contour hole has no outer region')
        polygons[owner].holes.push(hole)
      }
      regions.set(material, polygons)
    }
    return regions
  }
  let regions: Map<number, TextureRegionPolygon[]>, fallbackReason: string | undefined
  try { regions = makeRegions(moved) } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error)
    regions = makeRegions(nodes.map(n => n.point)); movedVertices = 0; maximumDisplacementMm = 0; maximumFitErrorMm = 0
  }
  const outputVertices = [...regions.values()].flat().reduce((sum, p) => sum + p.outer.length + p.holes.reduce((s, r) => s + r.length, 0), 0)
  return { regions, diagnostics: { boundaryEdges: edges.length, originalVertices: rings.reduce((s, r) => s + r.nodes.length, 0), outputVertices, movedVertices, maximumDisplacementMm, maximumFitErrorMm, toleranceMm: tolerance, fallbackReason } }
}

/** Closed double-precision extrusion. Collinear cap vertices skipped by earcut
 * are split back into cap edges, avoiding cap/side-wall T junctions. Throws on
 * pinched/nonmanifold shells so callers can retain the exact legacy geometry.
 * Distinct closed islands retain distinct indices even if their boundaries
 * touch: joining them at a coincident edge would change the shell topology.
 */
export function extrudeTextureRegions(polygons: TextureRegionPolygon[], zMin: number, zMax: number): { vertices: number[]; triangles: number[] } {
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax <= zMin) throw new Error('Invalid texture region extrusion height')
  const vertices: number[] = [], triangles: number[] = []
  const componentEnds: number[] = []
  // A budget applies to the entire material, not once per island: photographs
  // can contain thousands of islands. Fall back before allocating huge caps.
  let comparisons = 0, processedTriangles = 0, sourceVertices = 0
  for (const polygon of polygons) {
    sourceVertices += polygon.outer.length + polygon.holes.reduce((n, r) => n + r.length, 0)
    if (sourceVertices > 100_000 || polygon.holes.length > 2048) throw new Error('Texture contour extrusion input budget exceeded; retain exact grid geometry')
  }
  for (const polygon of polygons) {
    const rings = [polygon.outer, ...polygon.holes].map((source, i) => {
      const r = source.map(p => [...p] as TexturePoint)
      if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop()
      if (r.length < 3 || Math.abs(area(r)) < 1e-14) throw new Error('Degenerate texture region ring')
      if ((area(r) > 0) !== (i === 0)) r.reverse()
      return r
    })
    const shellPoints = new Set<string>()
    for (const ring of rings) for (const [x, y] of ring) {
      const key = `${x.toFixed(9)},${y.toFixed(9)}`
      if (shellPoints.has(key)) throw new Error('Texture contour shell has a self-touching boundary (nonmanifold); retain exact grid geometry')
      shellPoints.add(key)
    }
    const points = rings.flat(), count = points.length, base = vertices.length / 3
    for (const z of [zMin, zMax]) for (const [x, y] of points) vertices.push(x, y, z)
    componentEnds.push(vertices.length / 3)
    let offset = 0
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = offset + i, b = offset + (i + 1) % ring.length
        triangles.push(base + a, base + b, base + b + count, base + a, base + b + count, base + a + count)
      }
      offset += ring.length
    }
    const cap = ShapeUtils.triangulateShape(rings[0].map(p => new Vector2(...p)), rings.slice(1).map(r => r.map(p => new Vector2(...p))))
    const pending = cap.map(t => [...t]), fixed: number[][] = []
    const sorted = [0, 1].map(axis => points.map((_, id) => id).sort((a, b) => points[a][axis] - points[b][axis]))
    const range = (axis: number, low: number, high: number) => {
      const values = sorted[axis]
      const bound = (value: number, upper: boolean) => {
        let a = 0, b = values.length
        while (a < b) { const mid = (a + b) >> 1; if (points[values[mid]][axis] < value || (upper && points[values[mid]][axis] === value)) a = mid + 1; else b = mid }
        return a
      }
      return [bound(low - 1e-10, false), bound(high + 1e-10, true)]
    }
    const between = (p: TexturePoint, a: TexturePoint, b: TexturePoint) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      return len > 0 && Math.abs(cross(a, b, p)) <= 1e-10 * len && (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]) < -1e-16
    }
    const isFlat = (t: number[]) => {
      const a = points[t[0]], b = points[t[1]], c = points[t[2]]
      const longest = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(b[0] - c[0], b[1] - c[1]))
      // Match the cap-edge collinearity tolerance. An absolute area epsilon
      // misclassifies roundoff slivers on longer edges as real triangles.
      return Math.abs(cross(a, b, c)) <= 1e-10 * longest
    }
    while (pending.length) {
      if (++processedTriangles > 250_000) throw new Error('Texture contour cap repair budget exceeded; retain exact grid geometry')
      const t = pending.pop()!
      if (isFlat(t)) continue
      let split = false
      for (let i = 0; i < 3 && !split; i++) {
        const a = t[i], b = t[(i + 1) % 3], c = t[(i + 2) % 3]
        const ranges = [0, 1].map(axis => range(axis, Math.min(points[a][axis], points[b][axis]), Math.max(points[a][axis], points[b][axis])))
        const axis = ranges[0][1] - ranges[0][0] < ranges[1][1] - ranges[1][0] ? 0 : 1
        for (let k = ranges[axis][0]; k < ranges[axis][1]; k++) {
          if (++comparisons > 5_000_000) throw new Error('Texture contour triangulation budget exceeded; retain exact grid geometry')
          const middle = sorted[axis][k]
          if (middle !== a && middle !== b && middle !== c && between(points[middle], points[a], points[b])) {
            pending.push([a, middle, c], [middle, b, c]); split = true; break
          }
        }
      }
      if (!split) fixed.push(t)
    }
    let coveredArea = 0
    for (const t of fixed) {
      const [a, b, c] = t, signed = cross(points[a], points[b], points[c])
      if (isFlat(t)) continue
      coveredArea += Math.abs(signed) / 2
      const ccw = signed > 0 ? [a, b, c] : [a, c, b]
      triangles.push(base + ccw[2], base + ccw[1], base + ccw[0], base + count + ccw[0], base + count + ccw[1], base + count + ccw[2])
    }
    const expectedArea = rings.reduce((s, r) => s + area(r), 0)
    if (Math.abs(coveredArea - expectedArea) > Math.max(1e-8, Math.abs(expectedArea) * 1e-7)) throw new Error('Texture contour cap triangulation changed area')
  }
  // Weld within each shell only. Separate islands are separate closed volumes,
  // just as in the legacy box export; a coordinate touch does not join indices.
  const weld = new Map<string, number>(), ids: number[] = []
  let component = 0
  for (let i = 0; i < vertices.length; i += 3) {
    while (i / 3 >= componentEnds[component]) component++
    const key = `${component}:${vertices[i].toFixed(9)},${vertices[i + 1].toFixed(9)},${vertices[i + 2].toFixed(9)}`
    let id = weld.get(key); if (id === undefined) { id = weld.size; weld.set(key, id) } ids.push(id)
  }
  const incidence = new Map<string, { count: number; winding: number }>()
  for (let i = 0; i < triangles.length; i += 3) {
    const t = triangles.slice(i, i + 3).map(id => ids[id])
    if (new Set(t).size !== 3) throw new Error('Texture contour extrusion has degenerate triangle')
    for (let j = 0; j < 3; j++) {
      const a = t[j], b = t[(j + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`
      const item = incidence.get(key) ?? { count: 0, winding: 0 }; item.count++; item.winding += a < b ? 1 : -1; incidence.set(key, item)
    }
  }
  const badEdges = [...incidence.entries()].filter(([, e]) => e.count !== 2 || e.winding !== 0)
  if (badEdges.length) throw new Error(`Texture contour extrusion is nonmanifold (${badEdges.length} edges); retain exact grid geometry`)
  return { vertices, triangles }
}
