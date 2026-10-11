import type { Point2D, ShapePresetParams } from './types'
import { interpolate, sampleCubicBezier, samplesFromDetail } from './geometry'

interface CubicSegment {
  end: Point2D
  control1: Point2D
  control2: Point2D
}

function sampleClosedCubicPath(
  start: Point2D,
  segments: readonly CubicSegment[],
  samplesPerSegment: number,
  smoothing: number,
): Point2D[] {
  const points: Point2D[] = [{ ...start }]
  let current = start
  const handleStrength = 0.55 + smoothing * 0.45
  for (const segment of segments) {
    const control1 = interpolate(current, segment.control1, handleStrength)
    const control2 = interpolate(segment.end, segment.control2, handleStrength)
    const sampled = sampleCubicBezier(current, control1, control2, segment.end, samplesPerSegment)
    points.push(...sampled)
    current = segment.end
  }
  return points
}

/** An original generic cloud silhouette, intentionally unrelated to any game mark. */
export function createCloudOutline(params: ShapePresetParams): Point2D[] {
  const start = { x: -0.5, y: 0.1 }
  const segments: CubicSegment[] = [
    { end: { x: -0.32, y: -0.14 }, control1: { x: -0.51, y: -0.04 }, control2: { x: -0.43, y: -0.16 } },
    { end: { x: -0.14, y: -0.25 }, control1: { x: -0.28, y: -0.29 }, control2: { x: -0.19, y: -0.31 } },
    { end: { x: 0.12, y: -0.34 }, control1: { x: -0.03, y: -0.52 }, control2: { x: 0.11, y: -0.51 } },
    { end: { x: 0.3, y: -0.21 }, control1: { x: 0.21, y: -0.39 }, control2: { x: 0.29, y: -0.34 } },
    { end: { x: 0.48, y: -0.02 }, control1: { x: 0.44, y: -0.23 }, control2: { x: 0.5, y: -0.13 } },
    { end: { x: 0.38, y: 0.18 }, control1: { x: 0.5, y: 0.08 }, control2: { x: 0.46, y: 0.17 } },
    { end: { x: 0.17, y: 0.24 }, control1: { x: 0.35, y: 0.28 }, control2: { x: 0.25, y: 0.3 } },
    { end: { x: -0.04, y: 0.28 }, control1: { x: 0.1, y: 0.4 }, control2: { x: -0.02, y: 0.39 } },
    { end: { x: -0.25, y: 0.24 }, control1: { x: -0.08, y: 0.37 }, control2: { x: -0.21, y: 0.36 } },
    { end: { x: -0.45, y: 0.2 }, control1: { x: -0.32, y: 0.32 }, control2: { x: -0.44, y: 0.29 } },
    { end: start, control1: { x: -0.52, y: 0.2 }, control2: { x: -0.55, y: 0.14 } },
  ]
  return sampleClosedCubicPath(start, segments, samplesFromDetail(params.detail, 3, 7), params.smoothing)
}

export function createArchOutline(params: ShapePresetParams): Point2D[] {
  const arcSegments = samplesFromDetail(params.detail, 10, 32)
  const shoulderY = 0.03 + (1 - params.smoothing) * 0.08
  const points: Point2D[] = [{ x: -0.5, y: 0.5 }, { x: -0.5, y: shoulderY }]
  for (let index = 1; index <= arcSegments; index += 1) {
    const angle = Math.PI + Math.PI * index / arcSegments
    points.push({ x: Math.cos(angle) * 0.5, y: shoulderY + Math.sin(angle) * 0.5 })
  }
  points.push({ x: 0.5, y: 0.5 })
  return points
}

export function createHeartOutline(params: ShapePresetParams): Point2D[] {
  const count = samplesFromDetail(params.detail, 40, 96)
  return Array.from({ length: count }, (_, index) => {
    const angle = Math.PI * 2 * index / count
    const sin = Math.sin(angle)
    return {
      x: 16 * sin * sin * sin,
      y: -(13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle)),
    }
  })
}

export function createStarOutline(params: ShapePresetParams): Point2D[] {
  const innerRadius = 0.4 + params.smoothing * 0.08
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + Math.PI * index / 5
    const radius = index % 2 === 0 ? 0.5 : innerRadius * 0.5
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
}

export function createCrescentOutline(params: ShapePresetParams): Point2D[] {
  const outerSegments = samplesFromDetail(params.detail, 22, 48)
  const innerSegments = samplesFromDetail(params.detail, 8, 18)
  const outerCenter = { x: -0.05, y: 0 }
  const radius = 0.5
  const startAngle = -Math.PI / 3
  const endAngle = -Math.PI * 5 / 3
  const points: Point2D[] = []
  for (let index = 0; index <= outerSegments; index += 1) {
    const angle = startAngle + (endAngle - startAngle) * index / outerSegments
    points.push({ x: outerCenter.x + Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }
  const innerStart = { x: 0.28, y: 0.36 }
  const innerEnd = { x: 0.28, y: -0.36 }
  points.push(innerStart)
  const inset = -0.01 - params.smoothing * 0.05
  points.push(...sampleCubicBezier(
    innerStart,
    { x: inset, y: 0.25 },
    { x: inset, y: -0.25 },
    innerEnd,
    innerSegments,
  ))
  return points
}

export function createWaveOutline(params: ShapePresetParams): Point2D[] {
  const samples = samplesFromDetail(params.detail, 14, 40)
  const amplitude = 0.065 + params.smoothing * 0.035
  const top: Point2D[] = []
  const bottom: Point2D[] = []
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples
    const x = t - 0.5
    const wave = Math.sin(t * Math.PI * 3) * amplitude
    top.push({ x, y: -0.3 + wave })
    bottom.push({ x, y: 0.3 + wave })
  }
  return [...top, ...bottom.reverse()]
}

export function createHouseOutline(_params: ShapePresetParams): Point2D[] {
  return [
    { x: -0.5, y: 0.5 },
    { x: -0.5, y: -0.04 },
    { x: 0, y: -0.5 },
    { x: 0.5, y: -0.04 },
    { x: 0.5, y: 0.5 },
  ]
}

function horizontalCapsule(width: number, height: number, arcSegments: number): Point2D[] {
  const radius = height / 2
  const leftCenter = -width / 2 + radius
  const rightCenter = width / 2 - radius
  const points: Point2D[] = [
    { x: leftCenter, y: -radius },
    { x: rightCenter, y: -radius },
  ]
  for (let index = 1; index <= arcSegments; index += 1) {
    const angle = -Math.PI / 2 + Math.PI * index / arcSegments
    points.push({ x: rightCenter + Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }
  points.push({ x: leftCenter, y: radius })
  for (let index = 1; index < arcSegments; index += 1) {
    const angle = Math.PI / 2 + Math.PI * index / arcSegments
    points.push({ x: leftCenter + Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }
  return points
}

export function createCapsuleOutline(params: ShapePresetParams): Point2D[] {
  const arcSegments = samplesFromDetail(params.detail, 8, 24)
  if (params.width >= params.height) return horizontalCapsule(params.width, params.height, arcSegments)
  return horizontalCapsule(params.height, params.width, arcSegments).map(point => ({ x: point.y, y: point.x }))
}

/** Sampling error at most 0.05 mm, with cardinal points retained for exact bounds. */
function roundSegments(radius: number): number {
  return Math.max(32, Math.ceil(Math.PI / Math.acos(1 - Math.min(.05, radius) / radius) / 4) * 4)
}
export function createRectangleOutline({width:w,height:h}: ShapePresetParams): Point2D[] {
  return [{x:-w/2,y:-h/2},{x:w/2,y:-h/2},{x:w/2,y:h/2},{x:-w/2,y:h/2}]
}
export function createEllipseOutline({width:w,height:h}: ShapePresetParams): Point2D[] {
  const n=roundSegments(Math.max(w,h)/2)
  return Array.from({length:n},(_,i)=>({x:w/2*Math.cos(i*2*Math.PI/n),y:h/2*Math.sin(i*2*Math.PI/n)}))
}
export function createRoundedRectangleOutline(p: ShapePresetParams): Point2D[] {
  const w=p.width,h=p.height,r=Math.min(p.cornerRadius ?? 12,w/2,h/2)
  if(r===0)return createRectangleOutline(p)
  const n=roundSegments(r)/4, points:Point2D[]=[]
  for(const [cx,cy,start] of [[w/2-r,-h/2+r,-Math.PI/2],[w/2-r,h/2-r,0],[-w/2+r,h/2-r,Math.PI/2],[-w/2+r,-h/2+r,Math.PI]]) {
    for(let i=0;i<=n;i++){const angle=start+i*Math.PI/2/n;points.push({x:cx+r*Math.cos(angle),y:cy+r*Math.sin(angle)})}
  }
  return points
}
