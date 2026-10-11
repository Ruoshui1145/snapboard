import polygonClipping, { type Polygon, type Ring } from 'polygon-clipping'
import type { Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import { createSplitPanelShape } from './boardMesh'

export interface TextureSamplingOptions {
  sizeMm: number
  locations: Array<{ panelIndex: number; x: number; y: number }>
}
export interface LastTextureSampling {
  exportedAt: string
  manufacturingFile: string
  checkImageFile?: string
  sizeMm: number
  locations: Array<{ sampleId: string; panelId: string; geometryKey: string; x: number; y: number }>
}

/** Do not restore saved coordinates onto a panel whose geometry changed. */
export function samplingPanelKey(panel: SplitPanel): string {
  const source = JSON.stringify({
    id: panel.id, x: panel.x, y: panel.y, w: panel.w, h: panel.h,
    contour: panel.contour, cutouts: panel.cutouts, roundIdx: panel.roundIdx,
    slots: panel.slots, round_holes: panel.round_holes, edge_holes: panel.edge_holes,
  })
  let hash = 2166136261
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}

export function normalizeLastTextureSampling(value: unknown): LastTextureSampling | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.exportedAt !== 'string' || typeof record.manufacturingFile !== 'string' ||
    typeof record.sizeMm !== 'number' || !Number.isFinite(record.sizeMm) || record.sizeMm < 10 || record.sizeMm > 40 ||
    !Array.isArray(record.locations) || !record.locations.length || !record.locations.every(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const entry = item as Record<string, unknown>
      return ['sampleId', 'panelId', 'geometryKey'].every(key => typeof entry[key] === 'string')
        && typeof entry.x === 'number' && Number.isFinite(entry.x)
        && typeof entry.y === 'number' && Number.isFinite(entry.y)
    })) return null
  return {
    exportedAt: record.exportedAt,
    manufacturingFile: record.manufacturingFile,
    ...(typeof record.checkImageFile === 'string' ? { checkImageFile: record.checkImageFile } : {}),
    sizeMm: record.sizeMm,
    locations: record.locations.map(item => ({ ...(item as LastTextureSampling['locations'][number]) })),
  }
}
export interface TextureSample {
  panel: SplitPanel
  sourcePanelIndex: number
  sourcePanelId: string
  center: Point2D
  requestedSizeMm: number
  areaMm2: number
  /** Local material-only relief at a hole/crop tangency; source XY is unchanged. */
  boundaryReliefMm?: number
  boundaryReliefAreaMm2?: number
}

const area = (ring: Ring) => Math.abs(ring.reduce((sum, a, i) => { const b=ring[(i+1)%ring.length]; return sum+a[0]*b[1]-b[0]*a[1] },0))/2
const closed = (points: Point2D[]): Ring => { const ring: Ring=points.map(p=>[p.x,p.y]);ring.push(ring[0]);return ring }

/** A hole kissing the crop boundary at one point is not a manifold extrusion.
 * Open only that zero-width neck with a 0.002mm clearance, far below the
 * manufacturing sampling pitch. Never fill a hole or translate the texture crop.
 * The clearance also survives the downstream outline/float32 tolerances. */
function openTangentHoles(polygon: Polygon, sourceHoles: Ring[], cropBoundary: Ring): Polygon[] {
  const [outer, ...holes] = polygon
  const reliefs: Polygon[] = []
  for (const [candidates, boundary] of [[holes, outer], [sourceHoles, cropBoundary]] as const)
  for (const hole of candidates) for (const [x, y] of hole.slice(0, -1)) {
    const touches = boundary.slice(0, -1).some(([ax, ay], i) => {
      const [bx, by] = boundary[i + 1]
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy
      if (!length2) return false
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2))
      return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= 1e-4
    })
    if (touches) {
      const e = 0.002
      reliefs.push([[[x-e,y-e],[x+e,y-e],[x+e,y+e],[x-e,y+e],[x-e,y-e]]])
    }
  }
  return reliefs.length ? polygonClipping.difference([polygon], ...reliefs) : [polygon]
}

/** Exact-scale XY crop. Z, texture mapping and source project remain unchanged. */
export function planTextureSamples(panels: SplitPanel[], cfg: SplitConfig, options: TextureSamplingOptions): TextureSample[] {
  const size=options.sizeMm
  if (!Number.isFinite(size)||size<10||size>40) throw new Error('试样边长必须在 10–40mm 之间')
  if (options.locations.length!==panels.length || new Set(options.locations.map(p=>p.panelIndex)).size!==panels.length
    || options.locations.some(p=>!Number.isInteger(p.panelIndex)||p.panelIndex<0||p.panelIndex>=panels.length)) throw new Error('每块板需要一个且仅一个取样点')
  return panels.map((source,index)=>{
    const point=options.locations.find(p=>p.panelIndex===index)!
    if (!Number.isFinite(point.x)||!Number.isFinite(point.y)) throw new Error(`第 ${index+1} 块板的取样坐标无效`)
    const x=point.x-size/2,y=point.y-size/2
    const shape=createSplitPanelShape(source,cfg).extractPoints(64)
    const material: Polygon=[closed(shape.shape),...shape.holes.map(closed)]
    const window: Polygon=[[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]]
    const clipped=polygonClipping.intersection(material,window)
    const result=clipped.flatMap(polygon=>openTangentHoles(polygon,material.slice(1),window[0]))
    if (result.length!==1) throw new Error(`第 ${index+1} 块板取样处${result.length?'被孔洞分成多片':'没有实体'}，请移动取样框`)
    const [outer,...holes]=result[0]
    const sampleArea=area(outer)-holes.reduce((sum,ring)=>sum+area(ring),0)
    const originalArea=clipped.reduce((sum,[shell,...voids])=>sum+area(shell)-voids.reduce((n,ring)=>n+area(ring),0),0)
    const reliefArea=Math.max(0,originalArea-sampleArea)
    if (sampleArea<size*size*.25) throw new Error(`第 ${index+1} 块板试样有效面积不足 25%，请移到板内`)
    const contour=outer.slice(0,-1).map(([x,y])=>({x,y}))
    const xs=contour.map(p=>p.x),ys=contour.map(p=>p.y)
    const minX=Math.min(...xs),minY=Math.min(...ys)
    return {
      sourcePanelIndex:index,sourcePanelId:source.id,center:{x:point.x,y:point.y},requestedSizeMm:size,areaMm2:sampleArea,
      ...(reliefArea>1e-8?{boundaryReliefMm:0.002,boundaryReliefAreaMm2:reliefArea}:{}),
      panel:{id:`S${String(index+1).padStart(2,'0')}`,x:minX,y:minY,w:Math.max(...xs)-minX,h:Math.max(...ys)-minY,
        contour,cutouts:holes.map(ring=>ring.slice(0,-1).map(([x,y])=>({x,y}))),
        slots:[],round_holes:[],edge_holes:[],roundIdx:[],outerCorners:[false,false,false,false],printRotation:source.printRotation ?? 0},
    }
  })
}
