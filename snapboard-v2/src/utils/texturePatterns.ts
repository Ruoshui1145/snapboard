import type { Point2D } from '../types/geometry'

export type TexturePatternId = 'square' | 'triangle' | 'hexagon' | 'truchet-arcs'
export type TexturePatternStyle = 'filled' | 'outline' | 'alternating'
export type TexturePatternPeriodicity = 'periodic' | 'seeded-stochastic'

export interface TexturePatternBounds {
  minX: number
  minY: number
  width: number
  height: number
}

export interface TexturePatternConfig {
  id: TexturePatternId
  /** Stable unsigned 32-bit seed. Regular tilings use it as a color phase. */
  seed: number
  /** Nominal edge length / square pitch in millimeters. */
  cellSizeMm: number
  /** Manufacturing-oriented decorative stroke width in millimeters. */
  lineWidthMm: number
  palette: string[]
  style: TexturePatternStyle
  /** Probability of the first Truchet orientation, in the closed range 0..1. */
  truchetOrientationBias?: number
  /** Safety cap shared by preview and export callers. */
  maxPrimitives?: number
}

interface TexturePatternPrimitiveBase {
  /** Stable world-cell identity; independent from the requested crop. */
  key: string
  paletteIndex: number
}

export interface TexturePatternPolygon extends TexturePatternPrimitiveBase {
  kind: 'polygon'
  points: Point2D[]
}

export interface TexturePatternArc extends TexturePatternPrimitiveBase {
  kind: 'arc'
  center: Point2D
  radius: number
  startAngle: number
  endAngle: number
}

export type TexturePatternPrimitive = TexturePatternPolygon | TexturePatternArc

export interface TexturePatternStats {
  primitiveCount: number
  cellCount: number
  minFeatureMm: number
  periodicity: TexturePatternPeriodicity
  capped: boolean
}

export interface TexturePatternResult {
  config: TexturePatternConfig
  primitives: TexturePatternPrimitive[]
  stats: TexturePatternStats
}

const DEFAULT_MAX_PRIMITIVES = 50_000
const SQRT3 = Math.sqrt(3)
const TAU = Math.PI * 2

const DEFAULT_CONFIGS: Record<TexturePatternId, TexturePatternConfig> = {
  square: {
    id: 'square', seed: 1, cellSizeMm: 16, lineWidthMm: 0.8,
    palette: ['#F3F1E9', '#15171C'], style: 'alternating',
  },
  triangle: {
    id: 'triangle', seed: 1, cellSizeMm: 18, lineWidthMm: 0.8,
    palette: ['#16324F', '#38BDAE', '#F3D46B'], style: 'alternating',
  },
  hexagon: {
    id: 'hexagon', seed: 1, cellSizeMm: 18, lineWidthMm: 0.8,
    palette: ['#102A43', '#2CB1BC', '#D9E2EC'], style: 'alternating',
  },
  'truchet-arcs': {
    id: 'truchet-arcs', seed: 1, cellSizeMm: 20, lineWidthMm: 1,
    palette: ['#0B132B', '#5BC0BE'], style: 'outline', truchetOrientationBias: 0.5,
  },
}

const finiteOr = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, finiteOr(value, min)))
const positiveMod = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor

const normalizeHexColor = (value: string, fallback: string): string =>
  /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback

export function createDefaultTexturePattern(id: TexturePatternId = 'square'): TexturePatternConfig {
  const source = DEFAULT_CONFIGS[id]
  return { ...source, palette: [...source.palette] }
}

export function normalizeTexturePattern(config: Partial<TexturePatternConfig>): TexturePatternConfig {
  const id: TexturePatternId = config.id && config.id in DEFAULT_CONFIGS ? config.id : 'square'
  const defaults = DEFAULT_CONFIGS[id]
  const palette = Array.isArray(config.palette)
    ? config.palette.slice(0, 8).map((color, index) => normalizeHexColor(color, defaults.palette[index % defaults.palette.length]))
    : [...defaults.palette]
  return {
    ...defaults,
    ...config,
    id,
    seed: finiteOr(config.seed ?? defaults.seed, defaults.seed) >>> 0,
    cellSizeMm: clamp(config.cellSizeMm ?? defaults.cellSizeMm, 1, 500),
    lineWidthMm: clamp(config.lineWidthMm ?? defaults.lineWidthMm, 0.1, 20),
    palette: palette.length >= 2 ? palette : [...defaults.palette],
    style: config.style === 'filled' || config.style === 'outline' || config.style === 'alternating'
      ? config.style
      : defaults.style,
    truchetOrientationBias: clamp(config.truchetOrientationBias ?? defaults.truchetOrientationBias ?? 0.5, 0, 1),
    maxPrimitives: Math.round(clamp(config.maxPrimitives ?? DEFAULT_MAX_PRIMITIVES, 1, 1_000_000)),
  }
}

/**
 * Coordinate-addressed 32-bit hash. Unlike a sequential PRNG, this is invariant
 * when callers crop the render bounds or generate neighboring split panels.
 */
export function texturePatternCellHash(seed: number, column: number, row: number): number {
  let value = (seed >>> 0) ^ Math.imul(column | 0, 0x9e3779b1) ^ Math.imul(row | 0, 0x85ebca77)
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

export function texturePatternCellRandom(seed: number, column: number, row: number): number {
  return texturePatternCellHash(seed, column, row) / 0x1_0000_0000
}

const safeBounds = (bounds: TexturePatternBounds): TexturePatternBounds => ({
  minX: finiteOr(bounds.minX, 0),
  minY: finiteOr(bounds.minY, 0),
  width: Math.max(0.001, finiteOr(bounds.width, 1)),
  height: Math.max(0.001, finiteOr(bounds.height, 1)),
})

const polygonBounds = (points: Point2D[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

const overlapsBounds = (
  minX: number, minY: number, maxX: number, maxY: number,
  bounds: TexturePatternBounds,
) => minX <= bounds.minX + bounds.width && maxX >= bounds.minX &&
  minY <= bounds.minY + bounds.height && maxY >= bounds.minY

class PatternCollector {
  readonly primitives: TexturePatternPrimitive[] = []
  readonly cells = new Set<string>()
  readonly limit: number
  capped = false

  constructor(limit: number) {
    this.limit = limit
  }

  add(primitive: TexturePatternPrimitive): boolean {
    if (this.primitives.length >= this.limit) {
      this.capped = true
      return false
    }
    this.primitives.push(primitive)
    this.cells.add(primitive.key.split('/')[0])
    return true
  }
}

const palettePhase = (config: TexturePatternConfig) => config.seed % config.palette.length
const paletteAt = (config: TexturePatternConfig, value: number) => positiveMod(value + palettePhase(config), config.palette.length)

function generateSquares(config: TexturePatternConfig, bounds: TexturePatternBounds, output: PatternCollector): void {
  const size = config.cellSizeMm
  const minColumn = Math.floor(bounds.minX / size) - 1
  const maxColumn = Math.ceil((bounds.minX + bounds.width) / size) + 1
  const minRow = Math.floor(bounds.minY / size) - 1
  const maxRow = Math.ceil((bounds.minY + bounds.height) / size) + 1
  for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) {
    const x0 = column * size, y0 = row * size
    const points = [
      { x: x0, y: y0 }, { x: x0 + size, y: y0 },
      { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size },
    ]
    if (!overlapsBounds(x0, y0, x0 + size, y0 + size, bounds)) continue
    if (!output.add({ kind: 'polygon', key: `square:${column}:${row}/0`, points, paletteIndex: paletteAt(config, column + row) })) return
  }
}

function generateTriangles(config: TexturePatternConfig, bounds: TexturePatternBounds, output: PatternCollector): void {
  const size = config.cellSizeMm
  const height = size * SQRT3 / 2
  const minRow = Math.floor(bounds.minY / height) - 2
  const maxRow = Math.ceil((bounds.minY + bounds.height) / height) + 2
  for (let row = minRow; row <= maxRow; row++) {
    const rowOffset = row * size / 2
    const minColumn = Math.floor((bounds.minX - rowOffset) / size) - 2
    const maxColumn = Math.ceil((bounds.minX + bounds.width - rowOffset) / size) + 2
    for (let column = minColumn; column <= maxColumn; column++) {
      const x = column * size + rowOffset
      const y = row * height
      const lowerLeft = { x, y }
      const lowerRight = { x: x + size, y }
      const upperLeft = { x: x + size / 2, y: y + height }
      const upperRight = { x: x + size * 1.5, y: y + height }
      const triangles: Point2D[][] = [
        [lowerLeft, lowerRight, upperLeft],
        [lowerRight, upperRight, upperLeft],
      ]
      for (let half = 0; half < triangles.length; half++) {
        const points = triangles[half]
        const box = polygonBounds(points)
        if (!overlapsBounds(box.minX, box.minY, box.maxX, box.maxY, bounds)) continue
        if (!output.add({
          kind: 'polygon', key: `triangle:${column}:${row}/` + half, points,
          paletteIndex: paletteAt(config, column + row + half),
        })) return
      }
    }
  }
}

function hexagonPoints(centerX: number, centerY: number, radius: number): Point2D[] {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = index * Math.PI / 3
    return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius }
  })
}

function generateHexagons(config: TexturePatternConfig, bounds: TexturePatternBounds, output: PatternCollector): void {
  const radius = config.cellSizeMm
  const columnPitch = radius * 1.5
  const rowPitch = radius * SQRT3
  const minColumn = Math.floor((bounds.minX - radius) / columnPitch) - 1
  const maxColumn = Math.ceil((bounds.minX + bounds.width + radius) / columnPitch) + 1
  for (let column = minColumn; column <= maxColumn; column++) {
    const rowOffset = column / 2
    const minRow = Math.floor((bounds.minY - radius) / rowPitch - rowOffset) - 1
    const maxRow = Math.ceil((bounds.minY + bounds.height + radius) / rowPitch - rowOffset) + 1
    for (let row = minRow; row <= maxRow; row++) {
      const centerX = column * columnPitch
      const centerY = (row + rowOffset) * rowPitch
      const points = hexagonPoints(centerX, centerY, radius)
      if (!overlapsBounds(centerX - radius, centerY - radius * SQRT3 / 2,
        centerX + radius, centerY + radius * SQRT3 / 2, bounds)) continue
      if (!output.add({
        kind: 'polygon', key: `hexagon:${column}:${row}/0`, points,
        paletteIndex: paletteAt(config, column - row),
      })) return
    }
  }
}

function generateTruchet(config: TexturePatternConfig, bounds: TexturePatternBounds, output: PatternCollector): void {
  const size = config.cellSizeMm
  const radius = size / 2
  const minColumn = Math.floor(bounds.minX / size) - 1
  const maxColumn = Math.ceil((bounds.minX + bounds.width) / size) + 1
  const minRow = Math.floor(bounds.minY / size) - 1
  const maxRow = Math.ceil((bounds.minY + bounds.height) / size) + 1
  const bias = config.truchetOrientationBias ?? 0.5
  const foreground = config.palette.length > 1 ? 1 : 0
  for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) {
    const x0 = column * size, y0 = row * size
    if (!overlapsBounds(x0, y0, x0 + size, y0 + size, bounds)) continue
    const first = texturePatternCellRandom(config.seed, column, row) < bias
    const cellKey = `truchet:${column}:${row}`
    const arcs: Array<Omit<TexturePatternArc, 'kind' | 'key' | 'paletteIndex'>> = first
      ? [
          { center: { x: x0, y: y0 }, radius, startAngle: 0, endAngle: Math.PI / 2 },
          { center: { x: x0 + size, y: y0 + size }, radius, startAngle: Math.PI, endAngle: Math.PI * 1.5 },
        ]
      : [
          { center: { x: x0, y: y0 + size }, radius, startAngle: -Math.PI / 2, endAngle: 0 },
          { center: { x: x0 + size, y: y0 }, radius, startAngle: Math.PI / 2, endAngle: Math.PI },
        ]
    for (let index = 0; index < arcs.length; index++) {
      if (!output.add({ kind: 'arc', key: `${cellKey}/${index}`, paletteIndex: foreground, ...arcs[index] })) return
    }
  }
}

export function generateTexturePattern(
  requestedConfig: Partial<TexturePatternConfig>,
  requestedBounds: TexturePatternBounds,
): TexturePatternResult {
  const config = normalizeTexturePattern(requestedConfig)
  const bounds = safeBounds(requestedBounds)
  const output = new PatternCollector(config.maxPrimitives ?? DEFAULT_MAX_PRIMITIVES)
  if (config.id === 'square') generateSquares(config, bounds, output)
  else if (config.id === 'triangle') generateTriangles(config, bounds, output)
  else if (config.id === 'hexagon') generateHexagons(config, bounds, output)
  else generateTruchet(config, bounds, output)
  return {
    config,
    primitives: output.primitives,
    stats: {
      primitiveCount: output.primitives.length,
      cellCount: output.cells.size,
      minFeatureMm: config.id === 'truchet-arcs' || config.style === 'outline'
        ? config.lineWidthMm
        : config.cellSizeMm * (config.id === 'triangle' ? SQRT3 / 2 : 1),
      periodicity: config.id === 'truchet-arcs' ? 'seeded-stochastic' : 'periodic',
      capped: output.capped,
    },
  }
}

function tracePolygon(ctx: CanvasRenderingContext2D, points: Point2D[]): void {
  if (!points.length) return
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y)
  ctx.closePath()
}

/** Render directly into a caller-owned Canvas without allocating an intermediate bitmap. */
export function renderTexturePatternToContext(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  requestedConfig: Partial<TexturePatternConfig>,
  requestedBounds: TexturePatternBounds,
): TexturePatternResult {
  const result = generateTexturePattern(requestedConfig, requestedBounds)
  const bounds = safeBounds(requestedBounds)
  const scale = Math.min(canvasWidth / bounds.width, canvasHeight / bounds.height)
  const contentWidth = bounds.width * scale
  const contentHeight = bounds.height * scale
  const padX = (canvasWidth - contentWidth) / 2
  const padY = (canvasHeight - contentHeight) / 2
  const palette = result.config.palette

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  ctx.fillStyle = palette[0]
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)
  ctx.translate(padX - bounds.minX * scale, padY + (bounds.minY + bounds.height) * scale)
  ctx.scale(scale, -scale)
  ctx.lineWidth = result.config.lineWidthMm
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const primitive of result.primitives) {
    const color = result.config.style === 'outline'
      ? palette[Math.min(1, palette.length - 1)]
      : palette[primitive.paletteIndex % palette.length]
    if (primitive.kind === 'arc') {
      ctx.beginPath()
      ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, primitive.startAngle, primitive.endAngle)
      ctx.strokeStyle = color
      ctx.stroke()
      continue
    }
    tracePolygon(ctx, primitive.points)
    if (result.config.style === 'outline') {
      ctx.strokeStyle = color
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.fill()
    }
  }
  ctx.restore()
  return result
}

export function renderTexturePatternCanvas(
  canvas: HTMLCanvasElement,
  config: Partial<TexturePatternConfig>,
  bounds: TexturePatternBounds,
): TexturePatternResult | null {
  const ctx = canvas.getContext('2d')
  return ctx ? renderTexturePatternToContext(ctx, canvas.width, canvas.height, config, bounds) : null
}

export const TEXTURE_PATTERN_TAU = TAU
