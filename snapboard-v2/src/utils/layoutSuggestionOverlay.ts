import * as THREE from 'three'

export interface LayoutSuggestionOverlayPoint {
  /** Viewport3D 装配局部坐标，x 以装配中心为 0。 */
  x: number
  /** Viewport3D 装配局部坐标，y 以装配底边为 0。 */
  y: number
  score: number
  rank: number
  id?: string
}

export interface LayoutSuggestionOverlayOptions {
  /** 显示排名最前的建议数量，限制在 3~6；建议不足时按实际数量显示。默认 5。 */
  maxMarkers?: number
  /** 推荐落点圆环外半径，单位 mm。默认 9。 */
  markerRadius?: number
  /** 圆环宽度，单位 mm。默认 1.8。 */
  ringThickness?: number
  /** 相对板材表面的抬高距离，避免 z-fighting。默认 0.7 mm。 */
  zOffset?: number
  /** 圆环透明度。默认 0.92。 */
  opacity?: number
  /** 按显示顺序循环使用的颜色。 */
  colors?: readonly THREE.ColorRepresentation[]
}

export interface LayoutSuggestionOverlayInput {
  suggestions: readonly LayoutSuggestionOverlayPoint[]
  /** 建议所在板面的 z 坐标；正面通常为板厚。 */
  surfaceZ: number
  options?: LayoutSuggestionOverlayOptions
}

interface ResolvedOverlayOptions {
  maxMarkers: number
  markerRadius: number
  ringThickness: number
  zOffset: number
  opacity: number
  colors: readonly THREE.ColorRepresentation[]
}

interface RankedSuggestion {
  point: LayoutSuggestionOverlayPoint
  sourceIndex: number
  displayRank: number
}

type DigitSegment = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'

export const LAYOUT_SUGGESTION_OVERLAY_NAME = 'layout-suggestion-overlay'
export const LAYOUT_SUGGESTION_MARKER_PREFIX = 'layout-suggestion-marker-rank-'

const DEFAULT_COLORS: readonly THREE.ColorRepresentation[] = [
  0xf6c344,
  0x62a7ff,
  0x32d583,
  0xa67af4,
  0xf79009,
  0x98a2b3,
]

const DEFAULT_OPTIONS: ResolvedOverlayOptions = {
  maxMarkers: 5,
  markerRadius: 9,
  ringThickness: 1.8,
  zOffset: 0.7,
  opacity: 0.92,
  colors: DEFAULT_COLORS,
}

const DIGIT_SEGMENTS: Readonly<Record<string, readonly DigitSegment[]>> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '3': ['a', 'b', 'g', 'c', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '5': ['a', 'f', 'g', 'c', 'd'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
}

const SEGMENT_ENDPOINTS: Readonly<Record<DigitSegment, readonly [number, number, number, number]>> = {
  a: [0.12, 1, 0.5, 1],
  b: [0.55, 0.94, 0.55, 0.56],
  c: [0.55, 0.44, 0.55, 0.06],
  d: [0.12, 0, 0.5, 0],
  e: [0.05, 0.06, 0.05, 0.44],
  f: [0.05, 0.56, 0.05, 0.94],
  g: [0.12, 0.5, 0.5, 0.5],
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback
}

function resolveOptions(options: LayoutSuggestionOverlayOptions | undefined): ResolvedOverlayOptions {
  const markerRadius = Math.max(2, finiteOr(options?.markerRadius, DEFAULT_OPTIONS.markerRadius))
  const colors = options?.colors?.length ? options.colors : DEFAULT_OPTIONS.colors
  return {
    maxMarkers: Math.max(3, Math.min(6, Math.round(finiteOr(options?.maxMarkers, DEFAULT_OPTIONS.maxMarkers)))),
    markerRadius,
    ringThickness: Math.max(
      0.2,
      Math.min(markerRadius * 0.65, finiteOr(options?.ringThickness, DEFAULT_OPTIONS.ringThickness)),
    ),
    zOffset: Math.max(0.01, finiteOr(options?.zOffset, DEFAULT_OPTIONS.zOffset)),
    opacity: Math.max(0.05, Math.min(1, finiteOr(options?.opacity, DEFAULT_OPTIONS.opacity))),
    colors,
  }
}

function rankSuggestions(
  suggestions: readonly LayoutSuggestionOverlayPoint[],
  maxMarkers: number,
): RankedSuggestion[] {
  return suggestions
    .map((point, sourceIndex) => ({
      point,
      sourceIndex,
      displayRank: Math.max(1, Math.round(point.rank)),
    }))
    .filter(({ point }) => (
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.score) &&
      Number.isFinite(point.rank)
    ))
    .sort((left, right) => (
      left.point.rank - right.point.rank ||
      right.point.score - left.point.score ||
      left.sourceIndex - right.sourceIndex
    ))
    .slice(0, maxMarkers)
}

function appendSegmentQuad(
  positions: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stroke: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return
  const px = -dy / length * stroke / 2
  const py = dx / length * stroke / 2
  const ax = x0 + px, ay = y0 + py
  const bx = x1 + px, by = y1 + py
  const cx = x1 - px, cy = y1 - py
  const dx2 = x0 - px, dy2 = y0 - py
  positions.push(
    ax, ay, 0, bx, by, 0, cx, cy, 0,
    ax, ay, 0, cx, cy, 0, dx2, dy2, 0,
  )
}

/** 用七段数码管式三角面生成编号，不依赖 Canvas、DOM 或字体加载。 */
function createRankNumberGeometry(rank: number, height: number): THREE.BufferGeometry {
  const label = String(rank)
  const glyphWidth = height * 0.62
  const gap = height * 0.12
  const totalWidth = label.length * glyphWidth + Math.max(0, label.length - 1) * gap
  const positions: number[] = []
  const stroke = Math.max(0.35, height * 0.1)

  for (let digitIndex = 0; digitIndex < label.length; digitIndex++) {
    const segments = DIGIT_SEGMENTS[label[digitIndex]] ?? []
    const originX = -totalWidth / 2 + digitIndex * (glyphWidth + gap)
    const originY = -height / 2
    for (const segment of segments) {
      const [x0, y0, x1, y1] = SEGMENT_ENDPOINTS[segment]
      appendSegmentQuad(
        positions,
        originX + x0 * height,
        originY + y0 * height,
        originX + x1 * height,
        originY + y1 * height,
        stroke,
      )
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function createMarker(
  suggestion: RankedSuggestion,
  displayIndex: number,
  markerZ: number,
  options: ResolvedOverlayOptions,
): THREE.Group {
  const { point, sourceIndex, displayRank } = suggestion
  const color = options.colors[displayIndex % options.colors.length]
  const marker = new THREE.Group()
  marker.name = `${LAYOUT_SUGGESTION_MARKER_PREFIX}${displayRank}`
  marker.position.set(point.x, point.y, markerZ)
  marker.renderOrder = 50

  const backdropGeometry = new THREE.CircleGeometry(options.markerRadius * 0.57, 40)
  const backdropMaterial = new THREE.MeshBasicMaterial({
    color: 0x101828,
    transparent: true,
    opacity: 0.76,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  })
  const backdrop = new THREE.Mesh(backdropGeometry, backdropMaterial)
  backdrop.name = `layout-suggestion-backdrop-rank-${displayRank}`
  backdrop.renderOrder = 50
  marker.add(backdrop)

  const ringGeometry = new THREE.RingGeometry(
    options.markerRadius - options.ringThickness,
    options.markerRadius,
    48,
  )
  const ringMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: options.opacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const ring = new THREE.Mesh(ringGeometry, ringMaterial)
  ring.name = `layout-suggestion-ring-rank-${displayRank}`
  ring.position.z = 0.01
  ring.renderOrder = 51
  marker.add(ring)

  const numberGeometry = createRankNumberGeometry(displayRank, options.markerRadius * 0.88)
  const numberMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const number = new THREE.Mesh(numberGeometry, numberMaterial)
  number.name = `layout-suggestion-number-rank-${displayRank}`
  number.position.z = 0.02
  number.renderOrder = 52
  marker.add(number)

  marker.userData.layoutSuggestion = {
    id: point.id,
    x: point.x,
    y: point.y,
    score: point.score,
    rank: point.rank,
    displayRank,
    displayIndex,
    sourceIndex,
    color: new THREE.Color(color).getHex(),
    coordinateSpace: 'viewport-assembly-local',
  }
  ring.userData.layoutSuggestionRole = 'ring'
  number.userData.layoutSuggestionRole = 'number'
  backdrop.userData.layoutSuggestionRole = 'backdrop'
  return marker
}

/**
 * 创建可直接 scene.add() 的边缘优先布局建议叠加层。
 *
 * 输入 x/y 已是 Viewport3D 装配局部坐标，因此不会再应用分板 frame 偏移；所有标记
 * 只在 surfaceZ 上方增加少量 zOffset。
 */
export function createLayoutSuggestionOverlay(input: LayoutSuggestionOverlayInput): THREE.Group {
  const options = resolveOptions(input.options)
  const group = new THREE.Group()
  group.name = LAYOUT_SUGGESTION_OVERLAY_NAME
  const surfaceZ = finiteOr(input.surfaceZ, 0)
  const markerZ = surfaceZ + options.zOffset
  const ranked = rankSuggestions(input.suggestions, options.maxMarkers)

  ranked.forEach((suggestion, index) => {
    group.add(createMarker(suggestion, index, markerZ, options))
  })

  group.userData.layoutSuggestionOverlay = {
    version: 1,
    coordinateSpace: 'viewport-assembly-local',
    surfaceZ,
    markerZ,
    requestedCount: input.suggestions.length,
    markerCount: ranked.length,
    discardedCount: input.suggestions.length - ranked.length,
    maxMarkers: options.maxMarkers,
    ranks: ranked.map(item => item.point.rank),
  }
  return group
}

/** 从场景移除叠加层并释放本工具创建的全部 geometry / material；可安全重复调用。 */
export function disposeLayoutSuggestionOverlay(group: THREE.Group): void {
  group.removeFromParent()
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  group.traverse(object => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    if (renderable.geometry) geometries.add(renderable.geometry)
    if (Array.isArray(renderable.material)) {
      for (const material of renderable.material) materials.add(material)
    } else if (renderable.material) {
      materials.add(renderable.material)
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  group.clear()
  group.userData = {}
}
