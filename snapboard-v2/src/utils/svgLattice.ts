import ClipperLib from 'clipper-lib'
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { Color, Vector2 } from 'three'
import type { LatticeFaceData, Point2D, SplitConfig, SplitPanel, SvgLatticeOptions, SvgLatticePlacement } from '../types/geometry'
import { flattenTextureVectorCurve } from './textureVectorRegions'
import { fillTextureRings, insetTexturePolygon } from './texturePolygon'
import { prepareTextureSvg } from './textureSvg'
import { generateOpenLattice, roundLatticeWindowCorners, type OpenLatticeResult } from './openLattice'
import { createSplitPanelShape } from './boardMesh'

export interface SvgLatticeArtwork {
  fills: MultiPolygon[]
  strokes: Array<{ points: Point2D[]; width: number; closed: boolean }>
  padOutline?: MultiPolygon
}

// One worker request reuses an immutable drawing across all panels.
const printableArtworkCache = new WeakMap<SvgLatticeArtwork, { width: number; pieces: MultiPolygon[];
  outline?: { gapMm: number; shape: 'silhouette' | 'contour'; polygons: MultiPolygon } }>()

export const DEFAULT_SVG_LATTICE_PLACEMENT: SvgLatticePlacement = {
  offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, flipX: false, flipY: false,
}

export const DEFAULT_SVG_LATTICE_OPTIONS: SvgLatticeOptions = {
  mode: 'fidelity', lineWidthMm: 0.84, backingMm: 1, coverage: 'artwork', padShape: 'silhouette',
  outlineGapMm: 2, contrastColor: '#263238',
}

export const svgFacePanelSignature = (panel: SplitPanel, cfg: SplitConfig) => JSON.stringify([
  cfg.thickness, cfg.cornerRadius, cfg.slotLength, cfg.slotWidth, cfg.jointDiameter,
  panel.contour, panel.roundIdx, panel.outerCorners, panel.cutouts, panel.slots, panel.round_holes,
  panel.latticeOptions,
  panel.edge_holes.filter(h => h.knocked || Math.abs(h.x - panel.x) < 0.5 || Math.abs(h.x - panel.x - panel.w) < 0.5 ||
    Math.abs(h.y - panel.y) < 0.5 || Math.abs(h.y - panel.y - panel.h) < 0.5).map(h => [h.x, h.y, !!h.knocked]),
])

export function currentSvgFace(panel: SplitPanel, cfg: SplitConfig): LatticeFaceData {
  const face = panel.latticeFace
  if (!face) throw new Error('板件没有图案保真数据')
  if (!face.source) return face
  if (face.source.signature === svgFacePanelSignature(panel, cfg)) {
    const floor = cfg.thickness - face.source.options.backingMm
    if (!face.layers.some(layer => layer.role === 'structure' && layer.zMax > floor + 1e-6)) return face
    // Old projects divided the carrier into window islands alongside the ribs.
    // Rebuild that same solid as one horizontal carrier, not as through holes.
    const carriers = face.layers.filter(layer => layer.role === 'structure' || layer.role === 'backing')
    const domains = carriers.map(layer => layer.polygons.map(p => p.map(ring)))
    const continuous = polygonClipping.union(domains[0], ...domains.slice(1))
    const polygons = continuous.map(p => p.map(r => r.slice(0,-1).map(([x,y]) => ({x,y}))))
    const capZ = Math.min(...face.layers.filter(layer => layer.role === 'face').map(layer => layer.zMin))
    return { ...face, layers: [
      ...face.layers.filter(layer => layer.role === 'structure').map(layer => ({ ...layer, zMax: floor })),
      { role: 'backing', polygons, zMin: floor, zMax: capZ },
      ...face.layers.filter(layer => layer.role === 'face' || layer.role === 'detail'),
    ] }
  }
  const artwork = { fills: [face.source.artwork.map(p => p.map(ring))], strokes: [],
    padOutline: face.source.silhouette?.map(p => p.map(ring)) }
  const updated = generateSvgFace(panel, cfg, artwork, 3.5, 'svg', face.source.options, true,
    face.source.templateStyle ?? 'hex').face
  if (!updated) throw new Error('当前孔位覆盖了图案，请移动线稿后更新镂空')
  return updated
}

export function svgLatticeTransform(view: [number, number, number, number],
  bounds: { x: number; y: number; w: number; h: number },
  placement: SvgLatticePlacement = DEFAULT_SVG_LATTICE_PLACEMENT) {
  if (![...view, bounds.x, bounds.y, bounds.w, bounds.h, placement.offsetX, placement.offsetY,
    placement.scale, placement.rotationDeg].every(Number.isFinite) ||
    !(view[2] > 0 && view[3] > 0 && bounds.w > 10 && bounds.h > 10) ||
    placement.scale < 0.1 || placement.scale > 4 ||
    Math.abs(placement.offsetX) > 2000 || Math.abs(placement.offsetY) > 2000 ||
    Math.abs(placement.rotationDeg) > 180) throw new Error('SVG 的位置、尺寸或角度无效')
  const fitScale = Math.min((bounds.w - 10) / view[2], (bounds.h - 10) / view[3])
  const scale = fitScale * placement.scale
  const angle = placement.rotationDeg * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  // SVG Y points down; manufacturing and the 3D front view use Y up.
  const sx = scale * (placement.flipX ? -1 : 1), sy = -scale * (placement.flipY ? -1 : 1)
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy
  const sourceX = view[0] + view[2] / 2, sourceY = view[1] + view[3] / 2
  const centerX = bounds.x + bounds.w / 2 + placement.offsetX
  const centerY = bounds.y + bounds.h / 2 + placement.offsetY
  return { a, b, c, d, e: centerX - a * sourceX - c * sourceY,
    f: centerY - b * sourceX - d * sourceY, fitScale, scale }
}

export const DEFAULT_FLOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<g fill="none" stroke="#222" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
${[25, 75, 125, 175].map(x => `<path d="M${x} 0 V200"/>`).join('')}
${[25, 75, 125, 175].flatMap(x => [25, 75, 125, 175].map(y =>
    `<path d="M${x} ${y - 16} C${x + 5} ${y - 8} ${x + 8} ${y - 5} ${x + 16} ${y} C${x + 8} ${y + 5} ${x + 5} ${y + 8} ${x} ${y + 16} C${x - 5} ${y + 8} ${x - 8} ${y + 5} ${x - 16} ${y} C${x - 8} ${y - 5} ${x - 5} ${y - 8} ${x} ${y - 16} Z"/>`)).join('')}
</g></svg>`

const SCALE = 1000
const ring = (points: Point2D[]): Ring => [...points.map(p => [p.x, p.y] as [number, number]), [points[0].x, points[0].y]]
const polygon = (points: Point2D[]): Polygon => [ring(points)]
const circle = (x: number, y: number, radius: number): Polygon => polygon(Array.from({ length: 24 }, (_, i) => {
  const a = i * Math.PI / 12
  return { x: x + radius * Math.cos(a), y: y + radius * Math.sin(a) }
}))
const area = (points: Point2D[]) => Math.abs(points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length]
  return sum + p.x * q.y - q.x * p.y
}, 0)) / 2
const toPoints = (points: Ring): Point2D[] => points.slice(0, -1).map(([x, y]) => ({ x, y }))

/** SVG is parsed once in the browser; the worker receives only bounded millimetre geometry. */
export function recognizeSvgLattice(text: string, bounds: { x: number; y: number; w: number; h: number },
  placement: SvgLatticePlacement = DEFAULT_SVG_LATTICE_PLACEMENT,
  mapping?: { a: number; b: number; c: number; d: number; e: number; f: number; scale: number }): SvgLatticeArtwork {
  if (text.length > 2_000_000) throw new Error('SVG 不能超过 2 MB；请先简化线稿')
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('SVG 不能包含外部文档或实体声明')
  prepareTextureSvg(text)
  const xml = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = xml.documentElement
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if ((node.localName === 'namedview' && node.namespaceURI === 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd') ||
      (node.localName === 'defs' && !node.children.length)) node.remove()
  }
  const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'title', 'desc', 'metadata'])
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (!allowed.has(node.localName) || (node !== root && node.localName === 'svg'))
      throw new Error(`SVG 的 ${node.localName} 暂不能识别为制造轮廓；请先转成纯路径`)
    for (const attr of Array.from(node.attributes)) if (['filter', 'clip-path', 'mask', 'vector-effect'].includes(attr.name))
      throw new Error(`SVG 的 ${attr.name} 暂不能识别为制造轮廓；请先转曲并展开外观`)
    else if (/currentColor|var\(|url\(/i.test(attr.value)) throw new Error('SVG 使用了动态颜色或图案引用，请先展开为普通路径')
  }
  const view = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (!view || view.length !== 4 || !view.every(Number.isFinite) || view[2] <= 0 || view[3] <= 0)
    throw new Error('SVG 需要有效的 viewBox，才能准确映射到板件')
  const transform = mapping ?? svgLatticeTransform(view as [number, number, number, number], bounds, placement)
  const map = (p: Vector2): [number, number] => [transform.a * p.x + transform.c * p.y + transform.e,
    transform.b * p.x + transform.d * p.y + transform.f]
  const fills: MultiPolygon[] = [], strokes: SvgLatticeArtwork['strokes'] = []
  let points = 0, contours = 0
  for (const path of new SVGLoader().parse(new XMLSerializer().serializeToString(root)).paths) {
    const style = (path.userData?.style ?? {}) as { fill?: string; fillRule?: string; stroke?: string; strokeWidth?: number; opacity?: number; fillOpacity?: number; strokeOpacity?: number }
    if ((style.opacity ?? 1) !== 1 || (style.fillOpacity ?? 1) !== 1 || (style.strokeOpacity ?? 1) !== 1)
      throw new Error('半透明线条无法稳定识别为实体连筋，请先展开外观')
    const dark = (value: string | undefined) => {
      if (!value || value === 'none') return false
      const color = new Color(value)
      return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 < 0.82
    }
    const keepStroke = dark(style.stroke), keepFill = dark(style.fill)
    if (!keepStroke && !keepFill) continue
    const filled: Ring[] = []
    for (const sub of path.subPaths) {
      if (++contours > 3000) throw new Error('SVG 路径超过 3000 条，请先简化线稿')
      const raw = sub.curves.flatMap((curve, i) => flattenTextureVectorCurve(curve, map, 0.3).slice(i ? 1 : 0))
      points += raw.length
      if (points > 120_000) throw new Error('SVG 轮廓超过 120000 个采样点，请先简化线稿')
      const clean = raw.filter((p, i) => !i || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 0.02)
      if (clean.length < 2) continue
      const closed = Math.hypot(clean[0][0] - clean.at(-1)![0], clean[0][1] - clean.at(-1)![1]) < 0.2
      if (closed) clean.pop()
      if (keepStroke) strokes.push({ points: clean.map(([x, y]) => ({ x, y })),
        width: Math.max(0, Number(style.strokeWidth) || 0) * transform.scale, closed })
      if (keepFill && clean.length >= 3) filled.push([...clean, clean[0]])
    }
    if (filled.length) fills.push(fillTextureRings(filled, style.fillRule || 'nonzero'))
  }
  if (!fills.length && !strokes.length) throw new Error('没有识别到深色矢量轮廓；请使用路径或描边 SVG')
  return { fills, strokes }
}

export function svgLatticeStroke(points: Point2D[], width: number, closed = false): MultiPolygon {
  if (points.length < 2) return []
  const offset = new ClipperLib.ClipperOffset(2, 0.02 * SCALE)
  offset.AddPath(points.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
    ClipperLib.JoinType.jtRound, closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound)
  const paths: ClipperLib.Paths = []
  offset.Execute(paths, width * SCALE / 2)
  return fillTextureRings(paths.filter(path => path.length >= 3).map(path =>
    path.map(p => [p.X / SCALE, p.Y / SCALE] as [number, number])), 'evenodd')
}
const line = svgLatticeStroke

function widenFill(fill: MultiPolygon, width: number): MultiPolygon {
  const offset = new ClipperLib.ClipperOffset(2, 0.02 * SCALE)
  for (const p of fill) for (const [i, ring] of p.entries()) {
    const path = ring.slice(0, -1).map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
    if (ClipperLib.Clipper.Orientation(path) !== (i === 0)) path.reverse()
    offset.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  }
  const paths: ClipperLib.Paths = []
  offset.Execute(paths, width * SCALE / 2)
  return fillTextureRings(paths.map(path => path.map(p => [p.X / SCALE, p.Y / SCALE])), 'nonzero')
}

/** A row envelope closes open portrait linework without using a rectangular or convex hull. */
function lineworkEnvelope(ink: MultiPolygon): MultiPolygon {
  const rings = ink.map(p => p[0]), points = rings.flat()
  const [yMin, yMax] = points.reduce(([min, max], p) => [Math.min(min, p[1]), Math.max(max, p[1])], [Infinity, -Infinity])
  if (!(yMax > yMin)) throw new Error('线稿外缘高度不足')
  // ponytail: cap scan rows at 768; this is a backing outline, not the fine drawing geometry.
  const rows = Math.min(768, Math.max(16, Math.ceil((yMax - yMin) / 0.5)))
  const left: Point2D[] = [], right: Point2D[] = []
  for (let row = 0; row < rows; row++) {
    const y = yMin + (yMax - yMin) * (row + 0.5) / rows
    let min = Infinity, max = -Infinity
    for (const r of rings) for (let i = 0; i < r.length - 1; i++) {
      const a = r[i], b = r[i + 1]
      if ((a[1] > y) === (b[1] > y)) continue
      const x = a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
      min = Math.min(min, x); max = Math.max(max, x)
    }
    if (max > min) { left.push({ x: min, y }); right.push({ x: max, y }) }
  }
  if (left.length < 2) throw new Error('未识别到连续线稿外缘')
  return [polygon([...left, ...right.reverse()])]
}

function capsule(x: number, y: number, length: number, radius: number): Polygon {
  const half = Math.max(0, (length - 2 * radius) / 2)
  const points: Point2D[] = []
  for (let i = 0; i <= 12; i++) { const a = i * Math.PI / 12; points.push({ x: x + radius * Math.cos(a), y: y + half + radius * Math.sin(a) }) }
  for (let i = 0; i <= 12; i++) { const a = Math.PI + i * Math.PI / 12; points.push({ x: x + radius * Math.cos(a), y: y - half + radius * Math.sin(a) }) }
  return polygon(points)
}

function closestBridge(island: Polygon, main: Polygon, width: number): MultiPolygon {
  let best: [Point2D, Point2D, number] | null = null
  const samples = island[0].filter((_, i) => i % Math.max(1, Math.floor(island[0].length / 120)) === 0)
  for (const [x, y] of samples) for (const edge of main) for (let i = 0; i < edge.length - 1; i++) {
    const [ax, ay] = edge[i], [bx, by] = edge[i + 1]
    const dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    const q = { x: ax + t * dx, y: ay + t * dy }, d = Math.hypot(x - q.x, y - q.y)
    if (!best || d < best[2]) best = [{ x, y }, q, d]
  }
  return best ? line([best[0], best[1]], width) : []
}

export function generateSvgLattice(panel: SplitPanel, cfg: SplitConfig, artwork: SvgLatticeArtwork,
  ribMm = 3.5, style: 'svg' | 'flower' = 'svg', options?: SvgLatticeOptions): OpenLatticeResult {
  if (!panel.contour?.length || panel.slots.length < 4) throw new Error('请先生成包含功能长孔的平面板件')
  if (options?.mode === 'fidelity') return generateSvgFace(panel, cfg, artwork, ribMm, style, options, false, options.baseStyle ?? 'hex')
  if (!(ribMm >= 2.5 && ribMm <= 8)) throw new Error('窗花筋宽须在 2.5–8mm 之间')
  const outer: MultiPolygon = [polygon(panel.contour)]
  const frameMm = style === 'svg' ? Math.max(5, ribMm) : ribMm
  const inset = insetTexturePolygon(outer, frameMm)
  if (!inset.length) throw new Error('板件太小，无法保留连续边框')
  const artPieces: MultiPolygon[] = [...artwork.fills]
  for (const stroke of artwork.strokes) artPieces.push(line(stroke.points, Math.max(ribMm, stroke.width), stroke.closed))
  const pieces: MultiPolygon[] = [polygonClipping.difference(outer, inset), ...artPieces]
  if (style === 'svg' || options?.baseStyle) {
    const backing = generateOpenLattice(panel, cfg, ribMm, options?.baseStyle ?? 'organic')
    const backingWindows = backing.holes.flatMap(hole => insetTexturePolygon([polygon(hole)], 0.75))
    pieces.push(polygonClipping.difference(outer, ...backingWindows))
  } else for (let y = panel.y + 40; y < panel.y + panel.h - 20; y += 40)
    pieces.push(line([{ x: panel.x, y }, { x: panel.x + panel.w, y }], ribMm))
  const clearance = frameMm + 0.75
  for (const slot of panel.slots) pieces.push([capsule(slot.x, slot.y, cfg.slotLength + 2 * clearance,
    cfg.slotWidth / 2 + clearance)])
  for (const hole of [...panel.round_holes, ...panel.edge_holes.filter(hole => hole.knocked)])
    pieces.push([circle(hole.x, hole.y, cfg.jointDiameter / 2 + clearance)])
  for (const cutout of panel.cutouts ?? []) pieces.push([polygon(cutout)])
  const nonempty = pieces.filter(piece => piece.length)
  let solid = polygonClipping.intersection(outer, polygonClipping.union(nonempty[0], nonempty[1], ...nonempty.slice(2)))
  if (solid.length > 64) throw new Error('线稿有过多孤立图形；请简化或连接轮廓')
  if (solid.length > 1) {
    const main = solid.reduce((a, b) => area(toPoints(a[0])) > area(toPoints(b[0])) ? a : b)
    const bridges = solid.filter(item => item !== main).flatMap(item => closestBridge(item, main, ribMm))
    solid = polygonClipping.intersection(outer, polygonClipping.union(solid, ...bridges.map(item => [item])))
  }
  if (solid.length !== 1) throw new Error('线稿存在无法连接的悬浮部分，请简化后重试')
  const voids = polygonClipping.difference(outer, solid)
  if (voids.some(item => item.length !== 1)) throw new Error('线稿形成了悬浮材料，请使所有线条连接到边框')
  const holes = voids.flatMap(item => insetTexturePolygon([item], 0.15)).map(item =>
    ClipperLib.Clipper.CleanPolygon(item[0].slice(0, -1).map(([x, y]) =>
    ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })), 0.15 * SCALE)
    .map(point => ({ x: point.X / SCALE, y: point.Y / SCALE })))
    .filter(item => item.length >= 3 && area(item) >= 20)
    .map(item => roundLatticeWindowCorners(item))
  if (!holes.length || holes.length > 500 || holes.reduce((sum, item) => sum + item.length, 0) > 24_000)
    throw new Error('SVG 窗花开孔数量或复杂度超出安全范围；请简化线稿')
  return { holes, removedAreaMm2: holes.reduce((sum, item) => sum + area(item), 0), ribMm, style }
}

/** Keep the reference skeleton behind a local opaque face, instead of overlaying it on the drawing. */
function generateSvgFace(panel: SplitPanel, cfg: SplitConfig, artwork: SvgLatticeArtwork,
  ribMm: number, style: 'svg' | 'flower', options: SvgLatticeOptions, prepared = false,
  templateStyle: 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs' = 'hex', existingPlan?: OpenLatticeResult): OpenLatticeResult {
  if (!Number.isFinite(options.lineWidthMm) || options.lineWidthMm < 0.84 || options.lineWidthMm > 4 ||
    !Number.isFinite(options.backingMm) || options.backingMm < 0.8 || options.backingMm > 2 ||
    cfg.thickness - options.backingMm < 2 ||
    (options.coverage !== undefined && !['artwork', 'whole'].includes(options.coverage)) ||
    (options.padShape !== undefined && !['rectangle', 'silhouette', 'contour'].includes(options.padShape)) ||
    (options.outlineGapMm !== undefined && (!Number.isFinite(options.outlineGapMm) || options.outlineGapMm < 0 || options.outlineGapMm > 10)) ||
    (options.contrastColor !== undefined && !/^#[0-9a-f]{6}$/i.test(options.contrastColor)))
    throw new Error('保真线宽须为 0.84–4mm，托底须为 0.8–2mm，且保留至少 2mm 背部空间')
  const backing = existingPlan ?? generateOpenLattice(panel, cfg, ribMm, templateStyle)
  const whole = options.coverage === 'whole'
  const shape = createSplitPanelShape({ ...panel, latticeCutouts: undefined, latticeFace: undefined }, cfg, 12)
  const base = polygonClipping.difference([ring(shape.getPoints(24))],
    ...shape.holes.map(hole => [ring(hole.getPoints(24))]))
  const structure = backing.highStructure?polygonClipping.intersection(base,backing.highStructure.map(p=>p.map(ring))):polygonClipping.difference(base,backing.holes.map(p=>polygon(p)))
  const windows: MultiPolygon = polygonClipping.difference(base,structure)
  let raw = printableArtworkCache.get(artwork)
  if (!raw || raw.width !== options.lineWidthMm) {
    raw = { width: options.lineWidthMm, pieces: [
      ...artwork.fills.map(fill => prepared ? fill : widenFill(fill, options.lineWidthMm)),
      ...artwork.strokes.map(stroke => line(stroke.points, Math.max(options.lineWidthMm, stroke.width), stroke.closed)),
    ] }
    printableArtworkCache.set(artwork, raw)
  }
  const pieces = raw.pieces
    .map(piece => polygonClipping.intersection([ring(shape.getPoints(24))], piece)).filter(piece => piece.length)
  if (!pieces.length && !whole) return { ...backing, style }
  let art = pieces.length ? polygonClipping.union(pieces[0], ...pieces.slice(1)) : []
  const sourceArt = art
  // Preserve the original functional hole collars and perimeter; unused circle guides are not anchors.
  const keepouts: MultiPolygon[] = panel.slots.map(slot => [capsule(slot.x, slot.y,
    cfg.slotLength + 2.4, cfg.slotWidth / 2 + 1.2)])
  for (const hole of [...panel.round_holes, ...panel.edge_holes.filter(hole => hole.knocked)])
    keepouts.push([circle(hole.x, hole.y, cfg.jointDiameter / 2 + 1.2)])
  if (art.length) art = polygonClipping.intersection(art, insetTexturePolygon(base, 0.6))
  if (art.length && keepouts.length) art = polygonClipping.difference(art, ...keepouts)
  if (!art.length && !whole) return { ...backing, style }
  const points = art.flatMap(p => p.flat())
  if (points.length > 24_000) throw new Error('保真线稿超过 24000 个轮廓点，请先简化 SVG')
  let supports: MultiPolygon = [], face: MultiPolygon = []
  let silhouette = artwork.padOutline
  // ponytail: a local rectangular pad avoids a second image segmentation engine;
  // expand only when a tiny pad would float inside one reference window.
  if (whole) {
    supports = polygonClipping.intersection(windows, base)
    face = base
  } else if (options.padShape === 'silhouette' || options.padShape === 'contour') {
    const gapMm = options.outlineGapMm ?? 2
    if (!silhouette) {
      if (!raw.outline || raw.outline.gapMm !== gapMm || raw.outline.shape !== options.padShape) {
        const ink = polygonClipping.union(raw.pieces[0], ...raw.pieces.slice(1))
        const closed = gapMm ? insetTexturePolygon(widenFill(ink, gapMm * 2), gapMm) : ink
        if (!closed.length) throw new Error('没有识别到可用外轮廓，请调整轮廓闭合距离')
        const largest = closed.reduce((a, b) => area(toPoints(a[0])) >= area(toPoints(b[0])) ? a : b)
        // Interior eyes/hair gaps never become backing cutouts. Envelope mode can also bridge open outlines.
        const boundary = options.padShape === 'silhouette' ? lineworkEnvelope(closed) : [[largest[0]]]
        raw.outline = { gapMm, shape: options.padShape, polygons: widenFill(boundary, 1.2) }
      }
      silhouette = raw.outline.polygons
    }
    supports = polygonClipping.intersection(windows, base, silhouette)
    face = supports.length ? polygonClipping.union(structure, supports) : structure
  } else {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1])
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  for (const pad of [2, 5, 10, 20]) {
    const region = polygon([{ x: bounds[0] - pad, y: bounds[1] - pad },
      { x: bounds[2] + pad, y: bounds[1] - pad }, { x: bounds[2] + pad, y: bounds[3] + pad },
      { x: bounds[0] - pad, y: bounds[3] + pad }])
    supports = polygonClipping.intersection(windows, base, [region])
    face = supports.length ? polygonClipping.union(structure, supports) : structure
    if (face.length === 1) break
  }
  }
  if (face.length !== 1) throw new Error('随形托底未连上骨架，请放大线稿或切换矩形托底')
  if (art.length) art = polygonClipping.intersection(art, face)
  if (art.length && !options.contrastColor && insetTexturePolygon(art, 2).length)
    throw new Error('单色凹刻中的大面积填充会形成过宽的打印桥接；请启用双色镶嵌，或将 SVG 填充转换为细线稿')
  const cap = art.length ? polygonClipping.difference(face, art) : face
  const toPolygons = (mp: MultiPolygon) => mp.map(p => p.map(r => r.slice(0, -1).map(([x, y]) => ({ x, y }))))
  const capDepth = 0.4, recessDepth = 0.2
  const layers: LatticeFaceData['layers'] = [
    { role: 'structure', polygons: toPolygons(structure), zMin: 0, zMax: cfg.thickness - options.backingMm },
    { role: 'backing', polygons: toPolygons(face), zMin: cfg.thickness - options.backingMm, zMax: cfg.thickness - capDepth },
    { role: 'face', polygons: toPolygons(cap), zMin: cfg.thickness - capDepth, zMax: cfg.thickness },
    ...(art.length ? [{ role: 'detail' as const, polygons: toPolygons(art), zMin: cfg.thickness - capDepth,
      zMax: cfg.thickness - (options.contrastColor ? 0 : recessDepth) }] : []),
  ]
  if(backing.auxiliary?.length){
    const floor=cfg.thickness-options.backingMm,split=Math.max(0,floor-1.96)
    const auxiliary=backing.auxiliary.map(p=>p.map(ring))
    const lowWindows=polygonClipping.difference(windows,polygonClipping.intersection(auxiliary,face))
    const softened=lowWindows.map(p=>p.map((r,i)=>i===0?ring(roundLatticeWindowCorners(toPoints(r),.6)):r))
    const lower=polygonClipping.difference(base,softened)
    layers.splice(0,1,
      {role:'structure',polygons:toPolygons(structure),zMin:0,zMax:split},
      {role:'structure',polygons:toPolygons(lower),zMin:split,zMax:floor})
  }
  const open = polygonClipping.difference(windows, supports)
  const removedAreaMm2 = open.reduce((sum, p) => sum + p.reduce((s, r, i) =>
    s + (i ? -1 : 1) * area(toPoints(r)), 0), 0)
  return { ...backing, style, removedAreaMm2, face: { layers, contrastColor: options.contrastColor,
    source: { artwork: toPolygons(sourceArt), options, templateStyle,
      silhouette: silhouette && toPolygons(silhouette), signature: svgFacePanelSignature(panel, cfg) } } }
}

/** A retained front is the same layered solid as SVG backing, with no drawing. */
export function applyLatticeFrontLayer(panel: SplitPanel, cfg: SplitConfig, plan: OpenLatticeResult, surfaceMm = 0): OpenLatticeResult {
  if (!Number.isFinite(surfaceMm) || surfaceMm < 0) throw new Error('正面保留厚度无效')
  if (!surfaceMm) return plan
  if (!['organic', 'hex', 'diamond', 'honeycomb', 'ribs'].includes(plan.style))
    throw new Error('线稿保留薄面请使用保真模式')
  const face = generateSvgFace(panel, cfg, { fills: [], strokes: [] }, plan.ribMm, 'svg',
    { mode: 'fidelity', lineWidthMm: 0.84, backingMm: surfaceMm, coverage: 'whole' }, false,
    plan.style as 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs', plan)
  return { ...face, style: plan.style }
}

/** Geometric material volume, not slicer filament usage or a strength rating. */
export function estimateLatticeVolume(panel: SplitPanel, cfg: SplitConfig, plan: OpenLatticeResult): OpenLatticeResult {
  const shape = createSplitPanelShape({ ...panel, latticeCutouts: undefined, latticeFace: undefined }, cfg, 12)
  const base = polygonClipping.difference([ring(shape.getPoints(24))], ...shape.holes.map(h => [ring(h.getPoints(24))]))
  const mpArea = (mp: MultiPolygon) => mp.reduce((sum, p) => sum + p.reduce((s, r, i) => s + (i ? -1 : 1) * area(toPoints(r)), 0), 0)
  const volumeMm3 = plan.face ? plan.face.layers.reduce((sum, layer) => sum +
    mpArea(layer.polygons.map(p => p.map(ring))) * (layer.zMax - layer.zMin), 0)
    : mpArea(polygonClipping.difference(base, plan.holes.map(polygon))) * cfg.thickness
  return { ...plan, volumeMm3, baselineVolumeMm3: mpArea(base) * cfg.thickness }
}
