import type { Point2D, PrintBedKeepout, SplitConfig } from '../types/geometry'

export interface PrintBedBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface RectBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const EPS = 1e-6

export function getPrintBedBounds(cfg: SplitConfig): PrintBedBounds {
  const minX = Math.max(0, cfg.bedMarginLeft)
  const minY = Math.max(0, cfg.bedMarginBottom)
  const maxX = Math.max(minX, cfg.bedW - Math.max(0, cfg.bedMarginRight))
  const maxY = Math.max(minY, cfg.bedH - Math.max(0, cfg.bedMarginTop))
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

export function getEnabledKeepouts(cfg: SplitConfig): PrintBedKeepout[] {
  return cfg.bedKeepouts.filter(zone => zone.enabled && zone.w > 0 && zone.h > 0)
}

export function rotatePlanarPoints(points: Point2D[], angleDegrees: number): Point2D[] {
  const angle = angleDegrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return points.map(point => ({
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  }))
}

export function planarBounds(points: Point2D[]): RectBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function pointInRect(point: Point2D, rect: RectBounds): boolean {
  return point.x >= rect.minX - EPS && point.x <= rect.maxX + EPS &&
    point.y >= rect.minY - EPS && point.y <= rect.maxY + EPS
}

function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (((a.y > point.y) !== (b.y > point.y)) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || EPS) + a.x) inside = !inside
  }
  return inside
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSegment(a: Point2D, b: Point2D, point: Point2D): boolean {
  return Math.abs(orientation(a, b, point)) <= EPS &&
    point.x >= Math.min(a.x, b.x) - EPS && point.x <= Math.max(a.x, b.x) + EPS &&
    point.y >= Math.min(a.y, b.y) - EPS && point.y <= Math.max(a.y, b.y) + EPS
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
      ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return true
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
}

/** 精确检测旋转后的凸包是否进入矩形禁放区；边界接触也视为占用。 */
export function polygonIntersectsRect(polygon: Point2D[], rect: RectBounds): boolean {
  if (!polygon.length) return false
  const bounds = planarBounds(polygon)
  if (bounds.maxX < rect.minX - EPS || bounds.minX > rect.maxX + EPS ||
      bounds.maxY < rect.minY - EPS || bounds.minY > rect.maxY + EPS) return false

  if (polygon.some(point => pointInRect(point, rect))) return true
  const corners = [
    { x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY },
  ]
  if (corners.some(point => pointInPolygon(point, polygon))) return true
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    for (let j = 0; j < corners.length; j++) {
      if (segmentsIntersect(a, b, corners[j], corners[(j + 1) % corners.length])) return true
    }
  }
  return false
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite).map(value => Math.round(value * 1e6) / 1e6))].sort((a, b) => a - b)
}

/**
 * 判断一个已旋转的平面轮廓能否平移进有效打印区，并避开全部禁放矩形。
 * 候选位置包含打印区四角和每个禁放区的四条约束边，足以覆盖矩形障碍下的极值位置。
 */
export function findFootprintPlacement(points: Point2D[], cfg: SplitConfig): { x: number; y: number } | null {
  if (points.length < 3) return null
  const area = getPrintBedBounds(cfg)
  const bounds = planarBounds(points)
  if (bounds.maxX - bounds.minX > area.width + EPS || bounds.maxY - bounds.minY > area.height + EPS) return null

  const minTX = area.minX - bounds.minX
  const maxTX = area.maxX - bounds.maxX
  const minTY = area.minY - bounds.minY
  const maxTY = area.maxY - bounds.maxY
  const keepouts = getEnabledKeepouts(cfg)
  const xs = [minTX, maxTX]
  const ys = [minTY, maxTY]
  for (const zone of keepouts) {
    xs.push(zone.x - bounds.maxX - 0.01, zone.x + zone.w - bounds.minX + 0.01)
    ys.push(zone.y - bounds.maxY - 0.01, zone.y + zone.h - bounds.minY + 0.01)
  }

  for (const y of uniqueSorted(ys)) {
    if (y < minTY - EPS || y > maxTY + EPS) continue
    for (const x of uniqueSorted(xs)) {
      if (x < minTX - EPS || x > maxTX + EPS) continue
      const translated = points.map(point => ({ x: point.x + x, y: point.y + y }))
      const blocked = keepouts.some(zone => polygonIntersectsRect(translated, {
        minX: zone.x, minY: zone.y, maxX: zone.x + zone.w, maxY: zone.y + zone.h,
      }))
      if (!blocked) return { x, y }
    }
  }
  return null
}

export function printableBedDescription(cfg: SplitConfig): string {
  const area = getPrintBedBounds(cfg)
  const keepoutCount = getEnabledKeepouts(cfg).length
  return `${numberText(area.width)} × ${numberText(area.height)} mm 有效边界${keepoutCount ? `，${keepoutCount} 个禁放区` : ''}`
}

function numberText(value: number): string {
  return Number(value.toFixed(2)).toString()
}
