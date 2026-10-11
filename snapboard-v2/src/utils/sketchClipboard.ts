import type { Contour, Point2D } from '../types/geometry'
import { sanitizeContour } from './projectFile'
export const SKETCH_CLIPBOARD_PREFIX = 'SNAPBOARD_SKETCH_V1\n'
export interface SketchClipboard { pixelToMM: number; contours: Contour[] }

export function serializeSketchClipboard(contours: Contour[], pixelToMM: number): string {
  return SKETCH_CLIPBOARD_PREFIX + JSON.stringify({ pixelToMM, contours })
}
export function parseSketchClipboard(text: string): SketchClipboard | null {
  if (!text.startsWith(SKETCH_CLIPBOARD_PREFIX)) return null
  if (text.length > 10 * 1024 * 1024) throw new Error('复制内容超过 10 MB，请分批粘贴')
  const raw = JSON.parse(text.slice(SKETCH_CLIPBOARD_PREFIX.length))
  if (!Number.isFinite(raw.pixelToMM) || raw.pixelToMM <= 0 || !Array.isArray(raw.contours) || !raw.contours.length || raw.contours.length > 1000) throw new Error('复制的草图数据无效')
  const ids = new Set<string>()
  for (const c of raw.contours) {
    if (!sanitizeContour(c) || ids.has(c.id) || c.constraints.some((constraint: Contour['constraints'][number]) => !constraint || typeof constraint.id !== 'string' || !constraint.labelPos || !Number.isFinite(constraint.labelPos.x) || !Number.isFinite(constraint.labelPos.y) || !Number.isFinite(constraint.value))) throw new Error('复制的轮廓或尺寸数据损坏')
    ids.add(c.id)
  }
  return raw
}
/** Copy the selected group as independent geometry, preserving only relationships inside it. */
export function pastedSketchContours(data: SketchClipboard, targetPixelToMM: number, offsetMm: Point2D): Contour[] {
  if (!Number.isFinite(targetPixelToMM) || targetPixelToMM <= 0) throw new Error('工程毫米比例无效')
  const scale = data.pixelToMM / targetPixelToMM
  const point = (p: Point2D) => ({ x: p.x * scale + offsetMm.x / targetPixelToMM, y: p.y * scale + offsetMm.y / targetPixelToMM })
  const ids = new Map(data.contours.map(c => [c.id, `copy-${crypto.randomUUID()}`]))
  return data.contours.map(original => {
    const c = structuredClone(original)
    c.id = ids.get(original.id)!
    c.name = `${c.name} 副本`
    delete c.originAnchorIdx
    c.points = c.points.map(point)
    if (c.center) c.center = point(c.center)
    if (c.radius !== undefined) c.radius *= scale
    if (c.slotWidth !== undefined) c.slotWidth *= scale
    if (c.slotParams) { c.slotParams.width *= scale; c.slotParams.length *= scale }
    c.arcs = c.arcs?.map(arc => ({ ...arc, id: `arc-${crypto.randomUUID()}`, center: point(arc.center), radius: arc.radius * scale }))
    c.constraints = c.constraints.filter(item => (!item.contourId2 || ids.has(item.contourId2)) && item.vertexIdx1 !== -3 && item.vertexIdx2 !== -3)
      .map(item => ({ ...item, id: `dimension-${crypto.randomUUID()}`, labelPos: point(item.labelPos), ...(item.contourId2 ? { contourId2: ids.get(item.contourId2) } : {}) }))
    return c
  })
}
