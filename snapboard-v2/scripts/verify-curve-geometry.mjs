import assert from 'node:assert/strict'
import { checkModule } from './check-module.mjs'
const {
  arcArcIntersections,
  circleCircleIntersections,
  circleLineIntersections,
  collectCircleIntersectionAngles,
  collectArcIntersectionParams,
  collectCurveIntersectionParamsOnLine,
  findArcTrimRange,
  isLineTangentToArcAt,
  lineArcIntersections,
  projectPointToArc,
} = await checkModule('src/utils/arc.ts')
const { closeOpenChainWithStandaloneArc } = await checkModule('src/utils/contourMerge.ts')
const { chordHeightErrorMM, curveSegmentCount } = await checkModule('src/utils/curveTessellation.ts')

const EPS = 1e-6
const pointClose = (actual, expected, message) => {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) <= EPS,
    `${message}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`)
}

const center = { x: 0, y: 0 }
const bottomStart = { x: 5, y: 0 }
const bottomEnd = { x: -5, y: 0 }

const tangent = circleLineIntersections(center, 5, { x: -10, y: 5 }, { x: 10, y: 5 })
assert.equal(tangent.length, 1, 'tangent line must return one deduplicated point')
pointClose(tangent[0], { x: 0, y: 5 }, 'line-circle tangent')

const lineArc = lineArcIntersections(
  { x: 0, y: -10 }, { x: 0, y: 10 },
  center, 5, bottomStart, bottomEnd, 'ccw',
)
assert.equal(lineArc.length, 1, 'line-arc must filter the opposite circle intersection')
pointClose(lineArc[0], { x: 0, y: 5 }, 'line-arc intersection')

const verticalBlocker = {
  id: 'vertical-blocker', type: 'outer', name: 'line', closed: false,
  points: [{ x: 0, y: -10 }, { x: 0, y: 10 }], constraints: [],
}
const arcBreaks = collectArcIntersectionParams(
  center, 5, bottomStart, bottomEnd, 'ccw', [verticalBlocker], 'target-arc',
)
assert.equal(arcBreaks.length, 1, 'line crossing an arc must create one internal arc parameter')
assert.ok(Math.abs(arcBreaks[0] - 0.5) <= EPS)
assert.deepEqual(
  findArcTrimRange({ x: 4, y: 3 }, center, bottomStart, bottomEnd, 'ccw', arcBreaks),
  { t1: 0, t2: 0.5 },
  'clicking the first half of a split arc must select only that interval',
)
assert.deepEqual(
  findArcTrimRange({ x: -4, y: 3 }, center, bottomStart, bottomEnd, 'ccw', arcBreaks),
  { t1: 0.5, t2: 1 },
  'clicking the second half of a split arc must select only that interval',
)

const secant = circleCircleIntersections(center, 5, { x: 8, y: 0 }, 5)
assert.equal(secant.length, 2, 'two intersecting circles must return two points')
assert.ok(secant.some(point => Math.abs(point.x - 4) <= EPS && Math.abs(point.y - 3) <= EPS))
assert.ok(secant.some(point => Math.abs(point.x - 4) <= EPS && Math.abs(point.y + 3) <= EPS))

const circleTangent = circleCircleIntersections(center, 5, { x: 10, y: 0 }, 5)
assert.equal(circleTangent.length, 1)
pointClose(circleTangent[0], { x: 5, y: 0 }, 'circle-circle tangent')
assert.deepEqual(circleCircleIntersections(center, 5, center, 5), [], 'coincident circles are not finite intersections')
assert.deepEqual(circleCircleIntersections(center, 5, { x: 1, y: 0 }, 1), [], 'contained circles do not intersect')

const arcArc = arcArcIntersections(
  center, 5, bottomStart, bottomEnd, 'ccw',
  { x: 8, y: 0 }, 5, { x: 13, y: 0 }, { x: 3, y: 0 }, 'ccw',
)
assert.equal(arcArc.length, 1, 'arc-arc must keep only the point inside both sweeps')
pointClose(arcArc[0], { x: 4, y: 3 }, 'arc-arc intersection')

const mixedArcContour = {
  id: 'mixed-arc', type: 'inner', name: 'mixed arc', closed: false,
  points: [{ x: 13, y: 0 }, { x: 3, y: 0 }], constraints: [],
  arcs: [{ id: 'a', p1: 0, p2: 1, center: { x: 8, y: 0 }, radius: 5, sweep: 'ccw' }],
}
const collectedArcAngles = collectCircleIntersectionAngles(center, 5, [mixedArcContour])
assert.equal(collectedArcAngles.length, 1, 'circle intersection collector must include finite arc edges')

const otherCircleContour = {
  id: 'other-circle', type: 'inner', name: 'circle', closed: true, shape: 'circle',
  center: { x: 8, y: 0 }, radius: 5,
  points: [{ x: 13, y: 0 }, { x: 8, y: 5 }, { x: 3, y: 0 }, { x: 8, y: -5 }],
  constraints: [],
}
const collectedCircleAngles = collectCircleIntersectionAngles(center, 5, [otherCircleContour])
assert.equal(collectedCircleAngles.length, 2, 'circle intersection collector must include other circles')

const rectangleTop = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
const borderArc = {
  id: 'border-arc', type: 'outer', name: 'arc divider', closed: false,
  points: [{ x: 0, y: 40 }, { x: 40, y: 0 }], constraints: [],
  arcs: [{ id: 'divider', p1: 0, p2: 1, center: { x: 0, y: 0 }, radius: 40, sweep: 'cw' }],
}
const borderBreaks = collectCurveIntersectionParamsOnLine(rectangleTop[0], rectangleTop[1], [borderArc])
assert.equal(borderBreaks.length, 1, 'arc endpoint on a rectangle border must create one trim boundary')
assert.ok(Math.abs(borderBreaks[0] - 0.4) <= EPS, 'arc-border trim boundary must use the real line parameter')

const radialProjection = projectPointToArc(
  { x: 0, y: 8 }, center, 5, bottomStart, bottomEnd, 'ccw',
)
assert.equal(radialProjection.kind, 'arc')
pointClose(radialProjection.point, { x: 0, y: 5 }, 'radial arc projection')
assert.ok(Math.abs(radialProjection.distance - 3) <= EPS)

const clampedProjection = projectPointToArc(
  { x: 0, y: -8 }, center, 5, bottomStart, bottomEnd, 'ccw',
)
assert.ok(clampedProjection.kind === 'start' || clampedProjection.kind === 'end')
assert.ok(Math.min(
  Math.hypot(clampedProjection.point.x - bottomStart.x, clampedProjection.point.y - bottomStart.y),
  Math.hypot(clampedProjection.point.x - bottomEnd.x, clampedProjection.point.y - bottomEnd.y),
) <= EPS, 'projection outside the arc clamps to an endpoint')

assert.equal(isLineTangentToArcAt(
  { x: -5, y: 5 }, { x: 0, y: 5 }, center, { x: 0, y: 5 },
), true, 'horizontal line at the bottom radius must be tangent')
assert.equal(isLineTangentToArcAt(
  { x: 0, y: 0 }, { x: 0, y: 5 }, center, { x: 0, y: 5 },
), false, 'radial line must not be classified as tangent')

const closure = closeOpenChainWithStandaloneArc(
  [{ x: 40, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 40 }],
  [{ x: 0, y: 40 }, { x: 40, y: 0 }],
  { id: 'closing-arc', p1: 0, p2: 1, center: { x: 40, y: 40 }, radius: 40, sweep: 'cw' },
)
assert.ok(closure, 'an open line chain with matching arc endpoints must close')
assert.deepEqual(closure.points, [{ x: 40, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 40 }])
assert.equal(closure.arc.p1, 2)
assert.equal(closure.arc.p2, 0)
assert.equal(closeOpenChainWithStandaloneArc(
  [{ x: 80, y: 0 }, { x: 80, y: 40 }],
  [{ x: 0, y: 40 }, { x: 40, y: 0 }],
  { id: 'miss', p1: 0, p2: 1, center: { x: 40, y: 40 }, radius: 40, sweep: 'cw' },
), null, 'non-matching endpoints must not be force-merged')

const largeCurveSegments = curveSegmentCount(500, 1, Math.PI * 2)
assert.ok(largeCurveSegments > 48, 'large-radius manufacturing curves must refine beyond the old fixed 48 segments')
assert.ok(chordHeightErrorMM(500, 1, largeCurveSegments, Math.PI * 2) <= 0.050001,
  'adaptive curve tessellation must respect the 0.05mm chord-height budget')

console.log('curve geometry regression: line-arc, circle-circle, arc-arc and arc projection passed')
