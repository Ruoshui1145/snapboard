import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { Vector2, type Curve, type CubicBezierCurve, type QuadraticBezierCurve, type EllipseCurve } from 'three'
import type { MultiPolygon, Ring, Pair } from 'polygon-clipping'
import {texturePolygon as pc,fillTextureRings as fillRings,insetTexturePolygon} from './texturePolygon'
import type { BoardTextureConfig, SplitPanel } from '../types/geometry'
import { estimatedTextureDataUrlBytes, migrateLegacySingleImageTexture, normalizeTextureComposition, resolveTextureLayerPlacements, textureCompositionSignature, type TextureCompositionBounds } from './textureComposition'

export interface TextureVectorRegion { color: string; polygons: MultiPolygon }
export type TextureVectorResult = { eligible: true; regions: TextureVectorRegion[]; toleranceMm: number } | { eligible: false; reason: string }
type MapPoint = (p: Vector2) => Pair
// ponytail: retain the existing 24 MiB admission ceiling; larger art needs the native recipe grid, not more renderer heap.
export function textureVectorBudgetError(config: BoardTextureConfig): string | null {
  if (!config.enabled || !['image', 'composition'].includes(config.source)) return null
  const composition = config.composition
  const legacy = config.source === 'image' || !composition?.layers.length
  const visibleIds = new Set((composition?.layers ?? []).flatMap(layer => !layer.visible || layer.opacity === 0 ? []
    : layer.kind === 'image' ? [layer.assetId] : layer.kind === 'panel-sequence'
      ? [...layer.assetIds, ...Object.values(layer.panelAssetMap ?? {})] : []))
  const sources = new Set(legacy ? [config.imageDataUrl] : (composition?.assets ?? [])
    .filter(asset => visibleIds.has(asset.id) && asset.mime === 'image/svg+xml').map(asset => asset.dataUrl))
  let bytes = 0
  for (const source of sources) if (source && (legacy ? /^data:image\/svg\+xml[;,]/i.test(source) : true)) {
    bytes += estimatedTextureDataUrlBytes(source)
  }
  return bytes >= 24 * 1024 * 1024
    ? '可见 SVG 总量达到 24 MB，浏览器直接解析可能耗尽内存。请使用本地制造流程；已在计算前停止。' : null
}
const rectangle = (x: number, y: number, w: number, h: number): MultiPolygon => [[[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]]
const distance = (p: Pair, a: Pair, b: Pair) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], n = dx * dx + dy * dy
  const t = n ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
const midpoint = (a: Pair, b: Pair): Pair => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

/** Flatten in final board millimetres. Bezier convex-hull bounds, not a fixed pixel sample count. */
export function flattenTextureVectorCurve(curve: Curve<Vector2>, map: MapPoint, toleranceMm: number): Ring {
  const result: Ring = [map(curve.getPoint(0))]
  const bezier = (points: Pair[], depth = 0): void => {
    if (points.slice(1, -1).every(p => distance(p, points[0], points.at(-1)!) <= toleranceMm)) { result.push(points.at(-1)!); return }
    if (depth >= 20) throw new Error('曲线细分超过安全上限')
    const left = [points[0]], right = [points.at(-1)!]
    while (points.length > 1) { points = points.slice(1).map((p, i) => midpoint(points[i], p)); left.push(points[0]); right.unshift(points.at(-1)!) }
    bezier(left, depth + 1); bezier(right, depth + 1)
  }
  if (curve.type === 'LineCurve') result.push(map(curve.getPoint(1)))
  else if (curve.type === 'CubicBezierCurve') { const c = curve as CubicBezierCurve; bezier([c.v0, c.v1, c.v2, c.v3].map(map)) }
  else if (curve.type === 'QuadraticBezierCurve') { const c = curve as QuadraticBezierCurve; bezier([c.v0, c.v1, c.v2].map(map)) }
  else if (curve.type === 'EllipseCurve') {
    const c = curve as EllipseCurve
    const o = map(new Vector2(c.aX, c.aY)), co = Math.cos(c.aRotation), si = Math.sin(c.aRotation)
    const rx = map(new Vector2(c.aX + c.xRadius * co, c.aY + c.xRadius * si))
    const ry = map(new Vector2(c.aX - c.yRadius * si, c.aY + c.yRadius * co))
    const bound = Math.hypot(rx[0] - o[0], rx[1] - o[1]) + Math.hypot(ry[0] - o[0], ry[1] - o[1])
    // Full-turn bound also covers short arcs; each segment's interpolation error <= |r''| dt² / 8.
    const count = Math.max(2, Math.ceil(Math.PI * 2 * Math.sqrt(bound / (8 * toleranceMm))))
    if (count > 16384) throw new Error('椭圆细分超过安全上限')
    for (let i = 1; i <= count; i++) result.push(map(c.getPoint(i / count)))
  } else throw new Error(`未支持的矢量曲线：${curve.type}`)
  if (result.some(p => !p.every(Number.isFinite))) throw new Error('矢量坐标无效')
  return result
}

function svgSource(dataUrl: string): string {
  if (!/^data:image\/svg\+xml[;,]/i.test(dataUrl)) throw new Error('包含位图资源，使用栅格轮廓路线')
  const comma = dataUrl.indexOf(','), body = dataUrl.slice(comma + 1)
  if (!/;base64/i.test(dataUrl.slice(0, comma))) return decodeURIComponent(body)
  const binary = atob(body), bytes = new Uint8Array(binary.length)
  // Uint8Array.from(string) first materializes an enormous iterable character array.
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function parseSvg(dataUrl: string) {
  let source = svgSource(dataUrl)
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml'), root = xml.documentElement
  if (root.localName !== 'svg' || xml.querySelector('parsererror')) throw new Error('SVG 文档无效')
  // Editor view state does not paint anything. Do not reject a whole traced
  // drawing because Inkscape retained its page/zoom settings.
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if ((node.localName === 'namedview' && node.namespaceURI === 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd') ||
      (['metadata','title','desc'].includes(node.localName) && node.namespaceURI === 'http://www.w3.org/2000/svg') ||
      (node.localName === 'defs' && !node.children.length)) node.remove()
  }
  source = new XMLSerializer().serializeToString(root)
  const rasterIds = new Set<string>()
  for (const node of Array.from(root.querySelectorAll('image'))) {
    // Keep the transformed image footprint in painter order. It is only safe
    // to omit embedded pixels if later opaque paths cover the entire footprint.
    if (node.namespaceURI !== 'http://www.w3.org/2000/svg') continue
    const rect = xml.createElementNS('http://www.w3.org/2000/svg', 'rect')
    for (const attr of Array.from(node.attributes)) if (!['href','id','preserveAspectRatio'].includes(attr.localName)) rect.setAttribute(attr.name,attr.value)
    const id = `raster-${crypto.randomUUID()}`; rect.setAttribute('id',id);rect.setAttribute('fill','#000000');rasterIds.add(id)
    node.replaceWith(rect)
  }
  source = new XMLSerializer().serializeToString(root)
  const allowedTags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'title', 'desc', 'metadata'])
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (['metadata', 'title', 'desc'].includes(node.localName) && node.children.length) throw new Error('SVG 元数据包含嵌套元素，使用栅格轮廓路线')
    if (node.prefix || node.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('SVG 命名空间暂不支持')
    if (node === root && node.hasAttribute('transform')) throw new Error('根 SVG 变换暂不支持')
    if (!allowedTags.has(node.localName) || (node !== root && node.localName === 'svg')) throw new Error(`SVG ${node.localName} 暂不支持直接矢量制造`)
    for (const attr of Array.from(node.attributes)) {
      if (['filter', 'clip-path', 'mask', 'class', 'display', 'visibility', 'vector-effect'].includes(attr.name)) throw new Error(`SVG ${attr.name} 需使用栅格轮廓路线`)
      if (/url\(|currentColor|var\(/i.test(attr.value)) throw new Error('SVG 引用了外部或动态绘制样式')
      if (/^(opacity|fill-opacity)$/.test(attr.name) && Number(attr.value) !== 1) throw new Error('半透明 SVG 暂不支持直接矢量制造')
      if (attr.name === 'style') for (const declaration of attr.value.split(';').filter(v => v.trim())) {
        const [key, ...values] = declaration.split(':'), value = values.join(':').trim()
        if (!['fill', 'fill-rule', 'fill-opacity', 'opacity', 'stroke', 'stroke-width', 'stroke-opacity'].includes(key.trim())) throw new Error(`SVG 样式 ${key} 暂不支持`)
        if (['opacity', 'fill-opacity'].includes(key.trim()) && Number(value) !== 1) throw new Error('半透明 SVG 暂不支持直接矢量制造')
      }
      if (['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2'].includes(attr.name) && attr.value.includes('%')) throw new Error('百分比 SVG 尺寸需使用栅格轮廓路线')
    }
  }
  const vb = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (vb && (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0)) throw new Error('SVG viewBox 无效')
  const length = (name: string) => {
    const raw = root.getAttribute(name); if (!raw) return undefined
    const match = /^([\d.+-]+)(px|mm|cm|in|pt|pc)?$/.exec(raw.trim()); if (!match) throw new Error('SVG 尺寸单位不支持')
    return Number(match[1]) * ({ px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16 }[match[2] || 'px']!)
  }
  let width = length('width'), height = length('height')
  if (width && !height && vb) height = width * vb[3] / vb[2]
  if (height && !width && vb) width = height * vb[2] / vb[3]
  // Browser <img> fallback viewport for SVG with only intrinsic aspect ratio is not universally 1:viewBox.
  // Query the same image decoder used by preview, instead of assuming asset metadata is current.
  return { vb, width, height, rasterIds,
    preserveAspectRatio: root.getAttribute('preserveAspectRatio')?.trim() || 'xMidYMid meet',
    paths: new SVGLoader().parse(source).paths }
}

async function intrinsicSize(dataUrl: string): Promise<[number, number]> {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => img.naturalWidth && img.naturalHeight ? resolve([img.naturalWidth, img.naturalHeight]) : reject(new Error('SVG 固有尺寸无效')); img.onerror = () => reject(new Error('SVG 解码失败')); img.src = dataUrl })
}

/** Solid, disjoint regions covering bounds. Unsupported features return a whole-image fallback, never partial output. */
let lastKey = ''
let lastResult: Promise<TextureVectorResult> | undefined
export function buildTextureVectorRegions(config: BoardTextureConfig, bounds: TextureCompositionBounds, panels: SplitPanel[], toleranceMm = 0.035): Promise<TextureVectorResult> {
  const budgetError = textureVectorBudgetError(config)
  if (budgetError) return Promise.resolve({ eligible: false, reason: budgetError })
  const composition = normalizeTextureComposition(config.composition)
  const key = JSON.stringify([{
    ...config,
    imageDataUrl: config.imageDataUrl ? `${textureCompositionSignature(config.imageDataUrl)}:${config.imageDataUrl.length}` : '',
    composition: { ...composition, assets: composition.assets.map(({ dataUrl, ...asset }) => ({ ...asset, dataUrlLength: dataUrl.length })) },
  }, bounds, panels.map(p => [p.id, p.x, p.y, p.w, p.h, p.contour]), toleranceMm])
  if (key !== lastKey || !lastResult) { lastKey = key; lastResult = buildRegions(config, bounds, panels, toleranceMm) }
  return lastResult
}
async function buildRegions(config: BoardTextureConfig, bounds: TextureCompositionBounds, panels: SplitPanel[], toleranceMm: number): Promise<TextureVectorResult> {
  try {
    if (!config.enabled || !['image', 'composition'].includes(config.source)) throw new Error('当前纹理不是导入矢量图')
    if (config.surfaceMode === 'veneer' || config.modelingMode !== 'vector' || config.manufacturingContours === false) throw new Error('当前材质模式不使用矢量图案')
    if (config.opacity !== 1 || config.brightness !== 1 || config.contrast !== 1 || config.saturation !== 1 || config.colorMode !== 'original') throw new Error('颜色或透明度调整需使用栅格轮廓路线')
    if (!(toleranceMm > 0 && toleranceMm <= 0.2)) throw new Error('矢量轮廓容差无效')
    const base = /^#[0-9a-f]{6}$/i.test(config.baseColor) ? config.baseColor : '#e7eaed'
    const domain = rectangle(bounds.minX, bounds.minY, bounds.width, bounds.height)
    let regions: TextureVectorRegion[] = [{ color: base.toLowerCase(), polygons: domain }]
    const paint = (color: string, polygons: MultiPolygon) => {
      if (!polygons.length) return
      regions.push({ color, polygons })
      if (regions.length > 2048) throw new Error('矢量图层过于复杂')
    }
    let composition = normalizeTextureComposition(config.composition)
    const legacy = config.source === 'image'
    if (legacy || (!composition.layers.length && config.imageDataUrl)) composition = migrateLegacySingleImageTexture(config, bounds)
    if (legacy && config.fit === 'tile') throw new Error('旧式平铺图案需使用栅格轮廓路线')
    const aspect = Math.max(0.15, Math.min(6, bounds.width / bounds.height))
    const cw = aspect >= 1 ? 1024 : Math.max(256, Math.round(1024 * aspect)), ch = aspect >= 1 ? Math.max(256, Math.round(1024 / aspect)) : 1024
    const px = cw / bounds.width, py = ch / bounds.height
    const loaded = new Map<string, { parsed: ReturnType<typeof parseSvg>; size: [number, number] }>()
    let drawn = 0
    for (const layer of composition.layers) {
      if (!layer.visible || layer.opacity === 0) continue
      if (layer.kind === 'pattern' || layer.kind === 'preset') throw new Error('程序图案使用图片轮廓制造路线')
      if (layer.opacity !== 1) throw new Error('半透明图层需使用栅格轮廓路线')
      for (const placement of resolveTextureLayerPlacements(layer, panels, bounds)) {
        const asset = composition.assets.find(a => a.id === placement.assetId); if (!asset) throw new Error('图层缺少资源')
        if (!loaded.has(asset.dataUrl)) {
          const parsed = parseSvg(asset.dataUrl)
          let size: [number, number]
          if (typeof Image === 'undefined') {
            if (!parsed.width || !parsed.height) throw new Error('原生 SVG 制造要求明确的宽高或 viewBox')
            size = [parsed.width, parsed.height]
          } else size = await intrinsicSize(asset.dataUrl)
          loaded.set(asset.dataUrl, { parsed, size })
        }
        const { parsed, size: [iw, ih] } = loaded.get(asset.dataUrl)!
        const t = placement.transform, crop = placement.crop
        let tw = Math.max(1, t.widthMm * px), th = Math.max(1, t.heightMm * py)
        if (legacy) { tw = cw; th = ch }
        const sw = Math.max(1, crop.width * iw), sh = Math.max(1, crop.height * ih)
        let dw = tw, dh = th
        if (placement.fit !== 'stretch') { const useWidth = placement.fit === 'cover' ? sw / sh < tw / th : sw / sh > tw / th; if (useWidth) dh = tw * sh / sw; else dw = th * sw / sh }
        const angle = (legacy ? config.rotation : -t.rotationDeg) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
        const scale = legacy ? Math.max(0.1, config.scale / 100) : 1
        const local: MapPoint = p => {
          const x = p.x * (t.flipX ? -1 : 1) * scale, y = p.y * (t.flipY ? -1 : 1) * scale
          return [t.xMm + (c * x - s * y) / px, t.yMm - (s * x + c * y) / py]
        }
        let clip = domain
        if (!legacy) clip = pc.intersection(clip, [[rectangle(-tw / 2, -th / 2, tw, th)[0][0].map(p => local(new Vector2(...p)))]])
        if (placement.panelId) { const panel = panels.find(p => p.id === placement.panelId)!; const ring = panel.contour?.length ? panel.contour.map(p => [p.x, p.y] as Pair) : rectangle(panel.x, panel.y, panel.w, panel.h)[0][0]; clip = pc.intersection(clip, [[ring]]) }
        const vb = parsed.vb || [0, 0, iw, ih], par = parsed.preserveAspectRatio
        let sx = iw / vb[2], sy = ih / vb[3], ox = 0, oy = 0
        if (par !== 'none') {
          const match = /^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/.exec(par); if (!match) throw new Error('SVG preserveAspectRatio 暂不支持')
          sx = sy = match[3] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
          ox = (iw - vb[2] * sx) * (match[1] === 'xMin' ? 0 : match[1] === 'xMid' ? .5 : 1)
          oy = (ih - vb[3] * sy) * (match[2] === 'YMin' ? 0 : match[2] === 'YMid' ? .5 : 1)
        }
        const imagePoint: MapPoint = p => local(new Vector2((p.x - crop.x * iw) / sw * dw - dw / 2, (p.y - crop.y * ih) / sh * dh - dh / 2))
        clip = pc.intersection(clip, [[rectangle(0, 0, iw, ih)[0][0].map(p => imagePoint(new Vector2(...p)))]])
        clip = pc.intersection(clip, [[rectangle(crop.x * iw, crop.y * ih, sw, sh)[0][0].map(p => imagePoint(new Vector2(...p)))]])
        const map: MapPoint = p => imagePoint(new Vector2((p.x - vb[0]) * sx + ox, (p.y - vb[1]) * sy + oy))
        let uncoveredRaster: MultiPolygon = []
        for (const path of parsed.paths) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          const style = (path.userData?.style || {}) as { stroke?: string; strokeWidth?: number; strokeOpacity?: number; fill?: string; opacity?: number; fillOpacity?: number; fillRule?: string }
          if (style.stroke && style.stroke !== 'none' && style.strokeWidth !== 0 && style.strokeOpacity !== 0) throw new Error('SVG 描边暂不支持直接矢量制造，请先转轮廓或使用栅格路线')
          if (style.fill === 'none') continue
          const fill = style.fill || 'black'
          if (!/^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+|rgb\(\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+\s*\))$/i.test(fill) || fill.toLowerCase() === 'transparent' || (typeof CSS !== 'undefined' && !CSS.supports('color', fill))) throw new Error('SVG 填充颜色格式暂不支持直接矢量制造')
          if ((style.opacity ?? 1) !== 1 || (style.fillOpacity ?? 1) !== 1) throw new Error('SVG 半透明填充暂不支持')
          if (!['nonzero', 'evenodd', undefined].includes(style.fillRule)) throw new Error('SVG 填充规则无效')
          const rings: Ring[] = []
          for (const sub of path.subPaths) {
            const ring = sub.curves.flatMap((curve, i) => flattenTextureVectorCurve(curve, map, toleranceMm).slice(i ? 1 : 0))
            const snapped = ring.map(([x,y])=>[Math.round(x*1e6)/1e6,Math.round(y*1e6)/1e6] as Pair)
            const clean = snapped.filter((p,i)=>!i || Math.hypot(p[0]-snapped[i-1][0],p[1]-snapped[i-1][1])>1e-9)
            if (clean.length < 3) continue
            // Inkscape traces may close with a sub-micron residual segment.
            // Collapse only the closing tail, not arbitrary nearby features.
            while (clean.length > 2 && Math.hypot(clean[0][0]-clean.at(-1)![0],clean[0][1]-clean.at(-1)![1]) < 0.0001) clean.pop()
            clean.push(clean[0])
            rings.push(clean)
          }
          const filled = fillRings(rings, style.fillRule || 'nonzero')
          if (filled.length) {
            const visible = pc.intersection(filled, clip)
            if (parsed.rasterIds.has((path.userData?.node as Element | undefined)?.getAttribute('id') ?? '')) {
              uncoveredRaster = uncoveredRaster.length ? pc.union(uncoveredRaster,visible) : visible
            } else {
              if (uncoveredRaster.length) uncoveredRaster = pc.difference(uncoveredRaster,visible)
              paint(`#${path.color.getHexString()}`, visible)
            }
          }
        }
        // Inkscape's decimal page size can leave a sub-micron strip beside its
        // traced background. Anything wider still requires real raster data.
        if (uncoveredRaster.length && insetTexturePolygon(uncoveredRaster,0.0001).length) throw new Error('SVG 包含未被矢量完全覆盖的位图，请移除原始位图后导入')
        drawn++
      }
      // A layer's placements are complete; keeping every 10–20MB SVG parse tree
      // alive until the next layer multiplies peak heap for multi-image jobs.
      loaded.clear()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (!drawn) throw new Error('没有可制造的可见矢量图层')
    for (const z of config.avoidZones) if (z.enabled) paint(base.toLowerCase(), pc.intersection(domain,rectangle(bounds.minX + z.x * bounds.width, bounds.minY + z.y * bounds.height, z.width * bounds.width, z.height * bounds.height)))
    // Resolve occlusion once per painted region, front to back. Inkscape's
    // stacked scans otherwise repeatedly cut every previously painted colour.
    let covered: MultiPolygon = []
    const visible: TextureVectorRegion[] = []
    for (let i=regions.length-1;i>=0;i--) {
      const r=regions[i]
      const polygons=covered.length ? pc.difference(r.polygons,covered) : r.polygons
      if(polygons.length) visible.push({color:r.color,polygons})
      covered=covered.length ? pc.union(covered,r.polygons) : r.polygons
      await new Promise<void>(resolve=>setTimeout(resolve,0))
    }
    regions=visible
    const merged = new Map<string, MultiPolygon>()
    for (const r of regions) merged.set(r.color, merged.has(r.color) ? pc.union(merged.get(r.color)!, r.polygons) : r.polygons)
    return { eligible: true, regions: [...merged].map(([color, polygons]) => ({ color, polygons })), toleranceMm }
  } catch (error) { return { eligible: false, reason: error instanceof Error ? error.message : 'SVG 矢量制造无法可靠解析，使用栅格轮廓路线' } }
}
