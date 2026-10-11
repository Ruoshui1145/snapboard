import type { ArcEntity, ContourSourceMetadata, Point2D } from '../../types/geometry'

export type ShapeApplicationMode = 'replace-outer' | 'insert-inner'

export interface ShapeDraftContour {
  role: 'outer' | 'inner'
  points: Point2D[]
  arcs?: ArcEntity[]
}

export interface ShapeDraftStats {
  width: number
  height: number
  area?: number
  vertexCount: number
}

/** 预制模板与文件导入最终都必须适配到这个单一草图写入契约。 */
export interface ShapeDraft {
  name: string
  contours: ShapeDraftContour[]
  source: ContourSourceMetadata
  warnings: string[]
  errors: string[]
  stats: ShapeDraftStats
}

export function shapeDraftBounds(draft: Pick<ShapeDraft, 'contours'>) {
  const points = draft.contours.flatMap(contour => contour.points)
  if (points.length === 0) return null
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

export function transformShapeDraft(
  draft: ShapeDraft,
  options: {
    width: number
    height: number
    preserveAspect: boolean
    flipX?: boolean
    flipY?: boolean
    rotationDegrees?: number
  },
): ShapeDraft {
  const bounds = shapeDraftBounds(draft)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return draft
  let sx = options.width / bounds.width
  let sy = options.height / bounds.height
  if (options.preserveAspect) {
    const scale = Math.min(sx, sy)
    sx = scale
    sy = scale
  }
  if (options.flipX) sx *= -1
  if (options.flipY) sy *= -1
  const rotationDegrees = Number.isFinite(options.rotationDegrees) ? options.rotationDegrees! : 0
  const angle = rotationDegrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const transformPoint = (point: Point2D): Point2D => {
    const x = (point.x - center.x) * sx
    const y = (point.y - center.y) * sy
    return { x: x * cos - y * sin, y: x * sin + y * cos }
  }
  const mirrored = (sx < 0) !== (sy < 0)
  const contours = draft.contours.map(contour => ({
    ...contour,
    points: contour.points.map(transformPoint),
    arcs: contour.arcs?.map(arc => ({
      ...arc,
      center: transformPoint(arc.center),
      // 非等比缩放无法继续表示精确圆弧；调用者应在这种情况下传入离散点列。
      radius: arc.radius * Math.min(Math.abs(sx), Math.abs(sy)),
      sweep: mirrored ? (arc.sweep === 'cw' ? 'ccw' : 'cw') : arc.sweep,
    })),
  }))
  const resizedBounds = shapeDraftBounds({ contours })!
  return {
    ...draft,
    contours,
    source: {
      ...draft.source,
      params: {
        ...draft.source.params,
        width: resizedBounds.width,
        height: resizedBounds.height,
        rotation: rotationDegrees,
      },
    },
    stats: {
      ...draft.stats,
      width: resizedBounds.width,
      height: resizedBounds.height,
      area: draft.stats.area === undefined ? undefined : draft.stats.area * Math.abs(sx * sy),
    },
  }
}
