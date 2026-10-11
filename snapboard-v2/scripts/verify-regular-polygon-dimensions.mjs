import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
})

const close = (actual, expected, message, tolerance = 1e-7) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`)
}

const angleDelta = (a, b) => {
  const full = Math.PI * 2
  let delta = ((a - b) % full + full) % full
  if (delta > Math.PI) delta -= full
  return Math.abs(delta)
}

try {
  const polygon = await vite.ssrLoadModule('/src/utils/regularPolygon.ts')
  const center = { x: 240, y: 180 }
  const rotation = 0.371
  const baseRadius = 100
  const makePoints = radius => Array.from({ length: 6 }, (_, index) => {
    const angle = rotation + index * Math.PI / 3
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
  })
  const contour = {
    id: 'hex-hole', type: 'inner', name: '正六边形内孔', closed: true,
    shape: 'polygon', center, radius: baseRadius, rotation: rotation * 180 / Math.PI,
    polygonCircumscribed: false,
    points: makePoints(baseRadius),
    constraints: [],
  }

  const originalAngle = polygon.regularPolygonStartAngle(contour)

  // A side-length edit is a uniform parametric resize, not a two-vertex deformation.
  const sideTarget = 72
  const sideRadius = polygon.polygonReferenceRadiusForSide(contour, sideTarget)
  const bySide = polygon.resizeRegularPolygon(contour, sideRadius)
  assert.ok(bySide)
  close(Math.hypot(
    bySide.points[1].x - bySide.points[0].x,
    bySide.points[1].y - bySide.points[0].y,
  ), sideTarget, 'edited side length')
  assert.ok(polygon.regularPolygonInvariantError(contour, bySide.points) < 1e-7,
    'side edit must keep every side and circumradius equal')
  close(bySide.center.x, center.x, 'side edit keeps center x')
  close(bySide.center.y, center.y, 'side edit keeps center y')
  assert.ok(angleDelta(
    Math.atan2(bySide.points[0].y - center.y, bySide.points[0].x - center.x),
    originalAngle,
  ) < 1e-9, 'side edit keeps rotation')

  const previouslyDeformed = {
    ...contour,
    points: contour.points.map((point, index) => index === 2
      ? { x: point.x + 31, y: point.y - 17 }
      : point),
  }
  assert.ok(polygon.regularPolygonInvariantError(previouslyDeformed, previouslyDeformed.points) > 1,
    'fixture must reproduce a deformed legacy polygon')
  const repaired = polygon.resizeRegularPolygon(
    previouslyDeformed,
    polygon.polygonReferenceRadiusForSide(previouslyDeformed, sideTarget),
  )
  assert.ok(polygon.regularPolygonInvariantError(previouslyDeformed, repaired.points) < 1e-7,
    'the next parametric edit must repair a polygon deformed by the legacy local-edge solver')

  // Opposite-edge spacing (across flats) must scale the whole regular hexagon.
  const acrossFlats = 160
  const gapRadius = polygon.polygonReferenceRadiusForParallelGap(contour, 1, 4, acrossFlats)
  const byGap = polygon.resizeRegularPolygon(contour, gapRadius)
  assert.ok(byGap)
  close(gapRadius, acrossFlats / Math.sqrt(3), 'hex across-flats reference radius')
  assert.ok(polygon.regularPolygonInvariantError(contour, byGap.points) < 1e-7,
    'parallel-edge edit must keep a regular hexagon')

  // Arbitrary vertex distance is another scale driver; topology and orientation stay fixed.
  const acrossCorners = 190
  const vertexRadius = polygon.polygonReferenceRadiusForVertexDistance(contour, 0, 3, acrossCorners)
  const byVertex = polygon.resizeRegularPolygon(contour, vertexRadius)
  assert.ok(byVertex)
  close(vertexRadius, acrossCorners / 2, 'opposite-corner distance radius')
  assert.ok(polygon.regularPolygonInvariantError(contour, byVertex.points) < 1e-7,
    'vertex-distance edit must keep a regular hexagon')

  // Center-to-own-edge means inradius. In inscribed mode it converts to the stored
  // circumradius; in circumscribed mode the stored reference is already the inradius.
  const inradiusTarget = 68
  const insetReference = polygon.polygonReferenceRadiusForCenterEdgeDistance(contour, 1, inradiusTarget)
  close(insetReference, inradiusTarget / Math.cos(Math.PI / 6), 'inscribed hex inradius conversion')
  const byInset = polygon.resizeRegularPolygon(contour, insetReference)
  assert.ok(byInset)
  assert.ok(polygon.regularPolygonInvariantError(contour, byInset.points) < 1e-7,
    'center-edge edit must keep a regular hexagon')

  const circumscribed = {
    ...contour,
    polygonCircumscribed: true,
    radius: 80,
    points: makePoints(80 / Math.cos(Math.PI / 6)),
  }
  close(
    polygon.polygonReferenceRadiusForCenterEdgeDistance(circumscribed, 1, inradiusTarget),
    inradiusTarget,
    'circumscribed polygon stores its inradius directly',
  )
  close(
    polygon.polygonReferenceRadiusForSide(circumscribed, 100),
    50 / Math.tan(Math.PI / 6),
    'circumscribed side-length conversion',
  )

  // Related local annotations follow the parametric resize; cross-contour placement
  // annotations remain untouched and therefore cannot be accidentally rewritten.
  const constraintContour = {
    ...contour,
    constraints: [
      { id: 'radius', type: 'radius', value: 100, labelPos: { x: 290, y: 180 }, driving: true, label: 'R 100.0 mm' },
      { id: 'side', type: 'length', edgeIndex: 0, value: 100, labelPos: { x: 300, y: 220 }, driving: true, label: '长度 100.0 mm' },
      { id: 'gap', type: 'distance', edgeIndex: 1, edgeIndex2: 4, value: 173.2, labelPos: center, driving: true, label: '间距 173.2 mm' },
      { id: 'inset', type: 'distance', edgeIndex: 1, vertexIdx1: -2, value: 86.6, labelPos: { x: 240, y: 220 }, driving: true, label: '内切距 86.6 mm' },
      { id: 'placement', type: 'distance', edgeIndex: 0, vertexIdx1: -2, contourId2: 'outer', value: 40, labelPos: center, driving: true, label: '中心距 40.0 mm' },
    ],
  }
  const resized = polygon.resizeRegularPolygon(constraintContour, 80)
  const radiusPatch = polygon.regularPolygonConstraintPatch(constraintContour.constraints[0], resized, 1)
  const sidePatch = polygon.regularPolygonConstraintPatch(constraintContour.constraints[1], resized, 1)
  const gapPatch = polygon.regularPolygonConstraintPatch(constraintContour.constraints[2], resized, 1)
  const insetPatch = polygon.regularPolygonConstraintPatch(constraintContour.constraints[3], resized, 1)
  close(radiusPatch.value, 80, 'radius label follows resize')
  close(sidePatch.value, 80, 'hex side label follows resize')
  close(gapPatch.value, 80 * Math.sqrt(3), 'parallel label follows resize')
  close(insetPatch.value, 80 * Math.cos(Math.PI / 6), 'inradius label follows resize')
  assert.equal(polygon.regularPolygonConstraintPatch(constraintContour.constraints[4], resized, 1), null,
    'cross-contour placement dimension must not be rewritten by shape resize')

  // Repeated edits take orientation from points instead of rounded property-panel rotation,
  // so they cannot accumulate angular drift.
  let repeated = contour
  for (const radius of [120, 63, 145, 92]) {
    const next = polygon.resizeRegularPolygon(repeated, radius)
    repeated = { ...repeated, radius, points: next.points }
  }
  assert.ok(angleDelta(polygon.regularPolygonStartAngle(repeated), originalAngle) < 1e-9,
    'repeated dimension edits must not rotate the polygon')
  assert.ok(polygon.regularPolygonInvariantError(repeated, repeated.points) < 1e-7,
    'repeated dimension edits must remain regular')

  console.log('regular polygon dimension regression: side, opposite-edge, vertex, radius and inradius edits preserve the parametric hexagon')
} finally {
  await vite.close()
}
