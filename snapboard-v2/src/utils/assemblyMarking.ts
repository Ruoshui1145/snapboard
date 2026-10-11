import type { BoardTextureConfig, Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import polygonClipping, { type Polygon, type Ring } from 'polygon-clipping'

/**
 * 板件背面永久标识。
 *
 * 该模块只负责确定“刻什么、刻在哪里”，不依赖 Three.js 或 3MF。预览和制造
 * 共用这里输出的多边形，避免屏幕上的接缝编号与最终打印件不一致。
 */

export interface AssemblyMarkingConfig {
  enabled: boolean
  brand: string
  /** 留空时根据项目名稳定生成四位套件码。 */
  kitCode: string
  includeBrand: boolean
  includePanelIds: boolean
  includeSeamIds: boolean
  includeOrientation: boolean
  includeKitCode: boolean
  /** Explicit choices survive switching between single and double-sided mapping. */
  backEngravingEnabled?: boolean
  reserveBackMarking?: boolean
  sideDepth?: number
  sideTextHeight?: number
  /** Model annotation applied by the side-number action, independent of production order binding. */
  orderSideNumber?: string
  orderSideSourceId?: string
  /** Subtractive brand on a safe outside edge. */
  sideLogoEnabled: boolean
  numberPlacement?: 'auto' | 'back' | 'side'
  /** 背面盲刻深度，单位 mm。 */
  depth: number
  /** 连续圆头工程字模的整体字高，单位 mm。 */
  textHeight: number
  /** 标识与孔洞、缺口、板边的最小净距，单位 mm。 */
  clearance: number
}

export interface AssemblyMarkPlacement {
  id: string
  kind: 'identity' | 'seam'
  panelIndex: number
  panelId: string
  text: string
  partnerPanelId?: string
  seamId?: string
  x: number
  y: number
  rotation: number
  /** Text orientation is independent of the seam-aligned placement box. */
  textRotation?: number
  textHeightMm?: number
  width: number
  height: number
  /** 已按背视图镜像的浅凹刻轮廓，坐标使用分割结果的全局 mm。 */
  polygons: Point2D[][]
}

export interface AssemblySeamPlan {
  id: string
  firstPanelIndex: number
  secondPanelIndex: number
  firstPanelId: string
  secondPanelId: string
  axis: 'horizontal' | 'vertical'
  coordinate: number
  start: number
  end: number
}

export interface AssemblyPanelMarkPlan {
  panelIndex: number
  sourcePanelId: string
  panelId: string
  marks: AssemblyMarkPlacement[]
  engravingPolygons: Point2D[][]
  numberMark?: { surface:'back'|'side'|'pocket'; text:string; polygons:Point2D[][]; z:number; height:number }
}

export interface AssemblyMarkPlan {
  kitCode: string
  panels: AssemblyPanelMarkPlan[]
  seams: AssemblySeamPlan[]
  warnings: string[]
}

export const DEFAULT_ASSEMBLY_MARKING: AssemblyMarkingConfig = {
  enabled: true,
  brand: 'SNAPBOARD',
  kitCode: '',
  includeBrand: false,
  includePanelIds: true,
  includeSeamIds: false,
  includeOrientation: true,
  includeKitCode: false,
  numberPlacement: 'auto',
  sideLogoEnabled: false,
  depth: 0.3,
  textHeight: 4.8,
  clearance: 3,
}

export function createDefaultAssemblyMarking(): AssemblyMarkingConfig {
  return { ...DEFAULT_ASSEMBLY_MARKING }
}

function cleanAscii(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9._-]+/g, '').slice(0, maxLength)
  return cleaned || fallback
}

export function normalizeAssemblyMarking(value: unknown): AssemblyMarkingConfig {
  const next = createDefaultAssemblyMarking()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return next
  const record = value as Record<string, unknown>
  if (typeof record.enabled === 'boolean') next.enabled = record.enabled
  next.brand = cleanAscii(record.brand, next.brand, 14)
  next.kitCode = typeof record.kitCode === 'string'
    ? record.kitCode.toUpperCase().replace(/[^A-Z0-9-]+/g, '').slice(0, 10)
    : next.kitCode
  if (typeof record.includeBrand === 'boolean') next.includeBrand = record.includeBrand
  if (typeof record.includePanelIds === 'boolean') next.includePanelIds = record.includePanelIds
  if (typeof record.includeSeamIds === 'boolean') next.includeSeamIds = record.includeSeamIds
  if (typeof record.includeOrientation === 'boolean') next.includeOrientation = record.includeOrientation
  if (typeof record.includeKitCode === 'boolean') next.includeKitCode = record.includeKitCode
  if (typeof record.sideLogoEnabled === 'boolean') next.sideLogoEnabled = record.sideLogoEnabled
  if (['auto','back','side'].includes(record.numberPlacement as string)) next.numberPlacement=record.numberPlacement as AssemblyMarkingConfig['numberPlacement']
  if (typeof record.backEngravingEnabled === 'boolean') next.backEngravingEnabled = record.backEngravingEnabled
  if (typeof record.reserveBackMarking === 'boolean') next.reserveBackMarking = record.reserveBackMarking
  if (typeof record.sideDepth === 'number' && Number.isFinite(record.sideDepth)) next.sideDepth = Math.max(0.12, Math.min(0.4, record.sideDepth))
  if (typeof record.sideTextHeight === 'number' && Number.isFinite(record.sideTextHeight)) next.sideTextHeight = Math.max(2.1, Math.min(8, record.sideTextHeight))
  if (typeof record.orderSideNumber === 'string' && record.orderSideNumber) {
    if (!/^SB-\d{8}-\d{4}$/.test(record.orderSideNumber)) throw new Error('侧刻必须使用完整订单号')
    next.orderSideNumber = record.orderSideNumber
  }
  if (typeof record.orderSideSourceId === 'string' && /^[a-f0-9-]{36}$/.test(record.orderSideSourceId)) next.orderSideSourceId = record.orderSideSourceId
  if (typeof record.depth === 'number' && Number.isFinite(record.depth)) next.depth = Math.max(0.16, Math.min(0.4, record.depth))
  if (typeof record.textHeight === 'number' && Number.isFinite(record.textHeight)) next.textHeight = Math.max(4.2, Math.min(8, record.textHeight))
  if (typeof record.clearance === 'number' && Number.isFinite(record.clearance)) next.clearance = Math.max(2, Math.min(8, record.clearance))
  return next
}

export function isBackEngravingEnabled(marking: AssemblyMarkingConfig, texture?: BoardTextureConfig): boolean {
  return marking.enabled && (marking.backEngravingEnabled ?? !texture?.backEnabled)
}

/** Through windows have no rear floor; numbering must never create one. */
export function isThroughLatticePanel(panel: SplitPanel): boolean {
  return Boolean(panel.latticeCutouts?.length && !panel.latticeFace?.layers.some(layer =>
    (layer.role === 'backing' || layer.role === 'face') && layer.zMax > layer.zMin && layer.polygons.length))
}

/** Both engraving controls share metadata, while their physical geometry stays independent. */
export function buildSurfaceMarkingPlan(panels: SplitPanel[], cfg: SplitConfig, marking: AssemblyMarkingConfig,
  texture?: BoardTextureConfig, projectName = 'SNAPBOARD'): AssemblyMarkPlan {
  const enabled = isBackEngravingEnabled(marking, texture) && (!texture?.backEnabled || marking.reserveBackMarking === true)
  const plan = buildAssemblyMarkPlan(panels, cfg, { ...marking, enabled, includeBrand: false, includeKitCode: false }, projectName)
  if(enabled && marking.includePanelIds)for(const item of plan.panels){
    const panel=panels[item.panelIndex], idMark=item.marks.find(m=>m.id===`identity-${item.panelId}`)
    if(idMark){item.numberMark={surface:'back',text:item.panelId,polygons:idMark.polygons,z:0,height:marking.depth};continue}
    if(!item.numberMark && panel.latticeFace){
      const carrier=panel.latticeFace.layers.find(l=>l.role==='backing')
      const size=(r:Point2D[])=>r.reduce((s,p,i)=>{const q=r[(i+1)%r.length];return s+p.x*q.y-q.x*p.y},0)
      if(carrier)for(const window of [...panel.latticeCutouts??[]].filter(r=>r.length>=3).sort((a,b)=>Math.abs(size(b))-Math.abs(size(a)))){
        const h=3.5,w=measuredTextWidth(item.panelId,h),candidate={...panel,contour:window,latticeCutouts:undefined}
        const center=findIdentityCenter(candidate,w,h+(marking.includeOrientation?3:0),0,cfg,.65,[])
        if(!center)continue
        const polys=pixelTextPolygons(item.panelId,center.x,center.y-(marking.includeOrientation?1.5:0),h,0,true)
        if(marking.includeOrientation)polys.push(arrowPolygon({x:center.x,y:center.y+2},{x:0,y:1},2.4))
        if(!polys.flat().every(p=>carrier.polygons.some(([outer,...holes])=>pointInPolygon(p,outer)&&!holes.some(r=>pointInPolygon(p,r)))))continue
        const depth=Math.min(marking.depth,carrier.zMax-carrier.zMin-.12)
        if(depth<.16)continue
        item.numberMark={surface:'pocket',text:item.panelId,polygons:polys,z:carrier.zMin,height:depth};break
      }
    }
    if(isThroughLatticePanel(panel)){plan.warnings=plan.warnings.filter(w=>!w.startsWith(`${item.panelId} `));continue}
    if(item.numberMark)plan.warnings=plan.warnings.filter(w=>!w.startsWith(`${item.panelId} 没有足够的连续安全区域`))
    else plan.warnings.push(`${item.panelId} 尚未找到可打印的编号表面，请检查背面或真实承托区域。`)
  }
  return { ...plan, seams: detectAssemblySeams(panels) }
}

/** 5×7 拓扑骨架，经圆头连接与布尔合并生成连续字形，不输出分行点阵。 */
const GLYPHS: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '/': ['00001','00001','00010','00100','01000','10000','10000'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '.': ['00000','00000','00000','00000','00000','00110','00110'],
  '_': ['00000','00000','00000','00000','00000','00000','11111'],
}

const EPS = 0.05

function panelContour(panel: SplitPanel): Point2D[] {
  return panel.contour && panel.contour.length >= 3 ? panel.contour : [
    { x: panel.x, y: panel.y },
    { x: panel.x + panel.w, y: panel.y },
    { x: panel.x + panel.w, y: panel.y + panel.h },
    { x: panel.x, y: panel.y + panel.h },
  ]
}

function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function distanceToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  if (length2 <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

function minBoundaryDistance(point: Point2D, contour: Point2D[]): number {
  let distance = Infinity
  for (let index = 0; index < contour.length; index++) {
    distance = Math.min(distance, distanceToSegment(point, contour[index], contour[(index + 1) % contour.length]))
  }
  return distance
}

interface Box { minX: number; minY: number; maxX: number; maxY: number }
const cutoutBoundsCache = new WeakMap<SplitPanel, Array<{ ring: Point2D[]; box: Box }>>()
const cutoutBounds = (panel: SplitPanel) => {
  const cached = cutoutBoundsCache.get(panel)
  if (cached) return cached
  const bounds = [...(panel.cutouts ?? []), ...(panel.latticeCutouts ?? [])].map(ring => ({ ring, box: {
    minX: Math.min(...ring.map(point => point.x)), maxX: Math.max(...ring.map(point => point.x)),
    minY: Math.min(...ring.map(point => point.y)), maxY: Math.max(...ring.map(point => point.y)),
  } }))
  cutoutBoundsCache.set(panel, bounds)
  return bounds
}

function materialPoint(panel: SplitPanel, point: Point2D, clearance: number): boolean {
  const contour = panelContour(panel)
  if (!pointInPolygon(point, contour) || minBoundaryDistance(point, contour) < clearance - EPS) return false
  for (const { ring, box } of cutoutBounds(panel)) {
    if (point.x < box.minX - clearance || point.x > box.maxX + clearance ||
        point.y < box.minY - clearance || point.y > box.maxY + clearance) continue
    if (pointInPolygon(point, ring) || minBoundaryDistance(point, ring) < clearance - EPS) return false
  }
  return true
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS
}

function rotatedPoint(x: number, y: number, cx: number, cy: number, rotation: number): Point2D {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return { x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }
}

function placementBox(x: number, y: number, width: number, height: number, rotation: number): Box {
  const corners = [
    rotatedPoint(-width / 2, -height / 2, x, y, rotation),
    rotatedPoint(width / 2, -height / 2, x, y, rotation),
    rotatedPoint(width / 2, height / 2, x, y, rotation),
    rotatedPoint(-width / 2, height / 2, x, y, rotation),
  ]
  return {
    minX: Math.min(...corners.map(point => point.x)),
    minY: Math.min(...corners.map(point => point.y)),
    maxX: Math.max(...corners.map(point => point.x)),
    maxY: Math.max(...corners.map(point => point.y)),
  }
}

export function placementFits(
  panel: SplitPanel,
  cfg: SplitConfig,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  clearance: number,
  reserved: Box[],
): boolean {
  const box = placementBox(x, y, width, height, rotation)
  if (reserved.some(item => boxesOverlap(box, item))) return false

  // 用规则采样覆盖文字矩形；比只检查四角更能识别凹形板跨越缺口的情况。
  for (let iy = 0; iy <= 4; iy++) {
    for (let ix = 0; ix <= 6; ix++) {
      const point = rotatedPoint(width * (ix / 6 - 0.5), height * (iy / 4 - 0.5), x, y, rotation)
      if (!materialPoint(panel, point, clearance)) return false
    }
  }

  const expanded = (cx: number, cy: number, halfW: number, halfH: number): Box => ({
    minX: cx - halfW - clearance,
    maxX: cx + halfW + clearance,
    minY: cy - halfH - clearance,
    maxY: cy + halfH + clearance,
  })
  if (panel.slots.some(hole => boxesOverlap(box, expanded(hole.x, hole.y, cfg.slotWidth / 2, cfg.slotLength / 2)))) return false
  const jointRadius = cfg.jointDiameter / 2
  if ([...panel.round_holes, ...panel.edge_holes].some(hole => boxesOverlap(box, expanded(hole.x, hole.y, jointRadius, jointRadius)))) return false
  return true
}

function measuredTextWidth(text: string, height: number): number {
  const cell = height / 7
  const chars = [...text]
  return Math.max(cell, chars.reduce((sum, char) => sum + (char === ' ' ? 3 : 5) * cell, 0) + Math.max(0, chars.length - 1) * cell)
}

const roundedGlyphCache = new Map<string, Polygon[]>()

/** Continuous rounded strokes, with clockwise inner rings retained for letter counters. */
export function pixelTextPolygons(
  text: string,
  centerX: number,
  centerY: number,
  height: number,
  rotation = 0,
  mirrorX = true,
): Point2D[][] {
  const normalized = text.toUpperCase().replace(/[^A-Z0-9._ /-]/g, '')
  const cell = height / 7
  const totalWidth = measuredTextWidth(normalized, height)
  let cursor = -totalWidth / 2
  const polygons: Point2D[][] = []
  for (const char of normalized) {
    if (char === ' ') {
      cursor += 4 * cell
      continue
    }
    const rows = GLYPHS[char] ?? GLYPHS['-']
    const primitives: Polygon[] = []
    const dot = (x: number, y: number) => {
      const radius = cell / 2
      const ring: Ring = Array.from({ length: 12 }, (_, i) => [x + Math.cos(i * Math.PI / 6) * radius, y + Math.sin(i * Math.PI / 6) * radius])
      ring.push(ring[0]); primitives.push([ring])
    }
    const join = (ax: number, ay: number, bx: number, by: number) => {
      const length = Math.hypot(bx - ax, by - ay)
      const dx = -(by - ay) / length * cell / 2, dy = (bx - ax) / length * cell / 2
      primitives.push([[[ax+dx,ay+dy],[bx+dx,by+dy],[bx-dx,by-dy],[ax-dx,ay-dy],[ax+dx,ay+dy]]])
    }
    for (let row = 0; row < rows.length; row++) {
      const bits = rows[row]
      for (let column = 0; column < bits.length; column++) {
        if (bits[column] !== '1') continue
        const x = (column + .5) * cell, y = height / 2 - (row + .5) * cell
        dot(x,y)
        for (const [dc,dr] of [[1,0],[0,1],[1,1],[-1,1]]) {
          if (rows[row+dr]?.[column+dc] !== '1') continue
          // Diagonal joins only bridge stair-step corners; do not thicken right-angle junctions.
          if (dc && dr && (rows[row]?.[column+dc] === '1' || rows[row+dr]?.[column] === '1')) continue
          join(x,y,x+dc*cell,y-dr*cell)
        }
      }
    }
    if (primitives.length) {
      // Boolean on a fixed integer lattice avoids near-tangent floating-point endpoints.
      const lattice: Polygon[] = primitives.map(polygon => polygon.map(ring => ring.map(([x,y]) => [Math.round(x * 100_000), Math.round(y * 100_000)])))
      const cacheKey = `${char}:${height}`
      let glyphs = roundedGlyphCache.get(cacheKey)
      if (!glyphs) {
        glyphs = polygonClipping.union(lattice[0], ...lattice.slice(1))
        roundedGlyphCache.set(cacheKey, glyphs)
        while (roundedGlyphCache.size > 256) roundedGlyphCache.delete(roundedGlyphCache.keys().next().value!)
      }
      for (const glyph of glyphs) {
        glyph.forEach((ring, index) => {
          let points = ring.slice(0,-1).map(([x,y]) => rotatedPoint((mirrorX ? -1 : 1) * (x / 100_000 + cursor),y / 100_000,centerX,centerY,rotation))
          const area = points.reduce((s,a,i) => { const b=points[(i+1)%points.length]; return s+a.x*b.y-b.x*a.y },0)
          if ((area > 0) !== (index === 0)) points = points.reverse()
          polygons.push(points)
        })
      }
    }
    cursor += 6 * cell
  }
  return polygons
}

function arrowPolygon(center: Point2D, direction: Point2D, size: number): Point2D[] {
  const length = Math.max(2.4, size)
  const halfWidth = length * 0.42
  const perpendicular = { x: -direction.y, y: direction.x }
  const points = [
    { x: center.x + direction.x * length / 2, y: center.y + direction.y * length / 2 },
    { x: center.x - direction.x * length / 2 + perpendicular.x * halfWidth, y: center.y - direction.y * length / 2 + perpendicular.y * halfWidth },
    { x: center.x - direction.x * length / 2 - perpendicular.x * halfWidth, y: center.y - direction.y * length / 2 - perpendicular.y * halfWidth },
  ]
  const area = points.reduce((s,a,i) => { const b=points[(i+1)%points.length]; return s+a.x*b.y-b.x*a.y },0)
  return area > 0 ? points : points.reverse()
}

interface EdgeSegment {
  axis: 'horizontal' | 'vertical'
  coordinate: number
  start: number
  end: number
}

function panelEdges(panel: SplitPanel): EdgeSegment[] {
  const contour = panelContour(panel)
  return contour.flatMap((point, index): EdgeSegment[] => {
    const next = contour[(index + 1) % contour.length]
    if (Math.abs(point.y - next.y) <= EPS) return [{
      axis: 'horizontal', coordinate: (point.y + next.y) / 2,
      start: Math.min(point.x, next.x), end: Math.max(point.x, next.x),
    }]
    if (Math.abs(point.x - next.x) <= EPS) return [{
      axis: 'vertical', coordinate: (point.x + next.x) / 2,
      start: Math.min(point.y, next.y), end: Math.max(point.y, next.y),
    }]
    return []
  }).filter(edge => edge.end - edge.start > EPS)
}

/** 板件编号（P01、P02…）：背面刻字、切片盘名与分板导出的文件名共用同一个来源。 */
export function stablePanelIds(panels: SplitPanel[]): string[] {
  const sorted = panels.map((panel, index) => ({ panel, index })).sort((a, b) => {
    const ay = a.panel.y + a.panel.h / 2
    const by = b.panel.y + b.panel.h / 2
    if (Math.abs(ay - by) > 0.5) return by - ay
    const ax = a.panel.x + a.panel.w / 2
    const bx = b.panel.x + b.panel.w / 2
    return Math.abs(ax - bx) > 0.5 ? ax - bx : a.index - b.index
  })
  const width = Math.max(2, String(panels.length).length)
  const ids = Array.from({ length: panels.length }, () => '')
  sorted.forEach((item, order) => { ids[item.index] = `P${String(order + 1).padStart(width, '0')}` })
  return ids
}

function detectSeams(panels: SplitPanel[], panelIds: string[]): AssemblySeamPlan[] {
  const raw: Omit<AssemblySeamPlan, 'id'>[] = []
  for (let first = 0; first < panels.length; first++) {
    const firstEdges = panelEdges(panels[first])
    for (let second = first + 1; second < panels.length; second++) {
      const secondEdges = panelEdges(panels[second])
      const segments: EdgeSegment[] = []
      for (const a of firstEdges) for (const b of secondEdges) {
        if (a.axis !== b.axis || Math.abs(a.coordinate - b.coordinate) > EPS) continue
        const start = Math.max(a.start, b.start)
        const end = Math.min(a.end, b.end)
        if (end - start >= 8 - EPS) segments.push({ axis: a.axis, coordinate: (a.coordinate + b.coordinate) / 2, start, end })
      }
      segments.sort((a, b) => a.axis.localeCompare(b.axis) || a.coordinate - b.coordinate || a.start - b.start)
      const merged: EdgeSegment[] = []
      for (const segment of segments) {
        const previous = merged[merged.length - 1]
        if (previous && previous.axis === segment.axis && Math.abs(previous.coordinate - segment.coordinate) <= EPS && segment.start <= previous.end + EPS) {
          previous.end = Math.max(previous.end, segment.end)
        } else merged.push({ ...segment })
      }
      for (const segment of merged) raw.push({
        firstPanelIndex: first,
        secondPanelIndex: second,
        firstPanelId: panelIds[first],
        secondPanelId: panelIds[second],
        ...segment,
      })
    }
  }
  raw.sort((a, b) => {
    const ay = a.axis === 'horizontal' ? a.coordinate : a.end
    const by = b.axis === 'horizontal' ? b.coordinate : b.end
    if (Math.abs(ay - by) > EPS) return by - ay
    const ax = a.axis === 'horizontal' ? a.start : a.coordinate
    const bx = b.axis === 'horizontal' ? b.start : b.coordinate
    return ax - bx || a.firstPanelId.localeCompare(b.firstPanelId)
  })
  const width = Math.max(2, String(raw.length).length)
  return raw.map((seam, index) => ({ ...seam, id: `J${String(index + 1).padStart(width, '0')}` }))
}

/**
 * 供3D背面装配辅助使用的接缝检测。它不受“是否把编号刻进成品”开关影响；
 * 用户即使关闭永久文字，背视图仍必须能看见板件边界并安装紧固件。
 */
export function detectAssemblySeams(panels: SplitPanel[]): AssemblySeamPlan[] {
  return detectSeams(panels, stablePanelIds(panels))
}

export function projectKitCode(name: string): string {
  let hash = 2166136261
  for (const char of name || 'SNAPBOARD') {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0).toString(36).toUpperCase().padStart(4, '0').slice(-4)
}

function inwardDirection(panel: SplitPanel, seam: AssemblySeamPlan): Point2D {
  const middle = seam.axis === 'horizontal'
    ? { x: (seam.start + seam.end) / 2, y: seam.coordinate }
    : { x: seam.coordinate, y: (seam.start + seam.end) / 2 }
  const candidates = seam.axis === 'horizontal' ? [{ x: 0, y: 1 }, { x: 0, y: -1 }] : [{ x: 1, y: 0 }, { x: -1, y: 0 }]
  return candidates.find(direction => pointInPolygon({ x: middle.x + direction.x, y: middle.y + direction.y }, panelContour(panel))) ?? candidates[0]
}

function seamCandidateCenters(seam: AssemblySeamPlan): number[] {
  const middle = (seam.start + seam.end) / 2
  const span = seam.end - seam.start
  const values = [middle, middle - span * 0.12, middle + span * 0.12, middle - span * 0.24, middle + span * 0.24, middle - span * 0.38, middle + span * 0.38]
  // 大箭头需要主动寻找孔列之间的空档，不能只试固定的几个比例点。
  const samples = Math.min(48, Math.max(0, Math.floor(span / 5)))
  for (let index = 1; index <= samples; index++) values.push(seam.start + span * index / (samples + 1))
  return [...new Map(values
    .filter(value => value >= seam.start + 3 && value <= seam.end - 3)
    .map(value => [Math.round(value * 1000), value])).values()]
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))
}

function findIdentityCenter(panel: SplitPanel, width: number, height: number, rotation: number, cfg: SplitConfig, clearance: number, reserved: Box[]): Point2D | null {
  const localBox = placementBox(0, 0, width, height, rotation)
  const boundWidth = localBox.maxX - localBox.minX
  const boundHeight = localBox.maxY - localBox.minY
  const search = (step: number): Point2D | null => {
    const candidates: Point2D[] = [{ x: panel.x + panel.w / 2, y: panel.y + panel.h / 2 }]
    for (let y = panel.y + clearance + boundHeight / 2; y <= panel.y + panel.h - clearance - boundHeight / 2 + EPS; y += step) {
      for (let x = panel.x + clearance + boundWidth / 2; x <= panel.x + panel.w - clearance - boundWidth / 2 + EPS; x += step) candidates.push({ x, y })
    }
    const center = candidates[0]
    candidates.sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y))
    return candidates.find(candidate => placementFits(panel, cfg, candidate.x, candidate.y, width, height, rotation, clearance, reserved)) ?? null
  }
  // 可用缝隙可能比粗网格步距还窄，粗网格会整体跨过去（p9 实测只差 0.1mm，实际有 629 个合法位置）。
  // 因此粗网格失败后再按 1/4 步距补一遍，只有真的没有连续安全区域时才报告放不下。
  const step = Math.max(6, Math.min(12, Math.min(panel.w, panel.h) / 5))
  return search(step) ?? search(step / 4)
}

/** The order trace uses the same rounded font and hole/edge clearance as assembly marks. */
export function placeAssemblyText(panel: SplitPanel, cfg: SplitConfig, lines: string[], occupied: AssemblyMarkPlacement[],
  id: string, clearance = 3, height = 4.8): AssemblyMarkPlacement | null {
  const width = Math.max(...lines.map(line => measuredTextWidth(line, height)))
  const blockHeight = lines.length * height + Math.max(0, lines.length - 1)
  const reserved = occupied.map(mark => {
    const box = placementBox(mark.x, mark.y, mark.width, mark.height, mark.rotation)
    return { minX: box.minX - .65, maxX: box.maxX + .65, minY: box.minY - .65, maxY: box.maxY + .65 }
  })
  for (const rotation of [0, Math.PI / 2]) {
    const center = findIdentityCenter(panel, width, blockHeight, rotation, cfg, clearance, reserved)
    if (!center) continue
    const polygons = lines.flatMap((line, index) => {
      const lineCenter = rotatedPoint(0, blockHeight / 2 - height / 2 - index * (height + 1), center.x, center.y, rotation)
      return pixelTextPolygons(line, lineCenter.x, lineCenter.y, height, rotation, true)
    })
    return { id, kind: 'identity', panelIndex: 0, panelId: panel.id, text: lines.join(' / '),
      x: center.x, y: center.y, rotation, width, height: blockHeight, textHeightMm: height, polygons }
  }
  return null
}

export function buildAssemblyMarkPlan(
  panels: SplitPanel[],
  cfg: SplitConfig,
  value: AssemblyMarkingConfig,
  projectName = 'SNAPBOARD',
): AssemblyMarkPlan {
  const marking = normalizeAssemblyMarking(value)
  const kitCode = marking.kitCode || projectKitCode(projectName)
  const panelIds = stablePanelIds(panels)
  const seams = marking.enabled && marking.includeSeamIds ? detectSeams(panels, panelIds) : []
  const panelPlans: AssemblyPanelMarkPlan[] = panels.map((panel, panelIndex) => ({
    panelIndex,
    sourcePanelId: panel.id,
    panelId: panelIds[panelIndex],
    marks: [],
    engravingPolygons: [],
  }))
  const warnings: string[] = []
  if (!marking.enabled || !panels.length) return { kitCode, panels: panelPlans, seams, warnings }
  const reserved = panels.map((): Box[] => [])

  for (const seam of seams) {
    const panelIndices = [seam.firstPanelIndex, seam.secondPanelIndex] as const
    if (panelIndices.some(index => isThroughLatticePanel(panels[index]))) continue
    const rotation = seam.axis === 'horizontal' ? 0 : Math.PI / 2
    // 实体板只刻短数字；J01 与完整 P01↔P02 关系保留在 UI/assembly-map。
    const displayCode = String(Math.max(1, Number.parseInt(seam.id.replace(/\D/g, ''), 10) || 1))
    let selected: {
      along: number; height: number; width: number; depth: number
      arrowSize: number; arrowDistance: number; textDistance: number
      arrowAlongOffset: number; textAlongOffset: number
      centers: Point2D[]; inward: Point2D[]
    } | null = null
    // Read all numbers with the long slots upright. Only the arrow and bounding
    // box follow the seam; size that box using the actual upright text footprint.
    const preferredHeight = Math.max(6, marking.textHeight)
    const heights = [...new Set([preferredHeight, Math.max(5.4, preferredHeight * 0.9), 4.8])]
    // Staggered slot rows can cover every near-edge position on both sides of
    // a seam. Keep the edge preference, then search the clear strip behind
    // the first slot column without changing the paired along-seam position.
    for (const edgeInset of [0.55, 5, 10, 15, 20, 25]) {
      for (const height of heights) {
        const textWidth = measuredTextWidth(displayCode, height)
        const textDepth = seam.axis === 'horizontal' ? height : textWidth
        const textAlong = seam.axis === 'horizontal' ? textWidth : height
        const arrowSize = 4
        const arrowAlong = arrowSize * 0.84
        // Side-by-side along the seam keeps the larger upright number out of the
        // first connector-hole row, rather than forcing it farther into the board.
        const depth = Math.max(arrowSize, textDepth)
        const variant = { height, depth, arrowSize, arrowDistance: edgeInset + arrowSize / 2, textDistance: edgeInset + textDepth / 2,
          arrowAlongOffset: -(textAlong + 0.6) / 2, textAlongOffset: (arrowAlong + 0.6) / 2 }
        const width = arrowAlong + 0.6 + textAlong + 1.2
        for (const along of seamCandidateCenters(seam)) {
          const edgePoint = seam.axis === 'horizontal' ? { x: along, y: seam.coordinate } : { x: seam.coordinate, y: along }
          const inward = panelIndices.map(panelIndex => inwardDirection(panels[panelIndex], seam))
          const centers = inward.map(direction => ({
            x: edgePoint.x + direction.x * (edgeInset + depth / 2),
            y: edgePoint.y + direction.y * (edgeInset + depth / 2),
          }))
          const pairFits = panelIndices.every((panelIndex, pairIndex) => placementFits(
            panels[panelIndex], cfg,
            centers[pairIndex].x, centers[pairIndex].y,
            width, depth, rotation,
            0.45,
            reserved[panelIndex],
          ))
          if (pairFits) {
            selected = { along, width, centers, inward, ...variant }
            break
          }
        }
        if (selected) break
      }
      if (selected) break
    }
    if (!selected) {
      warnings.push(`${seam.id} 两侧没有共同的边缘安全位置，已仅保留装配图关系。`)
      continue
    }
    const edgePoint = seam.axis === 'horizontal'
      ? { x: selected.along, y: seam.coordinate }
      : { x: seam.coordinate, y: selected.along }
    panelIndices.forEach((panelIndex, pairIndex) => {
      const panelId = panelIds[panelIndex]
      const partnerPanelId = panelIndex === seam.firstPanelIndex ? seam.secondPanelId : seam.firstPanelId
      const inward = selected!.inward[pairIndex]
      const outward = { x: -inward.x, y: -inward.y }
      // 箭头尖端距接缝约 1mm；数字紧随其后。两侧使用同一 along 坐标，
      // 所以拼板时无需记住长编号，只要把面对面的同号箭头对齐即可。
      const tangent = seam.axis === 'horizontal' ? {x:1,y:0} : {x:0,y:1}
      const arrowCenter = { x: edgePoint.x + inward.x * selected!.arrowDistance + tangent.x * selected!.arrowAlongOffset,
        y: edgePoint.y + inward.y * selected!.arrowDistance + tangent.y * selected!.arrowAlongOffset }
      const textCenter = { x: edgePoint.x + inward.x * selected!.textDistance + tangent.x * selected!.textAlongOffset,
        y: edgePoint.y + inward.y * selected!.textDistance + tangent.y * selected!.textAlongOffset }
      const polygons = [
        ...pixelTextPolygons(displayCode, textCenter.x, textCenter.y, selected!.height, 0, true),
        arrowPolygon(arrowCenter, outward, selected!.arrowSize),
      ]
      const mark: AssemblyMarkPlacement = {
        id: `${seam.id}-${panelId}`,
        kind: 'seam', panelIndex, panelId, text: displayCode,
        partnerPanelId, seamId: seam.id,
        x: selected!.centers[pairIndex].x, y: selected!.centers[pairIndex].y,
        rotation, textRotation: 0, textHeightMm: selected!.height, width: selected!.width, height: selected!.depth, polygons,
      }
      panelPlans[panelIndex].marks.push(mark)
      panelPlans[panelIndex].engravingPolygons.push(...polygons)
      reserved[panelIndex].push(placementBox(mark.x, mark.y, mark.width, mark.height, rotation))
    })
  }

  for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
    const panel = panels[panelIndex]
    if (isThroughLatticePanel(panel)) continue
    const panelId = panelIds[panelIndex]
    const placeBlock = (id: string, lines: string[], height: number, rotations: number[], addUpArrow = false): boolean => {
      if (!lines.length) return true
      const widths = lines.map(line => measuredTextWidth(line, height))
      const blockWidth = Math.max(...widths)
      const blockHeight = lines.length * height + Math.max(0, lines.length - 1)
      for (const rotation of rotations) {
        const center = findIdentityCenter(panel, blockWidth, blockHeight + (addUpArrow ? 2 : 0), rotation, cfg, marking.clearance, reserved[panelIndex])
        if (!center) continue
        const polygons: Point2D[][] = []
        const startY = blockHeight / 2 - height / 2
        lines.forEach((line, lineIndex) => {
          const localY = startY - lineIndex * (height + 1)
          const lineCenter = rotatedPoint(0, localY, center.x, center.y, rotation)
          polygons.push(...pixelTextPolygons(line, lineCenter.x, lineCenter.y, height, rotation, true))
        })
        if (addUpArrow) {
          // 朝向箭头始终指向装配坐标 +Y，不随文字为了避孔而旋转。
          polygons.push(arrowPolygon({ x: center.x, y: center.y + blockHeight / 2 + 1.1 }, { x: 0, y: 1 }, Math.min(3.2, height * 0.8)))
        }
        const mark: AssemblyMarkPlacement = {
          id, kind: 'identity', panelIndex, panelId, text: lines.join(' / '),
          x: center.x, y: center.y, rotation, width: blockWidth,
          height: blockHeight + (addUpArrow ? 2 : 0), polygons,
        }
        panelPlans[panelIndex].marks.push(mark)
        panelPlans[panelIndex].engravingPolygons.push(...polygons)
        reserved[panelIndex].push(placementBox(center.x, center.y, blockWidth, blockHeight + (addUpArrow ? 2 : 0), rotation))
        return true
      }
      return false
    }

    const idLines = [marking.includePanelIds ? panelId : '', marking.includeOrientation ? 'UP' : ''].filter(Boolean)
    if (!placeBlock(`identity-${panelId}`, idLines, Math.max(4.2, marking.textHeight), [0], marking.includeOrientation)) {
      warnings.push(`${panelId} 没有足够的连续安全区域，未生成板号/朝向凹刻。`)
    }
    if (marking.includeBrand) {
      const brandHeight = Math.max(4.2, marking.textHeight)
      if (!placeBlock(`brand-${panelId}`, [marking.brand], brandHeight, [0, Math.PI / 2])
          && !placeBlock(`brand-${panelId}`, ['SB'], brandHeight, [0, Math.PI / 2])) {
        warnings.push(`${panelId} 没有满足净距的品牌位置，未生成 SNAPBOARD 凹刻。`)
      }
    }
    if (marking.includeKitCode && !placeBlock(`kit-${panelId}`, [`K${kitCode}`], Math.max(4.2, marking.textHeight), [0, Math.PI / 2])) {
      warnings.push(`${panelId} 没有满足净距的套件码位置；板号和接缝关系仍可用于装配。`)
    }
  }

  return { kitCode, panels: panelPlans, seams, warnings }
}

export function assemblyMarkPlanSignature(plan: AssemblyPanelMarkPlan | undefined, config: AssemblyMarkingConfig): string {
  if (!config.enabled || !plan || (!plan.engravingPolygons.length&&!plan.numberMark)) return 'none'
  return JSON.stringify({
    panelId: plan.panelId,
    depth: normalizeAssemblyMarking(config).depth,
    numberMark: plan.numberMark,
    polygons: plan.engravingPolygons.map(polygon => polygon.map(point => [Number(point.x.toFixed(3)), Number(point.y.toFixed(3))])),
  })
}

/**
 * 每组字形共用一块浅凹底框。制造时先从背面薄层扣除这些矩形，再把字形作为
 * 同材质的齐平凸字填回；这样只需少量负轮廓，避免数百个微型孔让三角剖分失稳。
 */
export function assemblyMarkCavityPolygons(plan: AssemblyPanelMarkPlan | undefined, padding = 0.55): Point2D[][] {
  if (!plan) return []
  const boxes = plan.marks.flatMap(mark => {
    const points = mark.polygons.flat()
    if (!points.length) return []
    return [{
      minX: Math.min(...points.map(point => point.x)) - padding,
      maxX: Math.max(...points.map(point => point.x)) + padding,
      minY: Math.min(...points.map(point => point.y)) - padding,
      maxY: Math.max(...points.map(point => point.y)) + padding,
    }]
  })

  // 同一行的凹框只有在 X 区间相交或相接时才归并。仅凭相同的 Y 区间
  // 合并会把相隔很远的板号连成一道长槽（长亮 P07 曾跨出约 189 mm）。
  const rows = new Map<string, Array<{ minX: number; maxX: number; minY: number; maxY: number }>>()
  for (const box of boxes) {
    const key = `${box.minY.toFixed(6)}:${box.maxY.toFixed(6)}`
    const row = rows.get(key) ?? []
    row.push(box)
    rows.set(key, row)
  }
  const merged = [...rows.values()].flatMap(row => {
    const result: typeof row = []
    for (const box of row.sort((a, b) => a.minX - b.minX)) {
      const last = result.at(-1)
      if (last && box.minX <= last.maxX + 1e-6) last.maxX = Math.max(last.maxX, box.maxX)
      else result.push({ ...box })
    }
    return result
  })

  return merged.map(box => [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ])
}
