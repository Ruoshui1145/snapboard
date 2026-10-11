import type {
  GenerateShapeLibraryPreview,
  ParseShapeLibraryUpload,
  ShapeLibraryPreset,
  ShapeLibraryPreviewResult,
} from '../../components/shapeLibrary'
import {
  adaptImportedShapeDraft,
  importBitmapImageData,
  importSvgString,
  type ImageDataLike,
  type ShapeImportIssue,
  type ShapeImportResult,
} from './import'
import { presetToShapeDraft, shapeLibraryPresetItems } from './adapters'
import { shapeDraftBounds, type ShapeDraft } from './model'

export const shapeLibraryPresets: ShapeLibraryPreset[] = shapeLibraryPresetItems.map((preset, index) => ({
  id: preset.id,
  kind: preset.kind,
  name: preset.name,
  description: preset.description,
  tags: [preset.category],
  defaultWidth: preset.defaultParams.width,
  defaultHeight: preset.defaultParams.height,
  minWidth: preset.limits.minWidth,
  minHeight: preset.limits.minHeight,
  maxWidth: preset.limits.maxWidth,
  maxHeight: preset.limits.maxHeight,
  recommended: index < 5,
}))

const issueMessages = (issues: ShapeImportIssue[]) => issues.map(issue => issue.message)

const ringPath = (points: Array<{ x: number; y: number }>) => {
  if (points.length === 0) return ''
  return `M ${points.map((point, index) => `${index ? 'L ' : ''}${point.x.toFixed(3)} ${point.y.toFixed(3)}`).join(' ')} Z`
}

const signedArea = (points: Array<{ x: number; y: number }>) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]
  return sum + point.x * next.y - next.x * point.y
}, 0) / 2

export function shapeDraftPreview(draft: ShapeDraft): ShapeLibraryPreviewResult<ShapeDraft> {
  const bounds = shapeDraftBounds(draft)
  const pad = bounds ? Math.max(bounds.width, bounds.height) * 0.06 : 0
  const area = Math.max(0, draft.contours.reduce((sum, contour) =>
    sum + (contour.role === 'outer' ? 1 : -1) * Math.abs(signedArea(contour.points)), 0))
  const summary = {
    area,
    vertexCount: draft.contours.reduce((sum, contour) => sum + contour.points.length, 0),
    contourCount: draft.contours.length,
    width: bounds?.width ?? 0,
    height: bounds?.height ?? 0,
  }
  return {
    geometry: { ...draft, stats: { ...draft.stats, ...summary } },
    paths: [{ d: draft.contours.map(contour => ringPath(contour.points)).join(' '), fillRule: 'evenodd' }],
    viewBox: bounds
      ? `${bounds.minX - pad} ${bounds.minY - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`
      : '0 0 100 100',
    warnings: draft.warnings,
    errors: draft.errors,
    summary,
  }
}

export const generateShapeLibraryPreview: GenerateShapeLibraryPreview<ShapeDraft> = async (
  { preset, parameters },
  signal,
) => {
  if (signal.aborted) throw new DOMException('板型预览已取消', 'AbortError')
  // 弹窗自身负责翻转预览；应用时会使用同一组参数重新生成真实几何，避免双重翻转。
  const draft = presetToShapeDraft(preset.id as Parameters<typeof presetToShapeDraft>[0], {
    width: parameters.width,
    height: parameters.height,
    lockAspect: parameters.lockAspectRatio,
    flipX: false,
    flipY: false,
    smoothing: parameters.smoothing / 100,
    detail: parameters.detail / 100,
  })
  return shapeDraftPreview(draft)
}

async function decodeBitmap(file: File, signal: AbortSignal): Promise<ImageDataLike> {
  if (signal.aborted) throw new DOMException('图片解析已取消', 'AbortError')
  const bitmap = await createImageBitmap(file)
  try {
    if (signal.aborted) throw new DOMException('图片解析已取消', 'AbortError')
    if (bitmap.width * bitmap.height > 16_000_000) throw new Error('图片像素过多，请先缩小到 1600 万像素以内')
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height })
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('浏览器无法读取图片像素')
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

function importedResultToDraft(result: ShapeImportResult, file: File): ShapeDraft {
  const warnings = issueMessages(result.warnings)
  const errors = issueMessages(result.errors)
  if (!result.draft) {
    return {
      name: file.name.replace(/\.[^.]+$/, '') || '自定义板型',
      contours: [],
      source: { kind: file.type === 'image/svg+xml' || /\.svg$/i.test(file.name) ? 'svg' : 'image', fileName: file.name },
      warnings,
      errors: errors.length ? errors : ['没有识别到可用的闭合轮廓'],
      stats: { width: 0, height: 0, vertexCount: 0 },
    }
  }
  const contours = adaptImportedShapeDraft(result.draft).map(contour => ({
    role: contour.type,
    points: contour.points,
  }))
  return {
    name: result.draft.name,
    contours,
    source: {
      kind: result.draft.source === 'svg' ? 'svg' : 'image',
      fileName: file.name,
    },
    warnings,
    errors,
    stats: {
      width: result.draft.bounds.width,
      height: result.draft.bounds.height,
      vertexCount: contours.reduce((sum, contour) => sum + contour.points.length, 0),
    },
  }
}

export const parseShapeLibraryUpload: ParseShapeLibraryUpload<ShapeDraft> = async (
  { file, options },
  signal,
) => {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
  let result: ShapeImportResult
  if (isSvg) {
    const source = await file.text()
    if (signal.aborted) throw new DOMException('SVG 解析已取消', 'AbortError')
    result = importSvgString(source, {
      name: file.name.replace(/\.svg$/i, ''),
      curveTolerance: 0.15 + options.simplify / 100 * 1.35,
      simplifyTolerance: 0.05 + options.simplify / 100 * 1.5,
      maxVertices: 2400,
      minFeatureWidth: 1,
    })
  } else {
    const image = await decodeBitmap(file, signal)
    result = importBitmapImageData(image, {
      name: file.name.replace(/\.[^.]+$/, ''),
      thresholdMode: 'auto',
      alphaThreshold: options.threshold,
      luminanceThreshold: options.threshold,
      invert: options.invert,
      outlineInterpretation: options.outlineInterpretation,
      simplifyTolerance: 0.05 + options.simplify / 100 * 1.45,
      smoothingPasses: Math.round(options.smoothing / 50),
      maxVertices: 2400,
      minFeatureWidth: 1,
      maxPixels: 16_000_000,
      maxComponents: 96,
    })
  }
  if (signal.aborted) throw new DOMException('轮廓解析已取消', 'AbortError')
  return shapeDraftPreview(importedResultToDraft(result, file))
}
