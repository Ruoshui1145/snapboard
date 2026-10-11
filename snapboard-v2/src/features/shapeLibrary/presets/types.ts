import type { ArcEntity, Point2D } from '../../../types/geometry'

/** Built-in identifiers are stable and may be persisted in project files. */
export const SHAPE_PRESET_IDS = [
  'rectangle', 'square', 'rounded-rectangle', 'circle', 'ellipse',
  'cloud',
  'arch',
  'heart',
  'star',
  'crescent',
  'wave',
  'house',
  'capsule',
] as const

export type ShapePresetId = (typeof SHAPE_PRESET_IDS)[number]

export type ShapePresetCategory = 'organic' | 'decorative' | 'architectural' | 'basic'

/**
 * Common preset parameters. Width and height use the caller's current sketch unit.
 * detail and smoothing are normalized values in the inclusive range 0..1.
 * When lockAspect is true, width is authoritative and height follows the preset's
 * native aspect ratio.
 */
export interface ShapePresetParams {
  cornerRadius?: number
  width: number
  height: number
  lockAspect: boolean
  flipX: boolean
  flipY: boolean
  detail: number
  smoothing: number
}

export interface ShapePresetBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface GeneratedShape {
  presetId: ShapePresetId
  /** Localized display name copied from the catalog for application adapters. */
  name: string
  /** Closed contours use the SnapBoard convention: the first point is not repeated. */
  closed: true
  points: Point2D[]
  /** Reserved for generators that can preserve exact circular edges. */
  arcs: ArcEntity[]
  bounds: ShapePresetBounds
  /** Fully resolved parameters, including aspect-ratio adjustment and clamping. */
  params: ShapePresetParams
}

export interface ShapePresetLimits {
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
}

export interface ShapePresetCapabilities {
  detail: boolean
  smoothing: boolean
  flipX: boolean
  flipY: boolean
}

export interface ShapePresetDefinition {
  id: ShapePresetId
  name: string
  description: string
  category: ShapePresetCategory
  /** width / height ratio used when lockAspect is enabled. */
  nativeAspectRatio: number
  defaultParams: Readonly<ShapePresetParams>
  limits: Readonly<ShapePresetLimits>
  capabilities: Readonly<ShapePresetCapabilities>
  generate: (params?: Partial<ShapePresetParams>) => GeneratedShape
}

export type { ArcEntity, Point2D }
