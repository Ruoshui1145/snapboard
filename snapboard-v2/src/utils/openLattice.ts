import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping'
import templates from '../data/openLatticeTemplates.json'
import type { LatticeFaceData, Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import { pointInRing, ringsIntersect } from '../features/shapeLibrary/import/geometry'
import { createSplitPanelShape } from './boardMesh'
import { insetTexturePolygon } from './texturePolygon'

export type OpenLatticeStyle = 'organic' | 'hex' | 'tree' | 'diamond' | 'honeycomb' | 'ribs' | 'svg' | 'flower'
export interface OpenLatticeResult {
  holes: Point2D[][]
  removedAreaMm2: number
  ribMm: number
  style: OpenLatticeStyle
  face?: LatticeFaceData
  /** Lower ribs join the main domain only near the retained front. */
  auxiliary?: LatticeFaceData['layers'][number]['polygons']
  /** High islands (hole collars) are joined by the continuous lower grid. */
  highStructure?: LatticeFaceData['layers'][number]['polygons']
  volumeMm3?: number
  baselineVolumeMm3?: number
  massEstimate?: { grams:number; savingPercent:number; calibrated:boolean; baselineGrams:number }
}

const area = (ring: Point2D[]) => Math.abs(ring.reduce((sum, p, i) => {
  const next = ring[(i + 1) % ring.length]
  return sum + p.x * next.y - next.x * p.y
}, 0)) / 2
export const roundLatticeWindowCorners = (ring: Point2D[], radius = 1.2): Point2D[] => {
  const signed = ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)
  const rounded: Point2D[] = []
  for (let i = 0; i < ring.length; i++) {
    const previous = ring[(i - 1 + ring.length) % ring.length], corner = ring[i], next = ring[(i + 1) % ring.length]
    const incoming = { x: corner.x - previous.x, y: corner.y - previous.y }
    const outgoing = { x: next.x - corner.x, y: next.y - corner.y }
    const firstLength = Math.hypot(incoming.x, incoming.y), secondLength = Math.hypot(outgoing.x, outgoing.y)
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x
    const turn = (incoming.x * outgoing.x + incoming.y * outgoing.y) / (firstLength * secondLength || 1)
    if (cross * signed <= 0 || turn > 0.9 || Math.min(firstLength, secondLength) < 1) {
      rounded.push(corner)
      continue
    }
    const length = Math.min(radius, firstLength * 0.22, secondLength * 0.22)
    const start = { x: corner.x - incoming.x / firstLength * length, y: corner.y - incoming.y / firstLength * length }
    const end = { x: corner.x + outgoing.x / secondLength * length, y: corner.y + outgoing.y / secondLength * length }
    for (let step = 0; step <= 4; step++) {
      const t = step / 4, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t
      rounded.push({ x: a * start.x + b * corner.x + c * end.x,
        y: a * start.y + b * corner.y + c * end.y })
    }
  }
  return rounded
}
const distanceToSegment = (p: Point2D, a: Point2D, b: Point2D) => {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
const ringDistance = (p: Point2D, ring: Point2D[]) => Math.min(...ring.map((a, i) =>
  distanceToSegment(p, a, ring[(i + 1) % ring.length])))
const slotDistance = (p: Point2D, center: Point2D, cfg: SplitConfig) => Math.hypot(
  p.x - center.x, Math.max(0, Math.abs(p.y - center.y) - Math.max(0, (cfg.slotLength - cfg.slotWidth) / 2)),
) - cfg.slotWidth / 2
const throughRoundHoles = (panel: SplitPanel) => [
  ...panel.round_holes, ...panel.edge_holes.filter(hole => hole.knocked === true),
]
const result = (holes: Point2D[][], ribMm: number, style: OpenLatticeStyle): OpenLatticeResult => ({
  holes, removedAreaMm2: holes.reduce((sum, ring) => sum + area(ring), 0), ribMm, style,
})

/** Use each source 3MF as its own window template; never copy its slots or circles. */
function fromReference(panel: SplitPanel, cfg: SplitConfig, style: 'organic' | 'hex' | 'diamond'): OpenLatticeResult {
  const source = { organic: templates.voronoi, hex: templates.rounded, diamond: templates.regular }[style]
  if (style !== 'hex' && (panel.w > source.size + 0.5 || panel.h > source.size + 0.5))
    throw new Error(`${source.size}mm 参考模式无法覆盖当前板件；请选择尺寸更大的独立样式`)
  const slots = panel.slots
  const first = slots[0]
  const outer = panel.contour!
  let shift: { x: number; y: number; score: number; aligned: number } | null = null
  for (const [x, y] of source.slots) {
    const dx = first.x - x, dy = first.y - y
    const aligned = slots.filter(slot => source.slots.some(([sx, sy]) =>
      Math.hypot(sx + dx - slot.x, sy + dy - slot.y) < 0.75)).length
    const overlapX = Math.max(0, Math.min(panel.x + panel.w, dx + source.size) - Math.max(panel.x, dx)) / panel.w
    const overlapY = Math.max(0, Math.min(panel.y + panel.h, dy + source.size) - Math.max(panel.y, dy)) / panel.h
    const centerOffset = Math.hypot(dx + source.size / 2 - panel.x - panel.w / 2,
      dy + source.size / 2 - panel.y - panel.h / 2)
    const score = aligned * 100 + overlapX * overlapY * 30 - centerOffset / 10
    if (!shift || score > shift.score) shift = { x: dx, y: dy, score, aligned }
  }
  const requiredAlignment = style === 'hex' ? Math.max(4, Math.min(12, slots.length * 0.25)) : Math.max(4, slots.length * 0.6)
  if (!shift || shift.aligned < requiredAlignment)
    throw new Error('参考 3MF 的长孔相位与当前板件不匹配；请检查孔距或换用其他样式')

  const holes: Point2D[][] = []
  const frameWidth = 3.5
  const frame = union(outer.flatMap((point, index) => {
    const next = outer[(index + 1) % outer.length]
    return Math.hypot(next.x - point.x, next.y - point.y) > 0.001 ? [beam(point, next, frameWidth * 2)] : []
  }))
  const sourceWindows: Array<{ points: number[][]; dx: number; dy: number }> = []
  if (style === 'hex') {
    // The 200mm source repeats every 40mm. Repeat two original cap contours,
    // never substitute geometry from another 3MF or invent new cell shapes.
    const motifs = source.windows.filter(points => {
      const xs = points.map(point => point[0]), ys = points.map(point => point[1])
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2
      return (Math.abs(cx - 100) < 0.2 && Math.abs(cy - 100) < 0.2)
        || (Math.abs(cx - 120) < 0.2 && Math.abs(cy - 120) < 0.2)
    })
    if (motifs.length !== 2) throw new Error('200mm 参考通窗数据不完整')
    for (const points of motifs) {
      const xs = points.map(point => point[0]), ys = points.map(point => point[1])
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2 + shift.x
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2 + shift.y
      const minI = Math.floor((panel.x - cx - 20) / 40), maxI = Math.ceil((panel.x + panel.w - cx + 20) / 40)
      const minJ = Math.floor((panel.y - cy - 20) / 40), maxJ = Math.ceil((panel.y + panel.h - cy + 20) / 40)
      for (let i = minI; i <= maxI; i++) for (let j = minJ; j <= maxJ; j++)
        sourceWindows.push({ points, dx: shift.x + i * 40, dy: shift.y + j * 40 })
    }
  } else for (const points of source.windows) sourceWindows.push({ points, dx: shift.x, dy: shift.y })
  for (const { points, dx, dy } of sourceWindows) {
    const ring = points.map(([x, y]) => ({ x: x + dx, y: y + dy }))
    const clipped = polygonClipping.intersection([toRing(ring)], [toRing(outer)])
    if (!clipped.length) continue
    const windows = polygonClipping.difference(clipped, frame)
    for (const polygon of windows) {
      if (polygon.length !== 1) continue
      const window = polygon[0].slice(0, -1).map(([x, y]) => ({ x, y }))
      if (window.length < 3 || area(window) < 30) continue
      // ponytail: skip a collision instead of inventing replacement ribs around the source geometry.
      if (slots.some(slot => pointInRing(slot, window, true)
        || window.some(point => slotDistance(point, slot, cfg) < 0.75))) continue
      if (throughRoundHoles(panel).some(hole => pointInRing(hole, window, true)
        || ringDistance(hole, window) < cfg.jointDiameter / 2 + 2.5)) continue
      if ((panel.cutouts ?? []).some(cutout => pointInRing(cutout[0], window, true)
        || pointInRing(window[0], cutout, true) || ringsIntersect(window, cutout))) continue
      holes.push(roundLatticeWindowCorners(window))
    }
  }
  if (!holes.length) throw new Error('参考 3MF 在当前板件内没有安全通窗；请换用其他样式')
  return result(holes, 3.5, style) // Reference rib geometry is fixed by the source mesh.
}

const toRing = (points: Point2D[]): Ring => [...points.map(point =>
  [Math.round(point.x * 1000) / 1000, Math.round(point.y * 1000) / 1000] as [number, number]),
  [Math.round(points[0].x * 1000) / 1000, Math.round(points[0].y * 1000) / 1000]]
const beam = (a: Point2D, b: Point2D, width: number): Polygon => {
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const x = (b.y - a.y) / length * width / 2, y = (a.x - b.x) / length * width / 2
  return [toRing([{ x: a.x + x, y: a.y + y }, { x: b.x + x, y: b.y + y },
    { x: b.x - x, y: b.y - y }, { x: a.x - x, y: a.y - y }])]
}
const snap = (geometry: MultiPolygon): MultiPolygon => geometry.map(polygon => polygon.map(ring =>
  ring.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])))
const union = (pieces: Polygon[]): MultiPolygon => {
  let pending: MultiPolygon[] = pieces.map(piece => [piece])
  while (pending.length > 1) {
    const next: MultiPolygon[] = []
    for (let i = 0; i < pending.length; i += 4) {
      const batch = pending.slice(i, i + 4)
      next.push(batch.length === 1 ? batch[0] : snap(polygonClipping.union(batch[0], ...batch.slice(1))))
    }
    pending = next
  }
  return pending[0] ?? []
}

export function generateOpenLattice(panel: SplitPanel, cfg: SplitConfig, ribMm = 3.5,
  style: OpenLatticeStyle = 'organic'): OpenLatticeResult {
  if (!panel.contour?.length || panel.slots.length < 4) throw new Error('请先生成包含功能长孔的平面板件')
  if (panel.contour.length < 3 || panel.contour.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)))
    throw new Error('板件外轮廓无效，请重新生成板件')
  if (!Number.isFinite(ribMm) || ribMm < 2.5 || ribMm > 8) throw new Error('筋宽须在 2.5–8mm 之间')
  if (![cfg.mx, cfg.my, cfg.slotLength, cfg.slotWidth, cfg.jointDiameter].every(value => Number.isFinite(value) && value > 0))
    throw new Error('孔距或孔型参数无效，请先检查板材设计参数')
  if (style === 'tree') throw new Error('旧版树枝纹实验已停用；请选择一种 3MF 制造参考样式')
  if (style === 'svg' || style === 'flower') throw new Error('窗花线稿需要先识别 SVG 轮廓')
  if (style === 'honeycomb') return fineHoneycomb(panel, cfg, undefined)
  if (style === 'ribs') return sparseRibs(panel,cfg)
  const reference = fromReference(panel, cfg, style)
  return panel.latticeOptions?.fillWindows ? fineHoneycomb(panel, cfg, reference) : reference
}

export function openLatticePlanSvg(panel: SplitPanel, plan: OpenLatticeResult, cfg: SplitConfig): string {
  const path = (ring: Point2D[]) => `M ${ring.map(point => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' L ')} Z`
  const outer = panel.contour!
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${panel.x} ${panel.y} ${panel.w} ${panel.h}" width="800" height="800">
<title>SnapBoard 镂空结构 · ${{ organic: 'Voronoi 参考', hex: '200mm 连筋参考', tree: '树枝纹实验', diamond: '规则斜撑参考', honeycomb: '细分蜂窝', ribs:'粗疏筋架', svg: '自定义 SVG 窗花', flower: '海棠窗花' }[plan.style]}</title>
<path d="${[outer, ...plan.holes].map(path).join(' ')}" fill="#346ea0" fill-rule="evenodd"/>
${(plan.auxiliary??[]).map(p=>`<path d="${p.map(path).join(' ')}" fill="#83a8bf" fill-rule="evenodd"/>`).join('')}
${panel.slots.map(slot => `<rect x="${(slot.x - cfg.slotWidth / 2).toFixed(2)}" y="${(slot.y - cfg.slotLength / 2).toFixed(2)}" width="${cfg.slotWidth}" height="${cfg.slotLength}" rx="${cfg.slotWidth / 2}" fill="#fff"/>`).join('\n')}
${throughRoundHoles(panel).map(hole => `<circle cx="${hole.x.toFixed(2)}" cy="${hole.y.toFixed(2)}" r="${cfg.jointDiameter / 2}" fill="#fff"/>`).join('\n')}
</svg>`
}

/** Alternating complete high/low grid lines; no one-sided collar stubs. */
function sparseRibs(panel:SplitPanel,cfg:SplitConfig):OpenLatticeResult {
  const outer:MultiPolygon=[[toRing(panel.contour!)]],main:Polygon[]=[],aux:Polygon[]=[]
  const width=2.22,collar=1.5,pitch=cfg.mx,phase=panel.slots[0].x
  let columns=0
  for(let i=Math.floor((panel.x-phase)/pitch);i<=Math.ceil((panel.x+panel.w-phase)/pitch);i++){
    for(const low of [false,true]){
      const x=phase+i*pitch+(low?pitch/2:0)
      if(x>=panel.x+3&&x<=panel.x+panel.w-3){(low?aux:main).push(beam({x,y:panel.y},{x,y:panel.y+panel.h},low?1.5:width));if(!low)columns++}
    }
  }
  if(!columns)throw new Error('板件太窄，无法放置连续主筋')
  const y0=panel.slots[0].y,rows=new Set<number>()
  for(let row=Math.floor((panel.y-y0)/cfg.my);row<=Math.ceil((panel.y+panel.h-y0)/cfg.my);row++){
    const y=y0+row*cfg.my;rows.add(Math.round(y*1000))
    ;(Math.abs(row)%2?aux:main).push(beam({x:panel.x,y},{x:panel.x+panel.w,y},Math.abs(row)%2?1.5:width))
  }
  const frame=polygonClipping.difference(outer,insetTexturePolygon(outer,3))
  const circle=(p:Point2D,r:number):Polygon=>[toRing(Array.from({length:24},(_,i)=>({x:p.x+Math.cos(i*Math.PI/12)*r,y:p.y+Math.sin(i*Math.PI/12)*r})))]
  for(const p of panel.slots){
    const end=(cfg.slotLength-cfg.slotWidth)/2,r=cfg.slotWidth/2+collar
    main.push(beam({x:p.x,y:p.y-end},{x:p.x,y:p.y+end},r*2),circle({x:p.x,y:p.y-end},r),circle({x:p.x,y:p.y+end},r))
  }
  for(const p of throughRoundHoles(panel))main.push(circle(p,cfg.jointDiameter/2+collar))
  // Edited/off-grid holes get a complete low cross line too, never a half stub.
  for(const p of [...panel.slots,...throughRoundHoles(panel)])if(!rows.has(Math.round(p.y*1000))){
    rows.add(Math.round(p.y*1000));aux.push(beam({x:panel.x,y:p.y},{x:panel.x+panel.w,y:p.y},1.5))
  }
  const keep=polygonClipping.union(frame,union(main))
  const shape=createSplitPanelShape({...panel,latticeCutouts:undefined,latticeFace:undefined},cfg,12).extractPoints(24)
  const base:MultiPolygon=[[toRing(shape.shape),...shape.holes.map(toRing)]]
  const rounded=(domain:MultiPolygon)=>domain.map(p=>p.map(r=>toRing(roundLatticeWindowCorners(r.slice(0,-1).map(([x,y])=>({x,y})),.6))))
  const high=polygonClipping.difference(base,rounded(polygonClipping.difference(base,keep)))
  const windows=polygonClipping.difference(base,polygonClipping.union(high,polygonClipping.intersection(base,union(aux))))
  if(windows.some(p=>p.length!==1))throw new Error('交叉筋网存在未连接的孔座，请检查孔位')
  const holes=windows.map(p=>roundLatticeWindowCorners(p[0].slice(0,-1).map(([x,y])=>({x,y})),.6)).filter(r=>area(r)>1)
  const lower=polygonClipping.difference(base,...holes.map(h=>[toRing(h)]))
  if(lower.length!==1)throw new Error('交叉筋网未形成连续板件')
  const toPolygons=(mp:MultiPolygon)=>mp.map(p=>p.map(r=>r.slice(0,-1).map(([x,y])=>({x,y}))))
  return {...result(holes,width,'ribs'),highStructure:toPolygons(high),auxiliary:toPolygons(polygonClipping.difference(lower,high))}
}

/** Fine cells are a separate family; optional window fill preserves the chosen main skeleton. */
function fineHoneycomb(panel: SplitPanel, cfg: SplitConfig, main?: OpenLatticeResult): OpenLatticeResult {
  const pitch = panel.latticeOptions?.cellPitchMm ?? 16, width = panel.latticeOptions?.cellRibMm ?? 1.26
  if (!Number.isFinite(pitch) || pitch < 8 || pitch > 32 || !Number.isFinite(width) || width < 1.26 || width > 3 || width >= pitch / 3)
    throw new Error('蜂窝孔距须为 8–32mm，筋宽须为 1.26–3mm 且小于孔距的三分之一')
  const radius = pitch / Math.sqrt(3), inner = radius - width / Math.sqrt(3), dx = radius * 1.5
  const ringCircle = (x:number,y:number,r:number): Point2D[] => Array.from({length:20},(_,i)=>({x:x+Math.cos(i*Math.PI/10)*r,y:y+Math.sin(i*Math.PI/10)*r}))
  const polygons: Polygon[] = []
  for (const slot of panel.slots) {
    const straight = (cfg.slotLength-cfg.slotWidth)/2, r=cfg.slotWidth/2+1.5
    polygons.push(beam({x:slot.x,y:slot.y-straight},{x:slot.x,y:slot.y+straight},r*2),
      [toRing(ringCircle(slot.x,slot.y-straight,r))],[toRing(ringCircle(slot.x,slot.y+straight,r))])
  }
  const verticesNear = (point: Point2D) => {
    const points:Point2D[]=[]
    const c=Math.round(point.x/dx)
    for(let i=c-1;i<=c+1;i++){
      const offset=(Math.abs(i)%2)*pitch/2, row=Math.round((point.y-offset)/pitch)
      for(let j=row-1;j<=row+1;j++)for(let k=0;k<6;k++)points.push({x:i*dx+radius*Math.cos(k*Math.PI/3),y:j*pitch+offset+radius*Math.sin(k*Math.PI/3)})
    }
    return points.sort((a,b)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(b.x-point.x,b.y-point.y))
  }
  for(const slot of panel.slots)for(const sign of [-1,1]){
    const end={x:slot.x,y:slot.y+sign*(cfg.slotLength-cfg.slotWidth)/2}
    polygons.push(beam(end,verticesNear(end)[0],Math.max(1.26,width)))
  }
  for(const hole of throughRoundHoles(panel)){
    polygons.push([toRing(ringCircle(hole.x,hole.y,cfg.jointDiameter/2+1.5))])
    const nearest=verticesNear(hole)[0]
    polygons.push(beam(hole,nearest,Math.max(1.26,width)))
  }
  const keepers=polygons.map(p=>({polygon:p,minX:Math.min(...p[0].map(v=>v[0])),maxX:Math.max(...p[0].map(v=>v[0])),minY:Math.min(...p[0].map(v=>v[1])),maxY:Math.max(...p[0].map(v=>v[1]))}))
  const domain:MultiPolygon = main ? main.holes.map(h=>[toRing(h)]) : insetTexturePolygon([[toRing(panel.contour!)]],3.5)
  const holes:Point2D[][]=[]
  for(let col=Math.floor(panel.x/dx)-1;col<=Math.ceil((panel.x+panel.w)/dx)+1;col++){
    const offset=(Math.abs(col)%2)*pitch/2
    for(let row=Math.floor((panel.y-offset)/pitch)-1;row<=Math.ceil((panel.y+panel.h-offset)/pitch)+1;row++){
      const x=col*dx,y=row*pitch+offset
      const hex=toRing(Array.from({length:6},(_,i)=>({x:x+inner*Math.cos(i*Math.PI/3),y:y+inner*Math.sin(i*Math.PI/3)})))
      const nearby=keepers.filter(k=>k.maxX>=x-inner&&k.minX<=x+inner&&k.maxY>=y-inner&&k.minY<=y+inner)
      let cells=polygonClipping.intersection([hex],domain)
      if(nearby.length&&cells.length)cells=polygonClipping.difference(cells,...nearby.map(k=>[k.polygon]))
      for(const p of cells){
        if(p.length!==1 || !insetTexturePolygon([p],.45).length)continue
        const points=p[0].slice(0,-1).map(([x,y])=>({x,y}))
        if(area(points)>1)holes.push(roundLatticeWindowCorners(points,.7))
      }
    }
  }
  if(!holes.length || holes.length>4000)throw new Error('蜂窝窗口数量超出范围，请增大孔距或调整板件')
  const shape=createSplitPanelShape({...panel,latticeCutouts:undefined,latticeFace:undefined},cfg,8).extractPoints(16)
  const base:[Ring,...Ring[]]=[toRing(shape.shape),...shape.holes.map(toRing)]
  if(polygonClipping.difference([base],...holes.map(h=>[toRing(h)])).length!==1)throw new Error('蜂窝未形成连续板件，请调整孔距或筋宽')
  return result(holes,width,main?.style??'honeycomb')
}
