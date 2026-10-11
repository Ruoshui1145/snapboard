export type ShapeLibraryTab = 'presets' | 'upload' | 'recent'

export type ShapeLibraryApplicationMode = 'replace-outer' | 'insert-hole'

export type BuiltInShapeKind =
  | 'cloud'
  | 'arch'
  | 'heart'
  | 'star'
  | 'crescent'
  | 'wave'
  | 'house'
  | 'capsule'

export interface ShapeLibraryPreset {
  id: string
  name: string
  kind: BuiltInShapeKind | string
  description?: string
  tags?: string[]
  thumbnailPath?: string
  thumbnailViewBox?: string
  defaultWidth: number
  defaultHeight: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  recommended?: boolean
  lastUsedAt?: number
}

export interface ShapeLibraryParameters {
  width: number
  height: number
  lockAspectRatio: boolean
  flipX: boolean
  flipY: boolean
  /** Clockwise visual rotation in degrees, normalized by the UI to -180..180. */
  rotation: number
  smoothing: number
  detail: number
}

export interface ShapeLibraryImportOptions {
  threshold: number
  invert: boolean
  outlineInterpretation: 'auto' | 'silhouette' | 'closed-stroke'
  smoothing: number
  simplify: number
}

export interface ShapeLibraryPreviewPath {
  d: string
  fillRule?: 'nonzero' | 'evenodd'
}

export interface ShapeLibraryPreviewSummary {
  area?: number
  vertexCount?: number
  contourCount?: number
  minFeatureWidth?: number
  width?: number
  height?: number
}

export interface ShapeLibraryPoint {
  x: number
  y: number
}

export interface ShapeLibraryContour<TPoint = ShapeLibraryPoint, TArc = unknown> {
  id?: string
  role: 'outer' | 'inner'
  points: TPoint[]
  arcs?: TArc[]
}

/** 与生成器、上传解析器和草图接入层之间传递的统一板型对象。 */
export interface ShapeLibraryGeometry<TPoint = ShapeLibraryPoint, TArc = unknown> {
  name: string
  contours: Array<ShapeLibraryContour<TPoint, TArc>>
  source: {
    kind: 'preset' | 'svg' | 'image'
    id?: string
    fileName?: string
    params?: Record<string, unknown>
  }
  warnings: string[]
  errors: string[]
  stats: ShapeLibraryPreviewSummary
}

/**
 * UI 可显示的预览结果。geometry 会原样传给 onApply，弹窗不读取其内部结构。
 */
export interface ShapeLibraryPreviewResult<TGeometry = ShapeLibraryGeometry> {
  geometry: TGeometry
  paths?: ShapeLibraryPreviewPath[]
  viewBox?: string
  previewImageUrl?: string
  warnings?: string[]
  errors?: string[]
  summary?: ShapeLibraryPreviewSummary
}

export interface ShapeLibraryPresetPreviewRequest {
  preset: ShapeLibraryPreset
  parameters: ShapeLibraryParameters
}

export interface ShapeLibraryUploadRequest {
  file: File
  options: ShapeLibraryImportOptions
}

export interface ShapeLibraryApplyRequest {
  source:
    | { type: 'preset'; presetId: string }
    | { type: 'upload'; fileName: string; mimeType: string }
  applicationMode: ShapeLibraryApplicationMode
  parameters: ShapeLibraryParameters
  importOptions?: ShapeLibraryImportOptions
}

export type GenerateShapeLibraryPreview<TGeometry = ShapeLibraryGeometry> = (
  request: ShapeLibraryPresetPreviewRequest,
  signal: AbortSignal,
) => ShapeLibraryPreviewResult<TGeometry> | Promise<ShapeLibraryPreviewResult<TGeometry>>

export type ParseShapeLibraryUpload<TGeometry = ShapeLibraryGeometry> = (
  request: ShapeLibraryUploadRequest,
  signal: AbortSignal,
) => ShapeLibraryPreviewResult<TGeometry> | Promise<ShapeLibraryPreviewResult<TGeometry>>
