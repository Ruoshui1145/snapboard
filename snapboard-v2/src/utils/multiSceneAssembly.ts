/**
 * Multi-scene assembly geometry kernel.
 *
 * All distances are millimetres. The module is intentionally independent of
 * Three.js and application state: every exported solver is a pure function.
 */

export type Vec2 = readonly [number, number]
export type Vec3 = readonly [number, number, number]

export interface FiniteAxis {
  start: Vec3
  end: Vec3
}

export interface AxisProjection {
  /** Closest point on the finite segment. */
  point: Vec3
  /** Clamped fraction from start (0) to end (1). */
  t: number
  /** Unclamped fraction on the infinite line. */
  lineT: number
  /** Distance from the query point to the finite segment. */
  distance: number
  /** Segment length in millimetres. */
  axisLength: number
  /** True when the infinite-line projection lies before start or after end. */
  clamped: boolean
}

export type PlacementFailureReason =
  | 'invalid-geometry'
  | 'incompatible-profile'
  | 'unsupported-insertion-mode'
  | 'out-of-bounds'
  | 'outside-snap-distance'
  | 'occupied'

export type PlacementResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PlacementFailureReason }

export interface DiscreteHoleOccupancy {
  kind: 'discrete-hole'
  hostId: string
  holeIds: readonly string[]
}

export interface AxialIntervalOccupancy {
  kind: 'axial-interval'
  hostId: string
  /** Separate lanes/channels on one host do not collide. */
  channelId?: string
  /** Millimetres from the host axis start. */
  start: number
  /** Millimetres from the host axis start. */
  end: number
}

export interface SurfaceFootprintOccupancy {
  kind: 'surface-footprint'
  hostId: string
  /** Polygon coordinates in the host surface's local millimetre frame. */
  polygon: readonly Vec2[]
}

export type AssemblyOccupancy =
  | DiscreteHoleOccupancy
  | AxialIntervalOccupancy
  | SurfaceFootprintOccupancy

export interface OccupancyConflict {
  proposedIndex: number
  existingIndex: number
  proposed: AssemblyOccupancy
  existing: AssemblyOccupancy
}

export interface RailHost {
  id: string
  axis: FiniteAxis
  /** e.g. `EN60715:TH35-7.5`. Omit only for an intentionally generic host. */
  profile?: string
  channelId?: string
  startClearance?: number
  endClearance?: number
}

export interface RailClipRequest {
  host: RailHost
  desiredPoint: Vec3
  /** Width occupied along the rail axis. */
  axialSpan: number
  compatibleProfiles?: readonly string[]
  maxSnapDistance?: number
  existingOccupancies?: readonly AssemblyOccupancy[]
}

export interface RailClipPlacement {
  hostId: string
  point: Vec3
  /** Unit vector from rail start to rail end. */
  axisDirection: Vec3
  /** Centre position measured from rail start. */
  axialPosition: number
  projectionDistance: number
  occupancy: AxialIntervalOccupancy
}

export type TSlotInsertionMode = 'end-feed' | 'swivel-in'
export type TSlotOpenEnds = 'none' | 'start' | 'end' | 'both'

export interface TSlotHost extends RailHost {
  /** Clear groove opening and inner-cavity widths. */
  openingWidth: number
  cavityWidth: number
  openEnds: TSlotOpenEnds
  allowsSwivelIn: boolean
}

export interface TSlotConnector {
  compatibleProfiles?: readonly string[]
  /** Connector neck remaining in the visible groove opening. */
  neckWidth: number
  /** Captive head width after insertion/rotation. */
  headWidth: number
  /** Minimum width presented while rotating into the slot. */
  swivelInsertionWidth?: number
  supportedModes: readonly TSlotInsertionMode[]
  axialSpan: number
}

export interface TSlotPlacementRequest {
  host: TSlotHost
  connector: TSlotConnector
  mode: TSlotInsertionMode
  desiredPoint: Vec3
  maxSnapDistance?: number
  preferredEntry?: 'start' | 'end'
  existingOccupancies?: readonly AssemblyOccupancy[]
}

export interface TSlotPlacement extends RailClipPlacement {
  mode: TSlotInsertionMode
  /** Required access end for end-feed; absent for swivel-in. */
  entry?: 'start' | 'end'
}

export interface SurfaceFrame {
  origin: Vec3
  /** Approximate in-plane axes; the solver orthonormalises them. */
  uAxis: Vec3
  vAxis: Vec3
}

export interface SurfaceHost {
  id: string
  frame: SurfaceFrame
  /** Simple polygon in local (u,v) millimetres. May be concave. */
  boundary: readonly Vec2[]
}

export interface SurfacePadRequest {
  host: SurfaceHost
  desiredPoint: Vec3
  /** Pad polygon around its local origin, before rotation/translation. */
  footprint: readonly Vec2[]
  rotation?: number
  maxPlaneDistance?: number
  existingOccupancies?: readonly AssemblyOccupancy[]
}

export interface SurfacePadPlacement {
  hostId: string
  point: Vec3
  localPosition: Vec2
  rotation: number
  planeDistance: number
  occupancy: SurfaceFootprintOccupancy
}

const EPSILON = 1e-8

const finite = (...values: number[]): boolean => values.every(Number.isFinite)

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const subtract3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale3 = (value: Vec3, scale: number): Vec3 => [value[0] * scale, value[1] * scale, value[2] * scale]
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length3 = (value: Vec3): number => Math.hypot(value[0], value[1], value[2])

const normalize3 = (value: Vec3): Vec3 | null => {
  const length = length3(value)
  return length > EPSILON && Number.isFinite(length) ? scale3(value, 1 / length) : null
}

const profilesCompatible = (hostProfile: string | undefined, compatible: readonly string[] | undefined): boolean =>
  !hostProfile || !compatible?.length || compatible.includes(hostProfile)

const interval = (value: AxialIntervalOccupancy): readonly [number, number] =>
  value.start <= value.end ? [value.start, value.end] : [value.end, value.start]

/** Project a world point onto a finite 3D axis segment. */
export function projectPointToFiniteAxis(point: Vec3, axis: FiniteAxis): AxisProjection | null {
  if (!finite(...point, ...axis.start, ...axis.end)) return null
  const delta = subtract3(axis.end, axis.start)
  const lengthSquared = dot3(delta, delta)
  if (lengthSquared <= EPSILON) return null
  const lineT = dot3(subtract3(point, axis.start), delta) / lengthSquared
  const t = Math.max(0, Math.min(1, lineT))
  const projected = add3(axis.start, scale3(delta, t))
  return {
    point: projected,
    t,
    lineT,
    distance: length3(subtract3(point, projected)),
    axisLength: Math.sqrt(lengthSquared),
    clamped: lineT < 0 || lineT > 1,
  }
}

const createAxisPlacement = (
  host: RailHost,
  desiredPoint: Vec3,
  axialSpan: number,
  maxSnapDistance: number | undefined,
  existingOccupancies: readonly AssemblyOccupancy[] | undefined,
): PlacementResult<RailClipPlacement> => {
  if (!Number.isFinite(axialSpan) || axialSpan <= 0) return { ok: false, reason: 'invalid-geometry' }
  const projection = projectPointToFiniteAxis(desiredPoint, host.axis)
  if (!projection) return { ok: false, reason: 'invalid-geometry' }
  if (maxSnapDistance !== undefined && (!Number.isFinite(maxSnapDistance) || projection.distance > maxSnapDistance)) {
    return { ok: false, reason: 'outside-snap-distance' }
  }
  const startClearance = Math.max(0, host.startClearance ?? 0)
  const endClearance = Math.max(0, host.endClearance ?? 0)
  const centre = projection.lineT * projection.axisLength
  const halfSpan = axialSpan / 2
  if (
    centre - halfSpan < startClearance - EPSILON ||
    centre + halfSpan > projection.axisLength - endClearance + EPSILON
  ) {
    return { ok: false, reason: 'out-of-bounds' }
  }
  const occupancy: AxialIntervalOccupancy = {
    kind: 'axial-interval',
    hostId: host.id,
    channelId: host.channelId,
    start: centre - halfSpan,
    end: centre + halfSpan,
  }
  if (findOccupancyConflicts([occupancy], existingOccupancies ?? []).length) {
    return { ok: false, reason: 'occupied' }
  }
  const direction = normalize3(subtract3(host.axis.end, host.axis.start))
  if (!direction) return { ok: false, reason: 'invalid-geometry' }
  return {
    ok: true,
    value: {
      hostId: host.id,
      point: add3(host.axis.start, scale3(direction, centre)),
      axisDirection: direction,
      axialPosition: centre,
      projectionDistance: projection.distance,
      occupancy,
    },
  }
}

/** Place a clip continuously along a finite rail, including interval occupancy checks. */
export function solveRailClipPlacement(request: RailClipRequest): PlacementResult<RailClipPlacement> {
  if (!profilesCompatible(request.host.profile, request.compatibleProfiles)) {
    return { ok: false, reason: 'incompatible-profile' }
  }
  return createAxisPlacement(
    request.host,
    request.desiredPoint,
    request.axialSpan,
    request.maxSnapDistance,
    request.existingOccupancies,
  )
}

/** UI-facing name; kept separate from the implementation name for clear intent. */
export const fitRailClipPlacement = solveRailClipPlacement

const endAvailable = (openEnds: TSlotOpenEnds, entry: 'start' | 'end'): boolean =>
  openEnds === 'both' || openEnds === entry

/**
 * Place a T-slot connector, validating both the profile dimensions and the
 * requested insertion path (end-feed or in-place swivel-in).
 */
export function solveTSlotPlacement(request: TSlotPlacementRequest): PlacementResult<TSlotPlacement> {
  const { host, connector, mode } = request
  if (!connector.supportedModes.includes(mode)) return { ok: false, reason: 'unsupported-insertion-mode' }
  if (
    !finite(host.openingWidth, host.cavityWidth, connector.neckWidth, connector.headWidth) ||
    host.openingWidth <= 0 || host.cavityWidth <= 0 || connector.neckWidth <= 0 || connector.headWidth <= 0
  ) {
    return { ok: false, reason: 'invalid-geometry' }
  }
  if (
    !profilesCompatible(host.profile, connector.compatibleProfiles) ||
    connector.neckWidth > host.openingWidth + EPSILON ||
    connector.headWidth > host.cavityWidth + EPSILON
  ) {
    return { ok: false, reason: 'incompatible-profile' }
  }

  let entry: 'start' | 'end' | undefined
  if (mode === 'end-feed') {
    const allowed = (['start', 'end'] as const).filter(candidate => endAvailable(host.openEnds, candidate))
    if (!allowed.length) return { ok: false, reason: 'unsupported-insertion-mode' }
    if (request.preferredEntry && allowed.includes(request.preferredEntry)) {
      entry = request.preferredEntry
    } else if (allowed.length === 1) {
      entry = allowed[0]
    } else {
      const projection = projectPointToFiniteAxis(request.desiredPoint, host.axis)
      if (!projection) return { ok: false, reason: 'invalid-geometry' }
      entry = projection.lineT <= 0.5 ? 'start' : 'end'
    }
  } else {
    const insertionWidth = connector.swivelInsertionWidth ?? connector.neckWidth
    if (!host.allowsSwivelIn) return { ok: false, reason: 'unsupported-insertion-mode' }
    if (!Number.isFinite(insertionWidth) || insertionWidth <= 0 || insertionWidth > host.openingWidth + EPSILON) {
      return { ok: false, reason: 'incompatible-profile' }
    }
  }

  const base = createAxisPlacement(
    host,
    request.desiredPoint,
    connector.axialSpan,
    request.maxSnapDistance,
    request.existingOccupancies,
  )
  if (!base.ok) return base
  return { ok: true, value: { ...base.value, mode, entry } }
}

/** UI-facing name; validates the insertion method before returning a fit. */
export const fitTSlotPlacement = solveTSlotPlacement

const cross2 = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

const pointOnSegment = (point: Vec2, start: Vec2, end: Vec2): boolean =>
  Math.abs(cross2(start, end, point)) <= EPSILON &&
  point[0] >= Math.min(start[0], end[0]) - EPSILON &&
  point[0] <= Math.max(start[0], end[0]) + EPSILON &&
  point[1] >= Math.min(start[1], end[1]) - EPSILON &&
  point[1] <= Math.max(start[1], end[1]) + EPSILON

/** Point-in-simple-polygon test. Boundary can be accepted for placement checks. */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[], includeBoundary = true): boolean {
  if (polygon.length < 3 || !finite(...point)) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]
    const b = polygon[i]
    if (pointOnSegment(point, a, b)) return includeBoundary
    const crossesRay = (a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    if (crossesRay) inside = !inside
  }
  return inside
}

const properSegmentsIntersect = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
  const abC = cross2(a, b, c)
  const abD = cross2(a, b, d)
  const cdA = cross2(c, d, a)
  const cdB = cross2(c, d, b)
  return ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
}

const polygonCentroid = (polygon: readonly Vec2[]): Vec2 => {
  let doubleArea = 0
  let x = 0
  let y = 0
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i]
    const next = polygon[(i + 1) % polygon.length]
    const cross = current[0] * next[1] - next[0] * current[1]
    doubleArea += cross
    x += (current[0] + next[0]) * cross
    y += (current[1] + next[1]) * cross
  }
  if (Math.abs(doubleArea) <= EPSILON) {
    return [
      polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length,
      polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length,
    ]
  }
  return [x / (3 * doubleArea), y / (3 * doubleArea)]
}

/** Positive-area polygon overlap. Merely touching an edge is not a collision. */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  if (a.length < 3 || b.length < 3) return false
  for (let ai = 0; ai < a.length; ai++) {
    const aNext = (ai + 1) % a.length
    for (let bi = 0; bi < b.length; bi++) {
      if (properSegmentsIntersect(a[ai], a[aNext], b[bi], b[(bi + 1) % b.length])) return true
    }
  }
  if (a.some(point => pointInPolygon(point, b, false))) return true
  if (b.some(point => pointInPolygon(point, a, false))) return true
  return pointInPolygon(polygonCentroid(a), b, false) || pointInPolygon(polygonCentroid(b), a, false)
}

/** True when a footprint, including every edge, remains in the host boundary. */
export function footprintInsideBoundary(footprint: readonly Vec2[], boundary: readonly Vec2[]): boolean {
  if (footprint.length < 3 || boundary.length < 3) return false
  if (!footprint.every(point => pointInPolygon(point, boundary, true))) return false
  for (let fi = 0; fi < footprint.length; fi++) {
    const fNext = (fi + 1) % footprint.length
    for (let bi = 0; bi < boundary.length; bi++) {
      if (properSegmentsIntersect(footprint[fi], footprint[fNext], boundary[bi], boundary[(bi + 1) % boundary.length])) {
        return false
      }
    }
  }
  return true
}

const surfaceBasis = (frame: SurfaceFrame): { u: Vec3; v: Vec3 } | null => {
  const u = normalize3(frame.uAxis)
  if (!u) return null
  const vWithoutU = subtract3(frame.vAxis, scale3(u, dot3(frame.vAxis, u)))
  const v = normalize3(vWithoutU)
  return v ? { u, v } : null
}

/** Place a pad on a bounded plane and reject boundary or footprint collisions. */
export function solveSurfacePadPlacement(request: SurfacePadRequest): PlacementResult<SurfacePadPlacement> {
  if (request.host.boundary.length < 3 || request.footprint.length < 3) {
    return { ok: false, reason: 'invalid-geometry' }
  }
  const basis = surfaceBasis(request.host.frame)
  if (!basis || !finite(...request.desiredPoint, ...request.host.frame.origin)) {
    return { ok: false, reason: 'invalid-geometry' }
  }
  const relative = subtract3(request.desiredPoint, request.host.frame.origin)
  const localPosition: Vec2 = [dot3(relative, basis.u), dot3(relative, basis.v)]
  const inPlane = add3(request.host.frame.origin, add3(scale3(basis.u, localPosition[0]), scale3(basis.v, localPosition[1])))
  const planeDistance = length3(subtract3(request.desiredPoint, inPlane))
  if (
    request.maxPlaneDistance !== undefined &&
    (!Number.isFinite(request.maxPlaneDistance) || planeDistance > request.maxPlaneDistance)
  ) {
    return { ok: false, reason: 'outside-snap-distance' }
  }
  const rotation = request.rotation ?? 0
  if (!Number.isFinite(rotation)) return { ok: false, reason: 'invalid-geometry' }
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  const polygon: Vec2[] = request.footprint.map(point => [
    localPosition[0] + point[0] * cosine - point[1] * sine,
    localPosition[1] + point[0] * sine + point[1] * cosine,
  ])
  if (!footprintInsideBoundary(polygon, request.host.boundary)) {
    return { ok: false, reason: 'out-of-bounds' }
  }
  const occupancy: SurfaceFootprintOccupancy = {
    kind: 'surface-footprint',
    hostId: request.host.id,
    polygon,
  }
  if (findOccupancyConflicts([occupancy], request.existingOccupancies ?? []).length) {
    return { ok: false, reason: 'occupied' }
  }
  return {
    ok: true,
    value: {
      hostId: request.host.id,
      point: inPlane,
      localPosition,
      rotation,
      planeDistance,
      occupancy,
    },
  }
}

/** UI-facing name for bounded wall/base placement. */
export const fitSurfacePadPlacement = solveSurfacePadPlacement

/** Pairwise occupancy check shared by hole, rail/T-slot and surface-pad scenes. */
export function occupanciesConflict(a: AssemblyOccupancy, b: AssemblyOccupancy): boolean {
  if (a.kind !== b.kind || a.hostId !== b.hostId) return false
  if (a.kind === 'discrete-hole' && b.kind === 'discrete-hole') {
    const occupied = new Set(a.holeIds)
    return b.holeIds.some(id => occupied.has(id))
  }
  if (a.kind === 'axial-interval' && b.kind === 'axial-interval') {
    if ((a.channelId ?? '') !== (b.channelId ?? '')) return false
    const [aStart, aEnd] = interval(a)
    const [bStart, bEnd] = interval(b)
    return Math.max(aStart, bStart) < Math.min(aEnd, bEnd) - EPSILON
  }
  if (a.kind === 'surface-footprint' && b.kind === 'surface-footprint') {
    return polygonsOverlap(a.polygon, b.polygon)
  }
  return false
}

/** Return every proposed/existing conflict so callers can highlight all blockers. */
export function findOccupancyConflicts(
  proposed: readonly AssemblyOccupancy[],
  existing: readonly AssemblyOccupancy[],
): OccupancyConflict[] {
  const conflicts: OccupancyConflict[] = []
  proposed.forEach((candidate, proposedIndex) => {
    existing.forEach((occupied, existingIndex) => {
      if (occupanciesConflict(candidate, occupied)) {
        conflicts.push({ proposedIndex, existingIndex, proposed: candidate, existing: occupied })
      }
    })
  })
  return conflicts
}
