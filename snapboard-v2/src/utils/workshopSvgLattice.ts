import polygonClipping, { type MultiPolygon, type Pair } from 'polygon-clipping'
import type { BoardTextureConfig, SplitPanel } from '../types/geometry'
import { boardTextureForSide, editableTextureComposition } from './boardTexture'
import { resolveTextureLayerPlacements, type TextureCompositionAsset, type TextureCompositionBounds, type TextureCompositionImageLayer } from './textureComposition'
import { recognizeSvgLattice, svgLatticeStroke, type SvgLatticeArtwork } from './svgLattice'

export function decodeWorkshopSvg(asset: TextureCompositionAsset): string {
  if (!/^data:image\/svg\+xml[;,]/i.test(asset.dataUrl)) throw new Error('当前图层不是 SVG 矢量素材')
  const comma = asset.dataUrl.indexOf(','), body = asset.dataUrl.slice(comma + 1)
  return /;base64/i.test(asset.dataUrl.slice(0, comma))
    ? new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))) : decodeURIComponent(body)
}

/** A referenced SVG is manufactured by the linework solid, not an extra colour stack. */
export function sharedSvgStructureOnly(texture: BoardTextureConfig, panels: SplitPanel[], layerIds: string[]): boolean {
  if (texture.backEnabled || !layerIds.length || layerIds.some(id => id !== layerIds[0])) return false
  const composition = editableTextureComposition(boardTextureForSide(texture, 'front'), panels)
  const visible = composition.layers.filter(layer => layer.visible)
  const layer = visible[0]
  return visible.length === 1 && layer.kind === 'image' && layer.id === layerIds[0] &&
    layer.opacity === 1 && composition.assets.some(asset => asset.id === layer.assetId && asset.mime === 'image/svg+xml')
}

/** Resolve the existing layer placement, crop, repeat and mirrors; no second positioning UI. */
export function workshopSvgArtwork(asset: TextureCompositionAsset, layer: TextureCompositionImageLayer,
  bounds: TextureCompositionBounds, panels: SplitPanel[]): SvgLatticeArtwork {
  if (layer.opacity !== 1) throw new Error('制造线稿需要不透明 SVG 图层，请在纹理工作室把透明度设为100%')
  const source = decodeWorkshopSvg(asset)
  const root = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement
  const vb = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (!vb || vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) throw new Error('SVG 缺少有效 viewBox')
  const iw = asset.width, ih = asset.height
  const par = root.getAttribute('preserveAspectRatio')?.trim() || 'xMidYMid meet'
  let sx = iw / vb[2], sy = ih / vb[3], ox = 0, oy = 0
  if (par !== 'none') {
    const match = /^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/.exec(par)
    if (!match) throw new Error('SVG preserveAspectRatio 暂不能映射为制造线稿')
    sx = sy = match[3] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
    ox = (iw - vb[2] * sx) * (match[1] === 'xMin' ? 0 : match[1] === 'xMid' ? .5 : 1)
    oy = (ih - vb[3] * sy) * (match[2] === 'YMin' ? 0 : match[2] === 'YMid' ? .5 : 1)
  }
  const placements = resolveTextureLayerPlacements(layer, panels, bounds)
  if (placements.length > 128) throw new Error('SVG 阵列超过128份，请在纹理工作室减少重复数量')
  const fills: MultiPolygon[] = []
  const rect = (x: number, y: number, w: number, h: number, map: (x: number, y: number) => Pair): MultiPolygon =>
    [[[map(x,y),map(x+w,y),map(x+w,y+h),map(x,y+h),map(x,y)]]]
  for (const placement of placements) {
    const t = placement.transform, crop = placement.crop
    const sw = crop.width * iw, sh = crop.height * ih
    let dw = t.widthMm, dh = t.heightMm
    if (placement.fit !== 'stretch') {
      const useWidth = placement.fit === 'cover' ? sw / sh < dw / dh : sw / sh > dw / dh
      if (useWidth) dh = dw * sh / sw; else dw = dh * sw / sh
    }
    const angle = -t.rotationDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
    const local = (x: number, y: number): Pair => {
      x *= t.flipX ? -1 : 1; y *= t.flipY ? -1 : 1
      return [t.xMm + c*x - s*y, t.yMm - s*x - c*y]
    }
    const image = (x: number, y: number) => local((x-crop.x*iw)/sw*dw-dw/2, (y-crop.y*ih)/sh*dh-dh/2)
    const map = (x: number, y: number) => image((x-vb[0])*sx+ox, (y-vb[1])*sy+oy)
    const p = map(0,0), x = map(1,0), y = map(0,1)
    const matrix = { a:x[0]-p[0], b:x[1]-p[1], c:y[0]-p[0], d:y[1]-p[1], e:p[0], f:p[1],
      scale: Math.min(Math.hypot(x[0]-p[0],x[1]-p[1]), Math.hypot(y[0]-p[0],y[1]-p[1])) }
    let clip = polygonClipping.intersection(rect(-t.widthMm/2,-t.heightMm/2,t.widthMm,t.heightMm,local),
      rect(crop.x*iw,crop.y*ih,sw,sh,image), rect(0,0,iw,ih,image))
    clip = polygonClipping.intersection(clip, rect(bounds.minX,bounds.minY,bounds.width,bounds.height,(x,y)=>[x,y]))
    if (placement.panelId) {
      const panel = panels.find(p => p.id === placement.panelId)
      if (!panel) continue
      const contour = panel.contour ?? [{x:panel.x,y:panel.y},{x:panel.x+panel.w,y:panel.y},{x:panel.x+panel.w,y:panel.y+panel.h},{x:panel.x,y:panel.y+panel.h}]
      clip = polygonClipping.intersection(clip, [[contour.map(p => [p.x,p.y] as Pair)]])
    }
    const art = recognizeSvgLattice(source, { x:bounds.minX,y:bounds.minY,w:bounds.width,h:bounds.height }, undefined, matrix)
    const shapes = [...art.fills, ...art.strokes.map(s => svgLatticeStroke(s.points, Math.max(0.01,s.width),s.closed))]
    for (const shape of shapes) {
      const clipped = polygonClipping.intersection(shape, clip)
      if (clipped.length) fills.push(clipped)
    }
  }
  if (!fills.length) throw new Error('当前 SVG 图层在板面内没有可制造线条，请调整位置或裁剪')
  return { fills, strokes: [] }
}
