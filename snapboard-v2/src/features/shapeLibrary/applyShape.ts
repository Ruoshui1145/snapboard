import { CompositeCommand, type Command } from '../../commands/Command'
import {
  ClearSketchContoursCommand,
  CreateContourCommand,
  RemoveContourCommand,
} from '../../commands/SketchCommands'
import { useAppStore } from '../../store/useAppStore'
import type { ArcEntity, Contour, Point2D } from '../../types/geometry'
import { shapeDraftBounds, type ShapeApplicationMode, type ShapeDraft } from './model'

const nextShapeContourId = () =>
  `shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

// 板型库、SVG/位图与当前草图 Canvas 都使用 y 向下坐标；这里只平移，不翻转。
const placePoints = (points: Point2D[], dx: number, dy: number) =>
  points.map(point => ({ x: point.x + dx, y: point.y + dy }))

const placeArcs = (arcs: ArcEntity[] | undefined, dx: number, dy: number): ArcEntity[] | undefined =>
  arcs?.map(arc => ({
    ...arc,
    center: { x: arc.center.x + dx, y: arc.center.y + dy },
  }))

const pointInPolygon = (point: Point2D, polygon: Point2D[]) => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

/** 板型库参数统一使用毫米；草图轮廓继续使用项目世界单位。 */
function draftMillimetersToWorld(draft: ShapeDraft): ShapeDraft {
  const mmPerWorldUnit = useAppStore.getState().project.config.pixelToMM
  if (!Number.isFinite(mmPerWorldUnit) || mmPerWorldUnit <= 0) {
    throw new Error('当前工程的毫米比例无效，无法应用板型')
  }
  const scale = 1 / mmPerWorldUnit
  if (Math.abs(scale - 1) <= 1e-12) return draft
  return {
    ...draft,
    contours: draft.contours.map(contour => ({
      ...contour,
      points: contour.points.map(point => ({ x: point.x * scale, y: point.y * scale })),
      arcs: contour.arcs?.map(arc => ({
        ...arc,
        center: { x: arc.center.x * scale, y: arc.center.y * scale },
        radius: arc.radius * scale,
      })),
    })),
  }
}

const activeSketch = () => {
  const state = useAppStore.getState()
  const sketches = state.project.parts
    .flatMap(part => part.features)
    .filter(feature => feature.type === 'sketch')
  return sketches.find(sketch => sketch.id === state.ui.activeSketchId) ?? sketches[0] ?? null
}

function applicationOffset(draft: ShapeDraft, mode: ShapeApplicationMode) {
  const bounds = shapeDraftBounds(draft)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error('板型轮廓为空或尺寸无效')
  if (mode === 'replace-outer') {
    // 放在草图原点右下区域；草图 Canvas 与导入轮廓都采用 y 向下坐标。
    return { dx: -bounds.minX, dy: -bounds.minY, containingOuter: null as Contour | null }
  }

  const sketch = activeSketch()
  const outer = sketch?.contours.find(contour => contour.type === 'outer' && contour.closed)
  if (!outer) throw new Error('插入内孔前需要先创建一个闭合外轮廓')
  const xs = outer.points.map(point => point.x)
  const ys = outer.points.map(point => point.y)
  const center = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  }
  return {
    dx: center.x - (bounds.minX + bounds.maxX) / 2,
    dy: center.y - (bounds.minY + bounds.maxY) / 2,
    containingOuter: outer,
  }
}

/**
 * 把板型库结果作为一个可撤销事务写入当前草图。
 * 替换外轮廓复用“重画”事务，确保旧分割、配件、纹理和分析状态不会悬空保留。
 */
export function applyShapeDraft(draft: ShapeDraft, mode: ShapeApplicationMode, options: { preservePosition?: boolean; replaceContourIds?: string[]; viewMode?: '2d' | '3d' } = {}): string[] {
  if (draft.errors.length > 0) throw new Error(draft.errors.join('；'))
  if (draft.contours.length === 0) throw new Error('没有可应用的闭合轮廓')
  const worldDraft = draftMillimetersToWorld(draft)
  const placement = applicationOffset(worldDraft, mode)
  const { containingOuter } = placement
  const dx = options.preservePosition ? 0 : placement.dx
  const dy = options.preservePosition ? 0 : placement.dy
  const prepared = worldDraft.contours.map(contour => ({
    ...contour,
    points: placePoints(contour.points, dx, dy),
    arcs: placeArcs(contour.arcs, dx, dy),
  }))

  if (mode === 'insert-inner') {
    const silhouettes = prepared.filter(contour => contour.role === 'outer')
    const outers = options.preservePosition
      ? activeSketch()?.contours.filter(contour => contour.type === 'outer' && contour.closed) ?? []
      : containingOuter ? [containingOuter] : []
    if (silhouettes.length === 0 || silhouettes.some(silhouette => !outers.some(outer =>
      silhouette.points.every(point => pointInPolygon(point, outer.points))))) {
      throw new Error('当前板型尺寸超出外轮廓，请缩小宽度或高度后重试')
    }
  }

  const sketch = activeSketch()
  const commands: Command[] = []
  if (mode === 'replace-outer') commands.push(new ClearSketchContoursCommand(sketch?.id ?? null))
  if (mode === 'insert-inner') commands.push(...(options.replaceContourIds ?? []).map(id => new RemoveContourCommand(id)))

  const contoursToCreate = mode === 'insert-inner'
    ? prepared.filter(contour => contour.role === 'outer')
    : prepared
  const createdIds: string[] = []
  contoursToCreate.forEach((draftContour, index) => {
    const id = nextShapeContourId()
    createdIds.push(id)
    commands.push(new CreateContourCommand({
      id,
      type: mode === 'insert-inner' ? 'inner' : draftContour.role,
      name: `${draft.name}${draftContour.role === 'inner' ? ` 内孔 ${index}` : ''}`,
      source: { ...draft.source, params: draft.source.params ? { ...draft.source.params } : undefined },
      points: draftContour.points.map(point => ({ ...point })),
      arcs: draftContour.arcs?.map(arc => ({ ...arc, center: { ...arc.center } })),
      closed: true,
      constraints: [],
    }))
  })

  useAppStore.getState().execute(new CompositeCommand(
    mode === 'replace-outer' ? `应用板型：${draft.name}` : options.replaceContourIds?.length ? `更新镂空：${draft.name}` : `插入轮廓孔：${draft.name}`,
    commands,
  ))
  useAppStore.getState().setUI({
    activeTool: 'select',
    // 多个分离外轮廓代表一组招牌板件；保持全局选择，避免“自动分割”只处理第一个字形。
    selectedContourId: createdIds.length === 1 ? createdIds[0] : null,
    selectedConstraintId: null,
    viewMode: options.viewMode ?? '2d',
  })
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('snapboard:fit-active-sketch'))
  }
  return createdIds
}
