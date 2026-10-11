import { boundsOfRings, cleanRing, pointInRing, signedArea, simplifyClosedRing, taubinSmooth } from './geometry'
import type { BitmapImportOptions, ImageDataLike, ImportedShapeDraft, ImportPoint, ShapeImportIssue, ShapeImportResult } from './types'
import { draftFromClosedLoops, normalizeAndValidateShape } from './validation'

interface BoundaryEdge {
  from: number
  to: number
  used: boolean
}

const makeIssue = (severity: 'warning' | 'error', code: string, message: string): ShapeImportIssue => ({
  severity,
  code,
  message,
})

function ringCenter(points: ImportPoint[]): ImportPoint {
  const sum = points.reduce((value, point) => ({ x: value.x + point.x, y: value.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / Math.max(1, points.length), y: sum.y / Math.max(1, points.length) }
}

function looksLikeStrokeBand(outer: ImportPoint[], hole: ImportPoint[], relaxed: boolean): boolean {
  const outerArea = Math.abs(signedArea(outer))
  const holeArea = Math.abs(signedArea(hole))
  if (outerArea <= 1e-9 || holeArea <= 1e-9) return false
  const areaRatio = holeArea / outerArea
  const outerBounds = boundsOfRings([outer])
  const holeBounds = boundsOfRings([hole])
  const widthRatio = holeBounds.width / Math.max(outerBounds.width, 1e-9)
  const heightRatio = holeBounds.height / Math.max(outerBounds.height, 1e-9)
  const outerCenter = ringCenter(outer)
  const holeCenter = ringCenter(hole)
  const centerOffset = Math.hypot(holeCenter.x - outerCenter.x, holeCenter.y - outerCenter.y)
    / Math.max(1, Math.hypot(outerBounds.width, outerBounds.height))
  return areaRatio >= (relaxed ? 0.42 : 0.58)
    && areaRatio <= 0.98
    && widthRatio >= (relaxed ? 0.62 : 0.75)
    && heightRatio >= (relaxed ? 0.62 : 0.75)
    && centerOffset <= (relaxed ? 0.2 : 0.12)
}

function ringInside(inner: ImportPoint[], outer: ImportPoint[]): boolean {
  return inner.length > 0 && inner.every(point => pointInRing(point, outer, false))
}

/** 删除已经被更大实心区域覆盖的内部外轮廓，避免眼睛/鼻子等继续成为独立板件。 */
function removeCoveredFragments(fragments: ImportPoint[][], filledOwners: ImportPoint[][]): ImportPoint[][] {
  return fragments.filter(fragment => !filledOwners.some(owner =>
    owner !== fragment
    && Math.abs(signedArea(owner)) > Math.abs(signedArea(fragment))
    && ringInside(fragment, owner)))
}

function solidifySilhouette(
  draft: ImportedShapeDraft,
  warnings: ShapeImportIssue[],
): ImportedShapeDraft {
  const removedHoles = draft.holes.length
  const fragments = removeCoveredFragments(draft.fragments, [draft.outer, ...draft.fragments])
  const removedFragments = draft.fragments.length - fragments.length
  warnings.push(makeIssue(
    'warning',
    'BITMAP_SOLID_SILHOUETTE',
    `实心剪影已填充 ${removedHoles} 个内部空腔${removedFragments ? `，并合并 ${removedFragments} 个被主体覆盖的内部细节` : ''}；仅保留外部剪影。`,
  ))
  return { ...draft, holes: [], fragments }
}

function fillClosedStrokeInterior(
  draft: ImportedShapeDraft,
  mode: NonNullable<BitmapImportOptions['outlineInterpretation']>,
  warnings: ShapeImportIssue[],
): ImportedShapeDraft {
  if (mode === 'silhouette') return solidifySilhouette(draft, warnings)
  if (draft.holes.length === 0) {
    warnings.push(makeIssue(
      'warning',
      mode === 'auto' ? 'BITMAP_AUTO_LITERAL_FOREGROUND' : 'BITMAP_NO_CLOSED_STROKE',
      mode === 'auto'
        ? '智能判断未发现可填充的闭合描边带，当前按原始前景提取。'
        : '闭合线稿模式未发现“外环+内环”组成的闭合描边带；请检查线条是否断开或调整阈值。',
    ))
    return draft
  }
  const materialOuters = [draft.outer, ...draft.fragments]
  const filledOwners: ImportPoint[][] = []
  const removed: number[] = []
  const holes = draft.holes.filter((hole, index) => {
    const owner = materialOuters.find(outer => hole.every(point => pointInRing(point, outer, false)))
    // 智能模式只填充最大主体的描边内部，避免把眼睛、文字和装饰孔全部猜成实体。
    if (!owner || (mode === 'auto' && owner !== draft.outer)
        || !looksLikeStrokeBand(owner, hole, mode === 'closed-stroke')) return true
    removed.push(index)
    if (!filledOwners.includes(owner)) filledOwners.push(owner)
    return false
  })
  if (removed.length === 0) {
    warnings.push(makeIssue(
      'warning',
      mode === 'auto' ? 'BITMAP_AUTO_LITERAL_FOREGROUND' : 'BITMAP_NO_CLOSED_STROKE',
      mode === 'auto'
        ? '智能判断认为当前空腔更像真实孔洞，已保留原始前景结构。'
        : '闭合线稿模式没有找到满足宽度和同心关系的描边带，结果保持原始前景。',
    ))
    return draft
  }
  const fragments = removeCoveredFragments(draft.fragments, filledOwners)
  const removedFragments = draft.fragments.length - fragments.length
  warnings.push(makeIssue(
    'warning',
    'BITMAP_STROKE_INTERIOR_FILLED',
    `${mode === 'auto' ? '智能模式' : '闭合线稿模式'}识别到 ${removed.length} 组闭合描边，已填充线内区域${removedFragments ? `并合并 ${removedFragments} 个内部细节` : ''}；未匹配的空腔继续作为真实孔洞。`,
  ))
  return { ...draft, holes, fragments }
}

function removeCollinear(points: ImportPoint[]): ImportPoint[] {
  if (points.length <= 3) return points.slice()
  const output: ImportPoint[] = []
  for (let index = 0; index < points.length; index++) {
    const previous = points[(index + points.length - 1) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]
    const cross = (current.x - previous.x) * (next.y - current.y)
      - (current.y - previous.y) * (next.x - current.x)
    if (Math.abs(cross) > 1e-9) output.push(current)
  }
  return output.length >= 3 ? output : points.slice()
}

function direction(from: number, to: number, stride: number): number {
  const fromX = from % stride
  const fromY = Math.floor(from / stride)
  const toX = to % stride
  const toY = Math.floor(to / stride)
  if (toX > fromX) return 0
  if (toY > fromY) return 1
  if (toX < fromX) return 2
  return 3
}

function traceBoundaryLoops(
  labels: Int32Array,
  width: number,
  height: number,
  selectedLabel: number,
  edgeLimit: number,
): ImportPoint[][] | null {
  const stride = width + 1
  const vertex = (x: number, y: number): number => y * stride + x
  const selected = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height
    && labels[y * width + x] === selectedLabel
  const edges: BoundaryEdge[] = []
  const add = (from: number, to: number): void => {
    if (edges.length >= edgeLimit) throw new Error('BITMAP_EDGE_LIMIT')
    edges.push({ from, to, used: false })
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!selected(x, y)) continue
      if (!selected(x, y - 1)) add(vertex(x, y), vertex(x + 1, y))
      if (!selected(x + 1, y)) add(vertex(x + 1, y), vertex(x + 1, y + 1))
      if (!selected(x, y + 1)) add(vertex(x + 1, y + 1), vertex(x, y + 1))
      if (!selected(x - 1, y)) add(vertex(x, y + 1), vertex(x, y))
    }
  }
  const outgoing = new Map<number, number[]>()
  edges.forEach((edge, index) => {
    const list = outgoing.get(edge.from)
    if (list) list.push(index)
    else outgoing.set(edge.from, [index])
  })
  const loops: ImportPoint[][] = []
  const turnPriority = [1, 0, 3, 2]
  for (let startIndex = 0; startIndex < edges.length; startIndex++) {
    if (edges[startIndex].used) continue
    const startVertex = edges[startIndex].from
    let edgeIndex = startIndex
    const points: ImportPoint[] = []
    let guard = 0
    while (guard++ <= edges.length) {
      const edge = edges[edgeIndex]
      if (edge.used) return null
      edge.used = true
      points.push({ x: edge.from % stride, y: Math.floor(edge.from / stride) })
      if (edge.to === startVertex) break
      const candidates = (outgoing.get(edge.to) ?? []).filter(candidate => !edges[candidate].used)
      if (candidates.length === 0) return null
      const incomingDirection = direction(edge.from, edge.to, stride)
      candidates.sort((first, second) => {
        const firstTurn = (direction(edges[first].from, edges[first].to, stride) - incomingDirection + 4) % 4
        const secondTurn = (direction(edges[second].from, edges[second].to, stride) - incomingDirection + 4) % 4
        return turnPriority.indexOf(firstTurn) - turnPriority.indexOf(secondTurn)
      })
      edgeIndex = candidates[0]
    }
    const cleaned = removeCollinear(cleanRing(points, 1e-9).points)
    if (cleaned.length >= 3 && Math.abs(signedArea(cleaned)) > 1e-9) loops.push(cleaned)
  }
  return loops
}

/**
 * Extracts significant 4-connected foreground components from decoded RGBA pixels.
 * Disconnected letters and logo marks are retained as separate outer contours.
 * In auto mode, images containing transparency use alpha; fully opaque images use luminance.
 */
export function importBitmapImageData(
  image: ImageDataLike,
  options: BitmapImportOptions = {},
): ShapeImportResult {
  const warnings: ShapeImportIssue[] = []
  const errors: ShapeImportIssue[] = []
  const width = Math.floor(image.width)
  const height = Math.floor(image.height)
  const pixelCount = width * height
  const maxPixels = Math.max(1, Math.floor(options.maxPixels ?? 8_000_000))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { draft: null, warnings, errors: [makeIssue('error', 'BITMAP_INVALID_SIZE', '图片宽高必须为正整数。')] }
  }
  if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixels) return {
    draft: null,
    warnings,
    errors: [makeIssue('error', 'BITMAP_PIXEL_LIMIT', `图片包含 ${pixelCount} 像素，超过安全上限 ${maxPixels}。`)],
  }
  if (image.data.length < pixelCount * 4) return {
    draft: null,
    warnings,
    errors: [makeIssue('error', 'BITMAP_DATA_LENGTH', 'ImageData 的 RGBA 数据长度不足。')],
  }

  const alphaThreshold = Math.max(0, Math.min(255, options.alphaThreshold ?? 16))
  const luminanceThreshold = Math.max(0, Math.min(255, options.luminanceThreshold ?? 245))
  let hasTransparency = false
  if ((options.thresholdMode ?? 'auto') === 'auto') {
    for (let index = 3; index < pixelCount * 4; index += 4) {
      if (Number(image.data[index]) < 250) {
        hasTransparency = true
        break
      }
    }
  }
  const mode = options.thresholdMode === 'auto' || options.thresholdMode === undefined
    ? hasTransparency ? 'alpha' : 'luminance'
    : options.thresholdMode
  const mask = new Uint8Array(pixelCount)
  let foregroundCount = 0
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4
    const red = Number(image.data[offset])
    const green = Number(image.data[offset + 1])
    const blue = Number(image.data[offset + 2])
    const alpha = Number(image.data[offset + 3])
    let foreground: boolean
    if (mode === 'alpha') foreground = options.invert ? alpha < alphaThreshold : alpha >= alphaThreshold
    else {
      const visible = alpha >= alphaThreshold
      // Round to an 8-bit value so RGB(255,255,255) stays exactly 255 instead of
      // 254.99999999999997 and accidentally becoming foreground at threshold 255.
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722)
      // Strict comparison keeps a pure white (255) background excluded when the slider is at 255.
      foreground = visible && (options.invert ? luminance > luminanceThreshold : luminance < luminanceThreshold)
    }
    if (foreground) {
      mask[pixel] = 1
      foregroundCount++
    }
  }
  if (foregroundCount === 0) return {
    draft: null,
    warnings,
    errors: [makeIssue('error', 'BITMAP_NO_FOREGROUND', '当前阈值下没有检测到前景像素。')],
  }

  const labels = new Int32Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  let label = 0
  let bestSize = 0
  const components: Array<{ label: number; size: number }> = []
  for (let seed = 0; seed < pixelCount; seed++) {
    if (!mask[seed] || labels[seed] !== 0) continue
    label++
    let head = 0
    let tail = 0
    queue[tail++] = seed
    labels[seed] = label
    while (head < tail) {
      const pixel = queue[head++]
      const x = pixel % width
      const y = Math.floor(pixel / width)
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ]
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && mask[neighbor] && labels[neighbor] === 0) {
          labels[neighbor] = label
          queue[tail++] = neighbor
        }
      }
    }
    components.push({ label, size: tail })
    if (tail > bestSize) bestSize = tail
  }
  components.sort((left, right) => right.size - left.size)
  const minComponentPixels = Math.max(
    1,
    Math.floor(options.minComponentPixels ?? Math.max(
      4,
      bestSize * (options.outlineInterpretation === 'closed-stroke' ? 0.0015 : 0.0002),
    )),
  )
  const maxComponents = Math.max(1, Math.min(256, Math.floor(options.maxComponents ?? 96)))
  const retained = components.filter(component => component.size >= minComponentPixels).slice(0, maxComponents)
  const discardedCount = components.length - retained.length
  if (retained.length > 1) warnings.push(makeIssue(
    'warning',
    'BITMAP_COMPONENTS_RETAINED',
    `检测到 ${retained.length} 个分离前景，已保留为可分别分割和安装的独立轮廓。`,
  ))
  if (discardedCount > 0) warnings.push(makeIssue(
    'warning',
    'BITMAP_COMPONENTS_FILTERED',
    `过滤了 ${discardedCount} 个小于 ${minComponentPixels} 像素或超出数量上限的噪点组件。`,
  ))

  let loops: ImportPoint[][] = []
  try {
    for (const component of retained) {
      const componentLoops = traceBoundaryLoops(
        labels,
        width,
        height,
        component.label,
        Math.max(64, Math.floor((options.hardVertexLimit ?? 100_000) * 4)),
      )
      if (componentLoops) loops.push(...componentLoops)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'BITMAP_EDGE_LIMIT') errors.push(makeIssue(
      'error',
      'BITMAP_EDGE_LIMIT',
      '位图边界过于复杂，超过安全边数；请先降低分辨率或提高阈值。',
    ))
    else errors.push(makeIssue('error', 'BITMAP_TRACE_FAILED', '位图边界追踪失败。'))
  }
  if (loops.length === 0) {
    if (errors.length === 0) errors.push(makeIssue('error', 'BITMAP_TRACE_FAILED', '未能形成闭合位图轮廓。'))
    return { draft: null, warnings, errors }
  }

  const smoothingPasses = Math.max(0, Math.min(3, Math.floor(options.smoothingPasses ?? 0)))
  const adaptiveTolerance = Math.hypot(width, height) * 0.00035
  const simplifyTolerance = Math.max(0, options.simplifyTolerance ?? 0.75, adaptiveTolerance)
  loops = loops.map(loop => {
    let result = smoothingPasses > 0 ? taubinSmooth(loop, smoothingPasses) : loop
    result = simplifyClosedRing(result, simplifyTolerance)
    return cleanRing(result, 1e-8).points
  })
  if (smoothingPasses > 0) warnings.push(makeIssue(
    'warning',
    'BITMAP_SMOOTHED',
    `位图边界应用了 ${smoothingPasses} 次非收缩 Taubin 平滑；面积保持稳定，尖角仍可能轻微变化。`,
  ))
  if (simplifyTolerance > 0) warnings.push(makeIssue(
    'warning',
    'BITMAP_SIMPLIFIED',
    `位图边界按 ${simplifyTolerance} px 容差进行了显式简化。`,
  ))

  const classified = draftFromClosedLoops('bitmap', options.name ?? '导入图片板型', loops, {
    sourceWidth: width,
    sourceHeight: height,
  })
  warnings.push(...classified.warnings)
  errors.push(...classified.errors)
  if (!classified.draft || errors.length > 0) return { draft: null, warnings, errors }
  const validated = normalizeAndValidateShape(classified.draft, options)
  const interpretedDraft = validated.draft
    ? fillClosedStrokeInterior(validated.draft, options.outlineInterpretation ?? 'auto', warnings)
    : null
  return {
    draft: interpretedDraft,
    warnings: warnings.concat(validated.warnings),
    errors: errors.concat(validated.errors),
  }
}
