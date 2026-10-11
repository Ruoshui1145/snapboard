/** Parametric 3D layout: faces remain editable 2D surfaces in millimetres. */
import type { SplitConfig } from '../types/geometry'

export type SpatialTemplate = 'flat' | 'L' | 'U' | 'prism' | 'cylinder'
export type SpatialManufacturingMode = 'auto' | 'monolithic' | 'per-face' | 'bed-split'
export type Vec3 = [number, number, number]

export interface SpatialLayoutConfig {
  enabled: boolean
  template: Exclude<SpatialTemplate, 'flat'>
  width: number
  depth: number
  height: number
  /** Three keeps the original triangular width/depth; higher counts form regular polygons. */
  polygonSides: number
  /** Included angle between the two L faces. */
  angleDegrees: number
  manufacturingMode: SpatialManufacturingMode
  /** Only used when the printer preset is custom. */
  customPrintHeight: number
  /** Extra clearance on every bed side and below the printer's Z ceiling. */
  printSafetyMarginMm: number
  /** Treatment for one-piece L/U/prism bends. */
  bendStyle: 'round' | 'chamfer'
  /** Inner fillet radius or centerline chamfer setback, in millimetres. */
  bendSizeMm: number
  /** L arms: bend centerline to the closest slot/candidate round-hole column. */
  cornerHoleInsetMm: number
  /** One-piece printed corner brackets, fixed at the selected design angle. */
  printedAngleConnector: boolean
  /** Radial clearance for the M3 nut pocket, adjusted after a print-fit coupon. */
  connectorClearanceMm: number
  /** Manual candidate-hole states keyed by the unfolded sheet's millimetre coordinates. */
  holeOverrides: Record<string, boolean>
  /** 单孔类型覆盖，同样按折叠前坐标保存；缺省仍使用原阵列。 */
  holeTypeOverrides?: Record<string, 'slot' | 'round' | 'closed'>
}

export const DEFAULT_SPATIAL_LAYOUT: SpatialLayoutConfig = {
  enabled: false, template: 'L', width: 110, depth: 70, height: 160, polygonSides: 3,
  angleDegrees: 90, manufacturingMode: 'monolithic', customPrintHeight: 256,
  printSafetyMarginMm: 5, bendStyle: 'round', bendSizeMm: 8, cornerHoleInsetMm: 20,
  printedAngleConnector: true,
  connectorClearanceMm: 0.25,
  holeOverrides: {},
}

/** Keep height cuts on the unfolded hole lattice rather than through a hole row. */
export function spatialHeightLimit(maxHeight: number, cfg: Pick<SplitConfig, 'my'>): number {
  return Math.floor(maxHeight / cfg.my) * cfg.my || maxHeight
}

/** Keep the bend inset and trim each free end to the flat panel's connection-hole margin. */
export function alignSpatialConnectionEdges(config: SpatialLayoutConfig,
  cfg: Pick<SplitConfig, 'mx' | 'slotStaggerX' | 'jointOffsetX'>): SpatialLayoutConfig {
  if (!config.enabled || config.template !== 'L') return config
  const pitch = cfg.mx, edgeInset = cfg.jointOffsetX
  if (![pitch, edgeInset, cfg.slotStaggerX].every(Number.isFinite) || pitch <= 0 || edgeInset <= 0) {
    throw new Error('孔阵节距和拼接边距必须为正数')
  }
  const stagger = ((cfg.slotStaggerX % pitch) + pitch) % pitch
  const minimum = config.cornerHoleInsetMm + edgeInset
  const trim = (length: number, offset: number) => Math.round(Math.max(minimum,
    ...[0, offset].map(phase => minimum + phase +
      Math.floor((length - minimum - phase + 1e-6) / pitch) * pitch)) * 1000) / 1000
  const width = trim(config.width, pitch - stagger), depth = trim(config.depth, stagger)
  if (width === config.width && depth === config.depth) return config
  // The bend-anchored mother grid moves by the main arm's trimmed length on both faces.
  const dx = Math.round((width - config.width) * 1000)
  const holeOverrides = dx ? Object.fromEntries(Object.entries(config.holeOverrides).map(([key, open]) => {
    const coordinate = /^(-?\d+),(-?\d+)$/.exec(key)
    return [coordinate ? `${Number(coordinate[1]) + dx},${coordinate[2]}` : key, open]
  })) : config.holeOverrides
  const holeTypeOverrides = dx && config.holeTypeOverrides ? Object.fromEntries(Object.entries(config.holeTypeOverrides).map(([key, type]) => {
    const coordinate = /^(-?\d+),(-?\d+)$/.exec(key)
    return [coordinate ? `${Number(coordinate[1]) + dx},${coordinate[2]}` : key, type]
  })) : config.holeTypeOverrides
  return { ...config, width, depth, holeOverrides, ...(holeTypeOverrides ? { holeTypeOverrides } : {}) }
}

export interface SpatialFace {
  id: string
  width: number
  height: number
  origin: Vec3
  u: Vec3
  normal: Vec3
  /** Global hole-grid coordinate at this face's left edge. */
  phaseU: number
  /** A quarter-cylinder's unfolded arc coordinates; absent on planar faces. */
  curve?: { radius: number; center: [number, number]; startAngle: number }
}

export interface SpatialJunction {
  from: string
  to: string
  angleDegrees: number
}

export interface SpatialLayout {
  template: SpatialTemplate
  thickness: number
  faces: SpatialFace[]
  junctions: SpatialJunction[]
}

export interface SpatialLayoutInput {
  template: SpatialTemplate
  width: number
  depth?: number
  height: number
  thickness: number
  angleDegrees?: number
  polygonSides?: number
  bendSizeMm?: number
  bendStyle?: 'round' | 'chamfer'
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export function faceAxes(face: SpatialFace, x: number): { u: Vec3; normal: Vec3 } {
  if (!face.curve) return face
  const angle = face.curve.startAngle - x / face.curve.radius
  return { u: [Math.sin(angle), 0, -Math.cos(angle)], normal: [Math.cos(angle), 0, Math.sin(angle)] }
}

/** Face coordinates: x along its bottom edge, y upward, z toward its visible side. */
export function faceToWorld(face: SpatialFace, x: number, y: number, z = 0): Vec3 {
  if (face.curve) {
    const { normal } = faceAxes(face, x)
    return [face.curve.center[0] + normal[0] * (face.curve.radius + z), face.origin[1] + y,
      face.curve.center[1] + normal[2] * (face.curve.radius + z)]
  }
  return [
    face.origin[0] + face.u[0] * x + face.normal[0] * z,
    face.origin[1] + y,
    face.origin[2] + face.u[2] * x + face.normal[2] * z,
  ]
}

export function worldToFace(face: SpatialFace, point: Vec3): Vec3 {
  if (face.curve) {
    const dx = point[0] - face.curve.center[0], dz = point[2] - face.curve.center[1]
    const turn = ((face.curve.startAngle - Math.atan2(dz, dx)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    return [turn * face.curve.radius, point[1] - face.origin[1], Math.hypot(dx, dz) - face.curve.radius]
  }
  const delta: Vec3 = [point[0] - face.origin[0], point[1] - face.origin[1], point[2] - face.origin[2]]
  return [dot(delta, face.u), delta[1], dot(delta, face.normal)]
}

/** Face adjacency is geometric; the manufacturing mode later decides whether to fuse or split it. */
export function createSpatialLayout(input: SpatialLayoutInput): SpatialLayout {
  let { template } = input
  const { width, height, thickness } = input
  const depth = input.depth ?? width
  const sides = input.polygonSides ?? 3
  if (template === 'prism' && (!Number.isSafeInteger(sides) || sides < 3)) throw new Error('多边形边数须为不小于 3 的整数')
  // Once each side is smaller than a printable straight wall, use the continuous circular limit.
  if (template === 'prism' && sides > 3 && width * Math.sin(Math.PI / sides) <= thickness * 2 +
    2 * ((input.bendSizeMm ?? 8) + thickness / 2) * (input.bendStyle === 'chamfer' ? 1 : Math.tan(Math.PI / sides))) template = 'cylinder'
  const angleDegrees = input.angleDegrees ?? 90
  if (![width, depth, height, thickness].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('立体版面尺寸和板厚必须为正数')
  }
  if (thickness >= (template === 'cylinder' ? width : Math.min(width, depth)) / 2) throw new Error('板厚必须小于最窄平面尺寸的一半')
  if (template === 'L' && (!Number.isFinite(angleDegrees) || angleDegrees < 45 || angleDegrees > 150)) {
    throw new Error('L 型夹角须在 45° 至 150° 之间')
  }
  if (template === 'flat') return {
    template, thickness,
    faces: [{ id: 'face-1', width, height, origin: [0, 0, 0], u: [1, 0, 0], normal: [0, 0, 1], phaseU: 0 }],
    junctions: [],
  }

  if (template === 'cylinder') {
    const radius = width / 2, span = Math.PI * radius / 2
    const faces = Array.from({ length: 4 }, (_, index): SpatialFace => {
      const angle = Math.PI / 2 - index * Math.PI / 2
      return { id: `face-${index + 1}`, width: span, height,
        origin: [radius + radius * Math.cos(angle), 0, -radius + radius * Math.sin(angle)],
        u: [Math.sin(angle), 0, -Math.cos(angle)], normal: [Math.cos(angle), 0, Math.sin(angle)],
        phaseU: index * span, curve: { radius, center: [radius, -radius], startAngle: angle } }
    })
    return { template, thickness, faces, junctions: [] }
  }

  const turn = (180 - angleDegrees) * Math.PI / 180
  const outline: Array<[number, number]> = template === 'L'
    ? [[0, 0], [width, 0], [width + depth * Math.cos(turn), -depth * Math.sin(turn)]]
    : template === 'U'
      ? [[0, -depth], [0, 0], [width, 0], [width, -depth]]
      : template === 'prism'
        ? sides === 3 ? [[0, 0], [width, 0], [width / 2, -depth], [0, 0]] : (() => {
          const vertices = Array.from({ length: sides }, (_, index) => {
            const angle = -Math.PI / 2 - Math.PI / sides + index * 2 * Math.PI / sides
            return [Math.cos(angle), Math.sin(angle)] as [number, number]
          })
          const minX = Math.min(...vertices.map(point => point[0])), maxX = Math.max(...vertices.map(point => point[0]))
          const minY = Math.min(...vertices.map(point => point[1]))
          const scale = width / (maxX - minX)
          const outline = vertices.map(([x, y]) => [(x - minX) * scale, -(y - minY) * scale] as [number, number])
          return [...outline, outline[0]]
        })()
        : []
  if (!outline.length) throw new Error(`未知立体版面：${template}`)

  let phaseU = 0
  const faces = outline.slice(1).map(([x, z], index): SpatialFace => {
    const [startX, startZ] = outline[index]
    const dx = x - startX, dz = z - startZ
    const length = Math.hypot(dx, dz)
    const face: SpatialFace = {
      id: `face-${index + 1}`, width: length, height,
      origin: [startX, 0, startZ],
      u: [dx / length, 0, dz / length],
      normal: [-dz / length, 0, dx / length],
      phaseU,
    }
    phaseU += length
    return face
  })
  const junctions = faces.slice(1).map((face, index) => ({
    from: faces[index].id,
    to: face.id,
    angleDegrees: 180 - Math.acos(Math.max(-1, Math.min(1, dot(faces[index].u, face.u)))) * 180 / Math.PI,
  }))
  if (template === 'prism') junctions.push({
    from: faces[faces.length - 1].id,
    to: faces[0].id,
    angleDegrees: 180 - Math.acos(Math.max(-1, Math.min(1, dot(faces[faces.length - 1].u, faces[0].u)))) * 180 / Math.PI,
  })
  return { template, thickness, faces, junctions }
}
