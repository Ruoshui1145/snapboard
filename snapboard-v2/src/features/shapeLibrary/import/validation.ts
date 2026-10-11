import {
  boundsOfRings,
  cleanRing,
  firstSelfIntersection,
  minimumNonAdjacentEdgeDistance,
  pointInRing,
  ringsIntersect,
  signedArea,
  simplifyClosedRing,
} from './geometry'
import type {
  ImportedContourAdapter,
  ImportedShapeDraft,
  ImportPoint,
  ShapeAdapterOptions,
  ShapeImportIssue,
  ShapeImportResult,
  ShapeValidationOptions,
  ShapeValidationResult,
} from './types'

const issue = (
  severity: 'warning' | 'error',
  code: string,
  message: string,
  loopIndex?: number,
  details?: Record<string, number | string | boolean>,
): ShapeImportIssue => ({ severity, code, message, loopIndex, details })

export interface DraftFromLoopsOptions {
  sourceWidth?: number
  sourceHeight?: number
}

/** Selects one primary component while retaining every disconnected component as a fragment. */
export function draftFromClosedLoops(
  source: 'svg' | 'bitmap',
  name: string,
  loops: ImportPoint[][],
  options: DraftFromLoopsOptions = {},
): ShapeImportResult {
  const warnings: ShapeImportIssue[] = []
  const errors: ShapeImportIssue[] = []
  const candidates: ImportPoint[][] = []
  loops.forEach((loop, loopIndex) => {
    if (loop.length < 3) {
      errors.push(issue('error', 'OPEN_OR_DEGENERATE_LOOP', '轮廓至少需要 3 个不同顶点。', loopIndex))
      return
    }
    if (loop.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      errors.push(issue('error', 'NON_FINITE_COORDINATE', '轮廓包含 NaN 或无限坐标。', loopIndex))
      return
    }
    if (Math.abs(signedArea(loop)) <= 1e-9) {
      errors.push(issue('error', 'ZERO_AREA_LOOP', '轮廓面积为零，无法形成板型。', loopIndex))
      return
    }
    candidates.push(loop)
  })
  if (candidates.length === 0) {
    if (errors.length === 0) errors.push(issue('error', 'NO_CLOSED_OUTLINE', '没有找到可用的闭合轮廓。'))
    return { draft: null, warnings, errors }
  }

  candidates.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  const outer = candidates[0]
  const holes: ImportPoint[][] = []
  const fragments: ImportPoint[][] = []
  for (const loop of candidates.slice(1)) {
    const area = Math.abs(signedArea(loop))
    const containmentDepth = candidates.filter(parent => {
      if (parent === loop || Math.abs(signedArea(parent)) <= area) return false
      return loop.every(point => pointInRing(point, parent, true)) && !ringsIntersect(loop, parent)
    }).length
    // 偶数层是材料岛/独立板件，奇数层是它最近外轮廓中的孔。
    if (containmentDepth % 2 === 1) holes.push(loop)
    else fragments.push(loop)
  }
  if (fragments.length > 0) {
    warnings.push(issue(
      'warning',
      'DISCONNECTED_FRAGMENTS',
      `检测到 ${fragments.length} 个与主轮廓分离的闭合组件；已保留在 fragments 中，未自动合并。`,
      undefined,
      { count: fragments.length },
    ))
  }
  const bounds = boundsOfRings([outer, ...holes, ...fragments])
  return {
    draft: {
      version: 1,
      source,
      name,
      outer,
      holes,
      fragments,
      bounds,
      sourceWidth: options.sourceWidth,
      sourceHeight: options.sourceHeight,
    },
    warnings,
    errors,
  }
}

function simplifyToLimit(
  rings: ImportPoint[][],
  maxVertices: number,
  initialTolerance: number,
): { rings: ImportPoint[][]; tolerance: number } | null {
  const count = (values: ImportPoint[][]): number => values.reduce((sum, ring) => sum + ring.length, 0)
  if (count(rings) <= maxVertices) return { rings: rings.map(ring => ring.slice()), tolerance: 0 }
  const bounds = boundsOfRings(rings)
  const diagonal = Math.max(1, Math.hypot(bounds.width, bounds.height))
  let low = Math.max(1e-9, initialTolerance)
  let high = low
  let simplified = rings.map(ring => simplifyClosedRing(ring, high))
  while (count(simplified) > maxVertices && high < diagonal) {
    high *= 2
    simplified = rings.map(ring => simplifyClosedRing(ring, high))
  }
  if (count(simplified) > maxVertices || simplified.some(ring => ring.length < 3)) return null
  for (let iteration = 0; iteration < 18; iteration++) {
    const middle = (low + high) / 2
    const candidate = rings.map(ring => simplifyClosedRing(ring, middle))
    if (candidate.some(ring => ring.length < 3) || count(candidate) > maxVertices) low = middle
    else {
      high = middle
      simplified = candidate
    }
  }
  return { rings: simplified, tolerance: high }
}

export function normalizeAndValidateShape(
  input: ImportedShapeDraft,
  options: ShapeValidationOptions = {},
): ShapeValidationResult {
  const warnings: ShapeImportIssue[] = []
  const errors: ShapeImportIssue[] = []
  const pointTolerance = Math.max(1e-9, options.pointTolerance ?? 1e-6)
  const maxVertices = Math.max(3, Math.floor(options.maxVertices ?? 4096))
  const hardVertexLimit = Math.max(maxVertices, Math.floor(options.hardVertexLimit ?? 100_000))
  const minFragmentArea = Math.max(0, options.minFragmentArea ?? 1)
  const allInputRings = [input.outer, ...input.holes, ...input.fragments]
  const rawVertexCount = allInputRings.reduce((sum, ring) => sum + ring.length, 0)

  if (rawVertexCount > hardVertexLimit) {
    errors.push(issue('error', 'HARD_VERTEX_LIMIT', `输入包含 ${rawVertexCount} 个顶点，超过安全上限 ${hardVertexLimit}。`, undefined, {
      actual: rawVertexCount,
      limit: hardVertexLimit,
    }))
    return { draft: null, warnings, errors, valid: false }
  }
  for (let loopIndex = 0; loopIndex < allInputRings.length; loopIndex++) {
    if (allInputRings[loopIndex].some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      errors.push(issue('error', 'NON_FINITE_COORDINATE', '轮廓包含 NaN 或无限坐标。', loopIndex))
    }
  }
  if (errors.length > 0) return { draft: null, warnings, errors, valid: false }

  let rings = allInputRings.map((ring, loopIndex) => {
    const cleaned = cleanRing(ring, pointTolerance)
    if (cleaned.removed > 0) warnings.push(issue(
      'warning',
      'DUPLICATE_POINTS_REMOVED',
      `轮廓中移除了 ${cleaned.removed} 个重复或过近顶点。`,
      loopIndex,
      { count: cleaned.removed },
    ))
    return cleaned.points
  })

  const primaryRingCount = 1 + input.holes.length
  const effectiveVertexCount = rings.reduce((sum, ring) => sum + ring.length, 0)
  if (effectiveVertexCount > maxVertices) {
    if (options.simplifyExcessVertices === false) {
      errors.push(issue('error', 'VERTEX_LIMIT_EXCEEDED', `有效轮廓包含 ${effectiveVertexCount} 个顶点，超过上限 ${maxVertices}。`, undefined, {
        actual: effectiveVertexCount,
        limit: maxVertices,
      }))
    } else {
      const simplified = simplifyToLimit(
        rings,
        maxVertices,
        Math.max(pointTolerance, options.simplifyTolerance ?? pointTolerance),
      )
      if (!simplified) errors.push(issue('error', 'VERTEX_SIMPLIFICATION_FAILED', '无法在不使轮廓退化的前提下降到顶点上限。'))
      else {
        const after = simplified.rings.reduce((sum, ring) => sum + ring.length, 0)
        rings = simplified.rings
        warnings.push(issue(
          'warning',
          'VERTEX_LIMIT_SIMPLIFIED',
          `全部轮廓从 ${effectiveVertexCount} 个顶点显式简化到 ${after} 个顶点。`,
          undefined,
          { before: effectiveVertexCount, after, tolerance: simplified.tolerance },
        ))
      }
    }
  }
  if (errors.length > 0) return { draft: null, warnings, errors, valid: false }

  rings.forEach((ring, loopIndex) => {
    if (ring.length < 3) {
      errors.push(issue('error', 'DEGENERATE_LOOP', '轮廓清理后少于 3 个顶点。', loopIndex))
      return
    }
    const intersection = firstSelfIntersection(ring, pointTolerance * 1e-3)
    if (intersection) errors.push(issue(
      'error',
      'SELF_INTERSECTION',
      `轮廓边 ${intersection[0]} 与边 ${intersection[1]} 自相交。`,
      loopIndex,
      { firstEdge: intersection[0], secondEdge: intersection[1] },
    ))
    const area = signedArea(ring)
    if (Math.abs(area) <= pointTolerance * pointTolerance) {
      errors.push(issue('error', 'ZERO_AREA_LOOP', '轮廓面积过小或为零。', loopIndex))
    }
  })
  if (errors.length > 0) return { draft: null, warnings, errors, valid: false }

  let outer = rings[0]
  let holes = rings.slice(1, primaryRingCount)
  let fragments = rings.slice(primaryRingCount)
  if (signedArea(outer) < 0) {
    outer = outer.slice().reverse()
    warnings.push(issue('warning', 'OUTER_WINDING_NORMALIZED', '外轮廓绕向已统一为 SnapBoard 正面积约定。', 0))
  }
  holes = holes.map((hole, index) => {
    if (signedArea(hole) <= 0) return hole
    warnings.push(issue('warning', 'HOLE_WINDING_NORMALIZED', '内孔绕向已统一为负面积约定。', index + 1))
    return hole.slice().reverse()
  })
  fragments = fragments.map((fragment, index) => {
    if (signedArea(fragment) >= 0) return fragment
    warnings.push(issue(
      'warning',
      'FRAGMENT_WINDING_NORMALIZED',
      '分离外轮廓绕向已统一为正面积约定。',
      primaryRingCount + index,
    ))
    return fragment.slice().reverse()
  })

  holes.forEach((hole, holeIndex) => {
    const containingOuters = [outer, ...fragments].filter(materialOuter =>
      hole.every(point => pointInRing(point, materialOuter, false))
      && !ringsIntersect(hole, materialOuter, pointTolerance * 1e-3))
    if (containingOuters.length === 0) {
      errors.push(issue('error', 'HOLE_OUTSIDE_OUTER', '内孔不完全位于任何材料外轮廓内部，或与外轮廓相交。', holeIndex + 1))
    }
    for (let otherIndex = 0; otherIndex < holeIndex; otherIndex++) {
      const other = holes[otherIndex]
      if (ringsIntersect(hole, other, pointTolerance * 1e-3)) {
        errors.push(issue('error', 'HOLES_INTERSECT', '两个内孔发生相交。', holeIndex + 1, { otherHole: otherIndex }))
      } else if (pointInRing(hole[0], other, false) || pointInRing(other[0], hole, false)) {
        errors.push(issue('error', 'NESTED_HOLE_UNSUPPORTED', '检测到内孔中的孤岛；当前板型契约不能无损表达该层级。', holeIndex + 1, {
          otherHole: otherIndex,
        }))
      }
    }
  })

  fragments.forEach((fragment, fragmentIndex) => {
    const area = Math.abs(signedArea(fragment))
    if (area < minFragmentArea) warnings.push(issue(
      'warning',
      'SMALL_FRAGMENT',
      `分离组件面积 ${area.toFixed(3)} 小于建议阈值 ${minFragmentArea}。`,
      primaryRingCount + fragmentIndex,
      { area, threshold: minFragmentArea },
    ))
  })

  const minFeatureWidth = options.minFeatureWidth
  if (minFeatureWidth !== undefined && Number.isFinite(minFeatureWidth) && minFeatureWidth > 0) {
    ;[outer, ...holes, ...fragments].forEach((ring, loopIndex) => {
      let shortestEdge = Number.POSITIVE_INFINITY
      for (let index = 0; index < ring.length; index++) {
        const current = ring[index]
        const next = ring[(index + 1) % ring.length]
        shortestEdge = Math.min(shortestEdge, Math.hypot(next.x - current.x, next.y - current.y))
      }
      const clearance = minimumNonAdjacentEdgeDistance(ring, minFeatureWidth)
      if (shortestEdge < minFeatureWidth || clearance < minFeatureWidth) warnings.push(issue(
        'warning',
        'NARROW_FEATURE',
        `检测到小于建议最小结构宽度 ${minFeatureWidth} 的边或局部间距。`,
        loopIndex,
        { shortestEdge, nonAdjacentClearance: clearance, threshold: minFeatureWidth },
      ))
    })
  }
  if (errors.length > 0) return { draft: null, warnings, errors, valid: false }

  let bounds = boundsOfRings([outer, ...holes, ...fragments])
  if (options.moveToOrigin !== false && (Math.abs(bounds.minX) > pointTolerance || Math.abs(bounds.minY) > pointTolerance)) {
    const translate = (ring: ImportPoint[]): ImportPoint[] => ring.map(point => ({
      x: point.x - bounds.minX,
      y: point.y - bounds.minY,
    }))
    outer = translate(outer)
    holes = holes.map(translate)
    fragments = fragments.map(translate)
    warnings.push(issue('warning', 'MOVED_TO_ORIGIN', '轮廓已平移到局部坐标原点。', undefined, {
      offsetX: bounds.minX,
      offsetY: bounds.minY,
    }))
    bounds = boundsOfRings([outer, ...holes, ...fragments])
  }
  const draft: ImportedShapeDraft = {
    ...input,
    outer,
    holes,
    fragments,
    bounds,
  }
  return { draft, warnings, errors, valid: true }
}

/** Adapts a valid draft to the minimal role-aware contour contract used by the editor integration. */
export function adaptImportedShapeDraft(
  draft: ImportedShapeDraft,
  options: ShapeAdapterOptions = {},
): ImportedContourAdapter[] {
  const preserveAspect = options.preserveAspect !== false
  const widthScale = options.targetWidth !== undefined ? options.targetWidth / Math.max(draft.bounds.width, 1e-9) : 1
  const heightScale = options.targetHeight !== undefined ? options.targetHeight / Math.max(draft.bounds.height, 1e-9) : 1
  let scaleX = widthScale
  let scaleY = heightScale
  if (preserveAspect) {
    const scale = options.targetWidth !== undefined && options.targetHeight !== undefined
      ? Math.min(widthScale, heightScale)
      : options.targetWidth !== undefined ? widthScale : options.targetHeight !== undefined ? heightScale : 1
    scaleX = scaleY = scale
  }
  const originX = options.originX ?? 0
  const originY = options.originY ?? 0
  const transform = (points: ImportPoint[]): ImportPoint[] => points.map(point => ({
    x: originX + (point.x - draft.bounds.minX) * scaleX,
    y: originY + (point.y - draft.bounds.minY) * scaleY,
  }))
  return [
    {
      type: 'outer',
      name: options.outerName ?? draft.name,
      points: transform(draft.outer),
      closed: true,
    },
    ...draft.fragments.map((fragment, index): ImportedContourAdapter => ({
      type: 'outer',
      name: `${draft.name} 分离组件 ${index + 1}`,
      points: transform(fragment),
      closed: true,
    })),
    ...draft.holes.map((hole, index): ImportedContourAdapter => ({
      type: 'inner',
      name: `${options.holeNamePrefix ?? `${draft.name} 内孔`} ${index + 1}`,
      points: transform(hole),
      closed: true,
    })),
  ]
}
