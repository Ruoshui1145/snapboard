import type { Contour, Point2D } from '../types/geometry'

export interface CollinearEdgeChain {
  edgeIndices: number[]
  vertexIndices: number[]
  startVertex: number
  endVertex: number
  totalLength: number
}

const edgeTotal = (contour: Contour) => contour.closed && contour.points.length > 2
  ? contour.points.length
  : Math.max(0, contour.points.length - 1)

const arcEdges = (contour: Contour) => new Set((contour.arcs ?? []).map(arc => arc.p1))

const vector = (points: Point2D[], edge: number) => {
  const a = points[edge]
  const b = points[(edge + 1) % points.length]
  return { x: b.x - a.x, y: b.y - a.y, length: Math.hypot(b.x - a.x, b.y - a.y) }
}

/** 把同向、共线、首尾相接的多个直边视为一条逻辑直线。 */
export function resolveCollinearEdgeChain(contour: Contour, edgeIndex: number, angularTolerance = 1e-5): CollinearEdgeChain | null {
  const total = edgeTotal(contour)
  if (edgeIndex < 0 || edgeIndex >= total || contour.points.length < 2) return null
  const curved = arcEdges(contour)
  if (curved.has(edgeIndex)) return null
  const base = vector(contour.points, edgeIndex)
  if (base.length < 1e-7) return null
  const compatible = (edge: number) => {
    if (edge < 0 || edge >= total || curved.has(edge)) return false
    const next = vector(contour.points, edge)
    if (next.length < 1e-7) return false
    const cross = Math.abs(base.x * next.y - base.y * next.x) / (base.length * next.length)
    const dot = base.x * next.x + base.y * next.y
    return cross <= angularTolerance && dot > 0
  }

  let first = edgeIndex
  let last = edgeIndex
  let count = 1
  while (count < total) {
    const previous = (first - 1 + total) % total
    if ((!contour.closed && previous >= first) || !compatible(previous)) break
    first = previous
    count++
  }
  while (count < total) {
    const next = (last + 1) % total
    if ((!contour.closed && next <= last) || !compatible(next)) break
    last = next
    count++
  }

  const edgeIndices: number[] = []
  let cursor = first
  while (edgeIndices.length < count) {
    edgeIndices.push(cursor)
    if (cursor === last) break
    cursor = (cursor + 1) % total
  }
  const vertexIndices = [edgeIndices[0], ...edgeIndices.map(edge => (edge + 1) % contour.points.length)]
  return {
    edgeIndices,
    vertexIndices,
    startVertex: vertexIndices[0],
    endVertex: vertexIndices[vertexIndices.length - 1],
    totalLength: edgeIndices.reduce((sum, edge) => sum + vector(contour.points, edge).length, 0),
  }
}

export function collinearChainContainingVertices(contour: Contour, firstVertex: number, secondVertex: number): CollinearEdgeChain | null {
  if (firstVertex < 0 || secondVertex < 0 || firstVertex === secondVertex) return null
  const total = edgeTotal(contour)
  const visited = new Set<number>()
  for (let edge = 0; edge < total; edge++) {
    if (visited.has(edge)) continue
    const chain = resolveCollinearEdgeChain(contour, edge)
    if (!chain) continue
    chain.edgeIndices.forEach(value => visited.add(value))
    if (chain.vertexIndices.includes(firstVertex) && chain.vertexIndices.includes(secondVertex)) return chain
  }
  return null
}

export function sameCollinearEdgeChain(contour: Contour, firstEdge: number, secondEdge: number): CollinearEdgeChain | null {
  const chain = resolveCollinearEdgeChain(contour, firstEdge)
  return chain?.edgeIndices.includes(secondEdge) ? chain : null
}
