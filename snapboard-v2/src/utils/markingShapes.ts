import * as THREE from 'three'
import type { Point2D } from '../types/geometry'

/** Manufacturing-only: split earcut hole-bridge T-junctions without changing glyphs. */
export function createMarkingGeometry(rings: Point2D[][], depth: number): THREE.BufferGeometry {
  const origin = rings[0]?.[0] ?? { x: 0, y: 0 }
  const localRings = rings.map(ring => ring.map(point => ({ x: point.x - origin.x, y: point.y - origin.y })))
  const source = new THREE.ExtrudeGeometry(markingShapes(localRings), { depth, bevelEnabled: false, curveSegments: 1 })
  const position = source.getAttribute('position')
  const points = new Map<string, [number, number]>()
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i)
    points.set(`${x}:${y}`, [x, y])
  }
  const candidates = [...points.values()]
  const output: number[] = []
  type Vertex = [number, number, number]
  const emit = (a: Vertex, b: Vertex, c: Vertex) => {
    const pending: Vertex[][] = [[a, b, c]]
    while (pending.length) {
      const triangle = pending.pop()!
      const [p, q, r] = triangle
      const area = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
      if (Math.abs(area) < 1e-10) continue
      let split = false
      for (let edge = 0; edge < 3 && !split; edge++) {
        const u = triangle[edge], v = triangle[(edge + 1) % 3], w = triangle[(edge + 2) % 3]
        const dx = v[0] - u[0], dy = v[1] - u[1], length2 = dx * dx + dy * dy
        for (const [x, y] of candidates) {
          const t = ((x - u[0]) * dx + (y - u[1]) * dy) / length2
          if (t <= 1e-7 || t >= 1 - 1e-7) continue
          if (Math.abs((x - u[0]) * dy - (y - u[1]) * dx) > 1e-7 * Math.sqrt(length2)) continue
          const middle: Vertex = [x, y, u[2]]
          pending.push([u, middle, w], [middle, v, w])
          split = true; break
        }
      }
      if (!split) output.push(...p, ...q, ...r)
    }
  }
  for (let i = 0; i < position.count; i += 3) {
    const vertices = [0, 1, 2].map(j => [position.getX(i + j), position.getY(i + j), position.getZ(i + j)] as Vertex)
    if (vertices[0][2] === vertices[1][2] && vertices[1][2] === vertices[2][2]) emit(vertices[0], vertices[1], vertices[2])
    else output.push(...vertices[0], ...vertices[1], ...vertices[2])
  }
  source.dispose()
  const geometry = new THREE.BufferGeometry()
  for (let i = 0; i < output.length; i += 3) { output[i] += origin.x; output[i + 1] += origin.y }
  // Keep global board offsets in double precision through manufacturing welding.
  // This geometry is serialized to 3MF only; WebGL preview uses markingShapes.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float64Array(output), 3))
  geometry.computeVertexNormals()
  return geometry
}

/** Outer rings are CCW; negative rings are glyph counters, never solid islands. */
export function markingShapes(rings: Point2D[][]): THREE.Shape[] {
  const area = (p: Point2D[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a.x * b.y - b.x * a.y }, 0)
  const shapes: Array<{ ring: Point2D[]; shape: THREE.Shape }> = []
  for (const ring of rings.filter(p => p.length >= 3 && area(p) > 0)) {
    const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(p.x, p.y)))
    shape.closePath(); shapes.push({ ring, shape })
  }
  for (const ring of rings.filter(p => p.length >= 3 && area(p) < 0)) {
    const point = ring[0]
    const containing = shapes.filter(({ ring: outer }) => {
      let inside = false
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const a = outer[i], b = outer[j]
        if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
      }
      return inside
    }).sort((a, b) => area(a.ring) - area(b.ring))
    if (!containing.length) throw new Error('背面字形的内孔缺少外轮廓')
    const hole = new THREE.Path(ring.map(p => new THREE.Vector2(p.x, p.y))); hole.closePath()
    containing[0].shape.holes.push(hole)
  }
  return shapes.map(item => item.shape)
}
