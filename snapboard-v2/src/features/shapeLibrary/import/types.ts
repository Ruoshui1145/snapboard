export interface ImportPoint {
  x: number
  y: number
}

export interface ImportBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export type ShapeImportIssueSeverity = 'warning' | 'error'

export interface ShapeImportIssue {
  severity: ShapeImportIssueSeverity
  code: string
  message: string
  loopIndex?: number
  details?: Record<string, number | string | boolean>
}

/**
 * Intermediate contract shared by SVG and bitmap importers.
 * Rings do not repeat their first vertex. Coordinates use the source's y-down space.
 * A normalized draft has a positive-area outer ring and negative-area hole rings.
 */
export interface ImportedShapeDraft {
  version: 1
  source: 'svg' | 'bitmap'
  name: string
  outer: ImportPoint[]
  holes: ImportPoint[][]
  /** Closed components outside the selected primary outline. They are never silently merged. */
  fragments: ImportPoint[][]
  bounds: ImportBounds
  sourceWidth?: number
  sourceHeight?: number
}

export interface ShapeImportResult {
  draft: ImportedShapeDraft | null
  warnings: ShapeImportIssue[]
  errors: ShapeImportIssue[]
}

export interface ShapeValidationOptions {
  /** Consecutive points at or below this distance are treated as duplicates. */
  pointTolerance?: number
  /** Maximum accepted vertices across the outer ring and all holes. */
  maxVertices?: number
  /** Hard input guard, applied before potentially quadratic checks. */
  hardVertexLimit?: number
  /** If provided, close non-adjacent edges closer than this value emit a narrow-feature warning. */
  minFeatureWidth?: number
  /** Components below this area emit a small-fragment warning. */
  minFragmentArea?: number
  /** Translate the normalized draft so its minimum x/y are zero. */
  moveToOrigin?: boolean
  /** Allow an explicit, warned simplification when maxVertices is exceeded. */
  simplifyExcessVertices?: boolean
  /** Initial simplification tolerance; the validator raises it as needed to meet maxVertices. */
  simplifyTolerance?: number
}

export interface ShapeValidationResult extends ShapeImportResult {
  valid: boolean
}

export interface ImportedContourAdapter {
  type: 'outer' | 'inner'
  name: string
  points: ImportPoint[]
  closed: true
}

export interface ShapeAdapterOptions {
  targetWidth?: number
  targetHeight?: number
  preserveAspect?: boolean
  originX?: number
  originY?: number
  outerName?: string
  holeNamePrefix?: string
}

export interface SvgImportOptions extends ShapeValidationOptions {
  name?: string
  /** Maximum chord/flatness error in SVG user units. */
  curveTolerance?: number
  maxCurveSegments?: number
}

export interface ImageDataLike {
  width: number
  height: number
  data: ArrayLike<number>
}

export interface BitmapImportOptions extends ShapeValidationOptions {
  name?: string
  thresholdMode?: 'auto' | 'alpha' | 'luminance'
  alphaThreshold?: number
  luminanceThreshold?: number
  invert?: boolean
  /** How thick closed hand-drawn strokes should become board material. */
  outlineInterpretation?: 'auto' | 'silhouette' | 'closed-stroke'
  /** Ramer-Douglas-Peucker tolerance in source pixels. */
  simplifyTolerance?: number
  /** Chaikin corner-cutting passes, clamped to 0..3. */
  smoothingPasses?: number
  /** Refuse unexpectedly large decoded images before allocating work buffers. */
  maxPixels?: number
  /** Ignore isolated foreground components smaller than this many pixels. */
  minComponentPixels?: number
  /** Maximum disconnected foreground components retained as separate board outlines. */
  maxComponents?: number
}
