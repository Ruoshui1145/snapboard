// ============================================================================
// planarFaces.ts — 开放草图图元的有界面提取（纯函数，无 DOM 依赖）
//
// 将开放直线链和独立/混合圆弧按端点容差构造成平面半边图，再用各顶点处
// 的切线方向追踪有界面。该模块只负责“端点已经落到同一位置”的拓扑；任意
// 相交边应先由修剪/分段层生成真实端点，再交给这里提取面。
// ============================================================================

import type { ArcEntity, Contour, Point2D } from '../types/geometry'

const TAU = Math.PI * 2
// 默认只吸收浮点运算噪声，不承担 UI 的“靠近即吸附”职责。绘图层若已明确
// 采用更大的端点吸附半径，应由调用方显式传入，避免几何内核静默焊接近邻。
const DEFAULT_TOLERANCE = 0.1
const DEFAULT_MINIMUM_AREA = 1e-3

export interface PlanarFaceOptions {
  /** 端点聚类容差（画布像素）；默认 0.1px，只吸收数值噪声。 */
  tolerance?: number
  /** 过滤数值噪声形成的极小环（平方像素）。 */
  minimumArea?: number
  /** 输出轮廓类型；自动分板集成时通常使用 outer。 */
  type?: Contour['type']
  /** 输出轮廓 id 前缀。 */
  idPrefix?: string
}

export interface PlanarFaceCandidate {
  contour: Contour
  /** 组成该面的源轮廓 id，按首次出现顺序去重。 */
  sourceIds: string[]
  /** 组成该面的源边/圆弧 id，便于交互层回写或高亮。 */
  sourceEdgeIds: string[]
  /** 精确计入圆弧段后的有向面积；返回的有界面恒为正值。 */
  area: number
}

interface EndpointRecord {
  point: Point2D
  arcEndpoint: boolean
}

interface RawEdge {
  sourceContourId: string
  sourceEdgeId: string
  fromEndpoint: number
  toEndpoint: number
  arc?: ArcEntity
}

interface GraphNode {
  point: Point2D
}

interface GraphEdge {
  a: number
  b: number
  sourceIds: string[]
  sourceEdgeIds: string[]
  /** 圆弧方向始终是 a → b；反向半边使用相反 sweep。 */
  arc?: Omit<ArcEntity, 'p1' | 'p2'>
}

interface HalfEdge {
  edge: number
  from: number
  to: number
  reversed: boolean
  angle: number
}

const distance = (a: Point2D, b: Point2D): number => Math.hypot(b.x - a.x, b.y - a.y)

const oppositeSweep = (sweep: ArcEntity['sweep']): ArcEntity['sweep'] => sweep === 'ccw' ? 'cw' : 'ccw'

const normAngle = (angle: number): number => {
  const value = angle % TAU
  return value < 0 ? value + TAU : value
}

const pointAngle = (center: Point2D, point: Point2D): number =>
  Math.atan2(point.y - center.y, point.x - center.x)

const arcSpan = (
  center: Point2D,
  start: Point2D,
  end: Point2D,
  sweep: ArcEntity['sweep'],
): number => {
  const startAngle = pointAngle(center, start)
  const endAngle = pointAngle(center, end)
  const raw = sweep === 'cw' ? normAngle(startAngle - endAngle) : normAngle(endAngle - startAngle)
  return raw <= 1e-9 ? TAU : raw
}

function collectRawEdges(contours: readonly Contour[]): {
  endpoints: EndpointRecord[]
  edges: RawEdge[]
} {
  const endpoints: EndpointRecord[] = []
  const edges: RawEdge[] = []
  const addEndpoint = (point: Point2D, arcEndpoint: boolean): number => {
    endpoints.push({ point: { ...point }, arcEndpoint })
    return endpoints.length - 1
  }

  for (const contour of contours) {
    if (contour.closed || contour.construction || contour.infinite) continue
    if (contour.shape === 'circle' || contour.shape === 'slot' || contour.slotWidth !== undefined) continue
    const points = contour.points
    for (let index = 0; index + 1 < points.length; index++) {
      const arc = contour.arcs?.find(item => item.p1 === index && item.p2 === index + 1)
      if (![points[index].x, points[index].y, points[index + 1].x, points[index + 1].y].every(Number.isFinite)) continue
      if (arc && (!Number.isFinite(arc.center.x) || !Number.isFinite(arc.center.y)
        || !Number.isFinite(arc.radius) || arc.radius <= 1e-9)) continue
      const fromEndpoint = addEndpoint(points[index], Boolean(arc))
      const toEndpoint = addEndpoint(points[index + 1], Boolean(arc))
      edges.push({
        sourceContourId: contour.id,
        sourceEdgeId: arc?.id ?? `${contour.id}:edge:${index}`,
        fromEndpoint,
        toEndpoint,
        ...(arc ? { arc: { ...arc, center: { ...arc.center } } } : {}),
      })
    }
  }
  return { endpoints, edges }
}

function clusterEndpoints(endpoints: readonly EndpointRecord[], tolerance: number): {
  nodes: GraphNode[]
  endpointNode: number[]
} {
  // 完全链接聚类：一个新端点必须与组内每个成员都在容差内。不能使用普通
  // Union-Find 单链接，否则 A≈B、B≈C 会把实际相距 > tolerance 的 A/C 链式焊接。
  const groups: number[][] = []
  for (let index = 0; index < endpoints.length; index++) {
    const group = groups.find(members => members.every(member =>
      distance(endpoints[index].point, endpoints[member].point) <= tolerance))
    if (group) group.push(index)
    else groups.push([index])
  }

  const nodes: GraphNode[] = []
  const endpointNode = Array(endpoints.length).fill(-1)
  for (const members of groups) {
    // 圆弧端点优先成为焊接坐标，避免平均值把端点推离其圆周；纯直线节点取平均值。
    const preferred = members.find(index => endpoints[index].arcEndpoint)
    const point = preferred !== undefined
      ? { ...endpoints[preferred].point }
      : {
          x: members.reduce((sum, index) => sum + endpoints[index].point.x, 0) / members.length,
          y: members.reduce((sum, index) => sum + endpoints[index].point.y, 0) / members.length,
        }
    const nodeIndex = nodes.length
    nodes.push({ point })
    for (const member of members) endpointNode[member] = nodeIndex
  }
  return { nodes, endpointNode }
}

const quantize = (value: number, tolerance: number): number =>
  Math.round(value / Math.max(tolerance, 1e-6))

function buildGraphEdges(
  rawEdges: readonly RawEdge[],
  endpointNode: readonly number[],
  tolerance: number,
): GraphEdge[] {
  const graphEdges: GraphEdge[] = []
  const deduplicated = new Map<string, number>()
  for (const raw of rawEdges) {
    const from = endpointNode[raw.fromEndpoint]
    const to = endpointNode[raw.toEndpoint]
    if (from === to || from < 0 || to < 0) continue
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    let key = `line:${low}:${high}`
    if (raw.arc) {
      const canonicalSweep = from === low ? raw.arc.sweep : oppositeSweep(raw.arc.sweep)
      key = [
        'arc', low, high, canonicalSweep,
        quantize(raw.arc.center.x, tolerance), quantize(raw.arc.center.y, tolerance),
        quantize(raw.arc.radius, tolerance),
      ].join(':')
    }
    const existingIndex = deduplicated.get(key)
    if (existingIndex !== undefined) {
      const existing = graphEdges[existingIndex]
      if (!existing.sourceIds.includes(raw.sourceContourId)) existing.sourceIds.push(raw.sourceContourId)
      if (!existing.sourceEdgeIds.includes(raw.sourceEdgeId)) existing.sourceEdgeIds.push(raw.sourceEdgeId)
      continue
    }
    const edge: GraphEdge = {
      a: from,
      b: to,
      sourceIds: [raw.sourceContourId],
      sourceEdgeIds: [raw.sourceEdgeId],
      ...(raw.arc ? {
        arc: {
          id: raw.arc.id,
          center: { ...raw.arc.center },
          radius: raw.arc.radius,
          sweep: raw.arc.sweep,
          ...(raw.arc.radiusDriving !== undefined ? { radiusDriving: raw.arc.radiusDriving } : {}),
        },
      } : {}),
    }
    deduplicated.set(key, graphEdges.length)
    graphEdges.push(edge)
  }
  return graphEdges
}

/** 去掉不可能属于闭环的叶边；这样分叉尾巴不会污染相邻闭合面的半边遍历。 */
function twoCoreEdgeSet(nodeCount: number, edges: readonly GraphEdge[]): Set<number> {
  const incident = Array.from({ length: nodeCount }, () => [] as number[])
  edges.forEach((edge, index) => {
    incident[edge.a].push(index)
    incident[edge.b].push(index)
  })
  const active = new Set(edges.map((_, index) => index))
  const degree = incident.map(items => items.length)
  const queue = degree.map((value, index) => value < 2 ? index : -1).filter(index => index >= 0)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor]
    for (const edgeIndex of incident[node]) {
      if (!active.delete(edgeIndex)) continue
      const edge = edges[edgeIndex]
      const other = edge.a === node ? edge.b : edge.a
      degree[node]--
      degree[other]--
      if (degree[other] === 1) queue.push(other)
    }
  }
  return active
}

function tangentAngle(edge: GraphEdge, nodes: readonly GraphNode[], reversed: boolean): number {
  const from = nodes[reversed ? edge.b : edge.a].point
  const to = nodes[reversed ? edge.a : edge.b].point
  if (!edge.arc) return Math.atan2(to.y - from.y, to.x - from.x)
  const sweep = reversed ? oppositeSweep(edge.arc.sweep) : edge.arc.sweep
  const radialAngle = pointAngle(edge.arc.center, from)
  return sweep === 'ccw' ? radialAngle + Math.PI / 2 : radialAngle - Math.PI / 2
}

function createHalfEdges(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  activeEdges: ReadonlySet<number>,
): { halfEdges: HalfEdge[]; outgoing: number[][]; twin: number[] } {
  const halfEdges: HalfEdge[] = []
  const outgoing = Array.from({ length: nodes.length }, () => [] as number[])
  const twin: number[] = []
  for (const edgeIndex of activeEdges) {
    const edge = edges[edgeIndex]
    const forward = halfEdges.length
    const reverse = forward + 1
    halfEdges.push({ edge: edgeIndex, from: edge.a, to: edge.b, reversed: false, angle: tangentAngle(edge, nodes, false) })
    halfEdges.push({ edge: edgeIndex, from: edge.b, to: edge.a, reversed: true, angle: tangentAngle(edge, nodes, true) })
    twin[forward] = reverse
    twin[reverse] = forward
    outgoing[edge.a].push(forward)
    outgoing[edge.b].push(reverse)
  }
  for (const items of outgoing) {
    items.sort((left, right) => halfEdges[left].angle - halfEdges[right].angle || left - right)
  }
  return { halfEdges, outgoing, twin }
}

function cycleArea(
  cycle: readonly number[],
  halfEdges: readonly HalfEdge[],
  edges: readonly GraphEdge[],
  nodes: readonly GraphNode[],
): number {
  let doubleArea = 0
  for (const halfEdgeIndex of cycle) {
    const halfEdge = halfEdges[halfEdgeIndex]
    const edge = edges[halfEdge.edge]
    const start = nodes[halfEdge.from].point
    const end = nodes[halfEdge.to].point
    if (!edge.arc) {
      doubleArea += start.x * end.y - start.y * end.x
      continue
    }
    const sweep = halfEdge.reversed ? oppositeSweep(edge.arc.sweep) : edge.arc.sweep
    const startAngle = pointAngle(edge.arc.center, start)
    const endAngle = pointAngle(edge.arc.center, end)
    const span = arcSpan(edge.arc.center, start, end, sweep)
    const delta = sweep === 'ccw' ? span : -span
    doubleArea += edge.arc.radius * (
      edge.arc.center.x * (Math.sin(endAngle) - Math.sin(startAngle))
      - edge.arc.center.y * (Math.cos(endAngle) - Math.cos(startAngle))
    ) + edge.arc.radius * edge.arc.radius * delta
  }
  return doubleArea / 2
}

function sampleCycle(
  cycle: readonly number[],
  halfEdges: readonly HalfEdge[],
  edges: readonly GraphEdge[],
  nodes: readonly GraphNode[],
): Point2D[] {
  if (cycle.length === 0) return []
  const samples: Point2D[] = [{ ...nodes[halfEdges[cycle[0]].from].point }]
  for (const halfEdgeIndex of cycle) {
    const halfEdge = halfEdges[halfEdgeIndex]
    const edge = edges[halfEdge.edge]
    const end = nodes[halfEdge.to].point
    if (!edge.arc) {
      samples.push({ ...end })
      continue
    }
    const start = nodes[halfEdge.from].point
    const sweep = halfEdge.reversed ? oppositeSweep(edge.arc.sweep) : edge.arc.sweep
    const startAngle = pointAngle(edge.arc.center, start)
    const span = arcSpan(edge.arc.center, start, end, sweep)
    const steps = Math.max(1, Math.ceil(span / (Math.PI / 36))) // 5°弦段用于拓扑自交检测
    const direction = sweep === 'ccw' ? 1 : -1
    for (let step = 1; step < steps; step++) {
      const angle = startAngle + direction * span * (step / steps)
      samples.push({
        x: edge.arc.center.x + edge.arc.radius * Math.cos(angle),
        y: edge.arc.center.y + edge.arc.radius * Math.sin(angle),
      })
    }
    samples.push({ ...end })
  }
  if (samples.length > 1 && distance(samples[0], samples[samples.length - 1]) <= 1e-7) samples.pop()
  return samples
}

const cross = (a: Point2D, b: Point2D, c: Point2D): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

function pointOnSegment(point: Point2D, start: Point2D, end: Point2D, epsilon: number): boolean {
  return Math.abs(cross(start, end, point)) <= epsilon
    && point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon
}

function segmentsIntersect(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
  epsilon = 1e-7,
): boolean {
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true
  return (Math.abs(abC) <= epsilon && pointOnSegment(c, a, b, epsilon))
    || (Math.abs(abD) <= epsilon && pointOnSegment(d, a, b, epsilon))
    || (Math.abs(cdA) <= epsilon && pointOnSegment(a, c, d, epsilon))
    || (Math.abs(cdB) <= epsilon && pointOnSegment(b, c, d, epsilon))
}

/** 折线化只用于自交判定；面积仍由 cycleArea 对圆弧做解析积分。 */
function isSimpleCycle(
  cycle: readonly number[],
  halfEdges: readonly HalfEdge[],
  edges: readonly GraphEdge[],
  nodes: readonly GraphNode[],
): boolean {
  const samples = sampleCycle(cycle, halfEdges, edges, nodes)
  const count = samples.length
  if (count < 3) return false
  for (let left = 0; left < count; left++) {
    const leftNext = (left + 1) % count
    if (distance(samples[left], samples[leftNext]) <= 1e-9) return false
    for (let right = left + 1; right < count; right++) {
      const rightNext = (right + 1) % count
      if (left === right || leftNext === right || rightNext === left) continue
      if (segmentsIntersect(samples[left], samples[leftNext], samples[right], samples[rightNext])) return false
    }
  }
  return true
}

function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * 从开放轮廓中提取所有不重复的简单有界面。
 *
 * - 支持单段直线、多段开放直线链、独立圆弧和混合开放链；
 * - 共享边只保留一条拓扑边，但其来源会合并进 sourceIds/sourceEdgeIds；
 * - 输出 points 与 arcs 的 p1/p2 已按新闭合环重建，可直接写回草图；
 * - 开放链、树状分叉和外部无限面不会成为候选。
 */
export function extractPlanarFaces(
  contours: readonly Contour[],
  options: PlanarFaceOptions = {},
): PlanarFaceCandidate[] {
  const tolerance = Math.max(1e-6, options.tolerance ?? DEFAULT_TOLERANCE)
  const minimumArea = Math.max(0, options.minimumArea ?? DEFAULT_MINIMUM_AREA)
  const { endpoints, edges: rawEdges } = collectRawEdges(contours)
  if (rawEdges.length === 0) return []
  const { nodes, endpointNode } = clusterEndpoints(endpoints, tolerance)
  const edges = buildGraphEdges(rawEdges, endpointNode, tolerance)
  const activeEdges = twoCoreEdgeSet(nodes.length, edges)
  if (activeEdges.size === 0) return []
  const { halfEdges, outgoing, twin } = createHalfEdges(nodes, edges, activeEdges)
  const visited = new Set<number>()
  const acceptedKeys = new Set<string>()
  const candidates: PlanarFaceCandidate[] = []

  for (let seed = 0; seed < halfEdges.length; seed++) {
    if (visited.has(seed)) continue
    const cycle: number[] = []
    const local = new Set<number>()
    let current = seed
    let closed = false
    for (let guard = 0; guard <= halfEdges.length; guard++) {
      if (current === seed && cycle.length > 0) {
        closed = true
        break
      }
      if (local.has(current)) break
      local.add(current)
      visited.add(current)
      cycle.push(current)
      const incomingTwin = twin[current]
      const atNode = outgoing[halfEdges[current].to]
      const twinPosition = atNode.indexOf(incomingTwin)
      if (twinPosition < 0 || atNode.length === 0) break
      // atan2 在画布 y 向下坐标中按视觉顺时针递增；取 twin 的前一条边可沿
      // 当前半边左侧（即有限面的内部）继续行走。
      current = atNode[(twinPosition - 1 + atNode.length) % atNode.length]
    }
    if (!closed || cycle.length < 2) continue
    const vertexIds = cycle.map(index => halfEdges[index].from)
    if (new Set(vertexIds).size !== vertexIds.length) continue
    if (!isSimpleCycle(cycle, halfEdges, edges, nodes)) continue
    const area = cycleArea(cycle, halfEdges, edges, nodes)
    if (!(area > minimumArea)) continue
    const faceKey = cycle.map(index => halfEdges[index].edge).sort((a, b) => a - b).join(',')
    if (acceptedKeys.has(faceKey)) continue
    acceptedKeys.add(faceKey)

    const points = vertexIds.map(index => ({ ...nodes[index].point }))
    const arcs: ArcEntity[] = []
    const faceSourceIds: string[] = []
    const faceSourceEdgeIds: string[] = []
    cycle.forEach((halfEdgeIndex, edgePosition) => {
      const halfEdge = halfEdges[halfEdgeIndex]
      const edge = edges[halfEdge.edge]
      faceSourceIds.push(...edge.sourceIds)
      faceSourceEdgeIds.push(...edge.sourceEdgeIds)
      if (!edge.arc) return
      arcs.push({
        ...edge.arc,
        id: edge.arc.id,
        p1: edgePosition,
        p2: (edgePosition + 1) % points.length,
        center: { ...edge.arc.center },
        sweep: halfEdge.reversed ? oppositeSweep(edge.arc.sweep) : edge.arc.sweep,
      })
    })
    const index = candidates.length + 1
    candidates.push({
      contour: {
        id: `${options.idPrefix ?? 'planar-face'}-${index}`,
        type: options.type ?? 'outer',
        name: `自动识别区域 ${index}`,
        points,
        closed: true,
        ...(arcs.length > 0 ? { arcs } : {}),
        constraints: [],
      },
      sourceIds: uniqueOrdered(faceSourceIds),
      sourceEdgeIds: uniqueOrdered(faceSourceEdgeIds),
      area,
    })
  }

  return candidates.sort((left, right) => {
    const leftMinX = Math.min(...left.contour.points.map(point => point.x))
    const rightMinX = Math.min(...right.contour.points.map(point => point.x))
    const leftMinY = Math.min(...left.contour.points.map(point => point.y))
    const rightMinY = Math.min(...right.contour.points.map(point => point.y))
    return leftMinX - rightMinX || leftMinY - rightMinY || left.area - right.area
  }).map((candidate, index) => ({
    ...candidate,
    contour: {
      ...candidate.contour,
      id: `${options.idPrefix ?? 'planar-face'}-${index + 1}`,
      name: `自动识别区域 ${index + 1}`,
    },
  }))
}
