import ClipperLib from 'clipper-lib'
import type { SpatialLayout, SpatialLayoutConfig } from './spatialLayout'

const SCALE = 1000
type Vec2 = [number, number]
const minus = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const plus = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
const times = (a: Vec2, scalar: number): Vec2 => [a[0] * scalar, a[1] * scalar]

/** A single constant-thickness sweep; the prism closes the last bend back onto the first face. */
export function createBentFootprint(layout: SpatialLayout, config: SpatialLayoutConfig): {
  polygons: Vec2[][]; trims: number[]
} {
  if (layout.template === 'flat') throw new Error('平面版面没有折弯转角')
  if (layout.template === 'cylinder') {
    const { radius, center } = layout.faces[0].curve!
    const segments = Math.max(64, Math.ceil(Math.PI / Math.acos(1 - 0.04 / (radius + layout.thickness / 2))))
    return { polygons: [radius + layout.thickness / 2, radius - layout.thickness / 2].map(r =>
      Array.from({ length: segments }, (_, index): Vec2 => {
        const angle = index * Math.PI * 2 / segments
        return [center[0] + r * Math.cos(angle), -center[1] + r * Math.sin(angle)]
      })), trims: [] }
  }
  const closed = layout.template === 'prism'
  const faces = layout.faces
  const vertices: Vec2[] = [
    [faces[0].origin[0], faces[0].origin[2]],
    ...faces.map(face => [face.origin[0] + face.u[0] * face.width,
      face.origin[2] + face.u[2] * face.width] as Vec2),
  ]
  if (closed) vertices.pop()
  const bendRadius = config.bendSizeMm + layout.thickness / 2
  const turns = layout.junctions.map(junction => (180 - junction.angleDegrees) * Math.PI / 180)
  const trims = turns.map(turn => config.bendStyle === 'round'
    ? bendRadius * Math.tan(turn / 2) : bendRadius)
  for (let index = 0; index < faces.length; index++) {
    const used = (trims[(index + faces.length - 1) % faces.length] ?? 0) + (trims[index] ?? 0)
    if (used + layout.thickness * 2 >= faces[index].width) {
      throw new Error(`转角尺寸过大：${faces[index].id} 需要保留至少 ${Math.round(used + layout.thickness * 2)} mm，请减小圆角/倒角或加长面片`)
    }
  }
  const centerline: Vec2[] = closed ? [] : [vertices[0]]
  for (let index = closed ? 0 : 1; index < vertices.length - (closed ? 0 : 1); index++) {
    const incomingIndex = (index + faces.length - 1) % faces.length
    const before = faces[incomingIndex].u
    const after = faces[index].u
    const incoming: Vec2 = [before[0], before[2]]
    const outgoing: Vec2 = [after[0], after[2]]
    const joint = vertices[index]
    const start = minus(joint, times(incoming, trims[incomingIndex]))
    const end = plus(joint, times(outgoing, trims[incomingIndex]))
    if (config.bendStyle === 'chamfer') { centerline.push(start, end); continue }
    const center = plus(start, times([incoming[1], -incoming[0]], bendRadius))
    const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
    const turn = turns[incomingIndex]
    const stepAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.04 / bendRadius)))
    const segments = Math.max(8, Math.min(128, Math.ceil(turn / Math.max(stepAngle, 0.01))))
    for (let step = 0; step <= segments; step++) {
      const angle = startAngle - turn * step / segments
      centerline.push(plus(center, times([Math.cos(angle), Math.sin(angle)], bendRadius)))
    }
  }
  if (!closed) centerline.push(vertices[vertices.length - 1])
  const points = centerline.map(([x, z]) => ({ X: Math.round(x * SCALE), Y: Math.round(-z * SCALE) }))
  const offset = new ClipperLib.ClipperOffset(2, 0.03 * SCALE)
  offset.AddPath(points, ClipperLib.JoinType.jtRound,
    closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenButt)
  const result: ClipperLib.Paths = []
  offset.Execute(result, layout.thickness * SCALE / 2)
  if (result.length !== (closed ? 2 : 1) || result.some(path => path.length < 3)) throw new Error('无法生成闭合的一体化转角截面')
  result.sort((a, b) => Math.abs(ClipperLib.Clipper.Area(b)) - Math.abs(ClipperLib.Clipper.Area(a)))
  return { polygons: result.map(path => path.map(point => [point.X / SCALE, point.Y / SCALE])), trims }
}
