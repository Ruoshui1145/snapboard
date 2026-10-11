import assert from 'node:assert/strict'
import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs'

const EPS = 1e-3
const TAU = Math.PI * 2

const closeTo = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) <= EPS, `${message}: expected ${expected}, got ${actual}`)
}

const normalizeSpan = (start, end) => {
  let span = end - start
  while (span <= 0) span += TAU
  while (span > TAU) span -= TAU
  return span
}

const mod = await init_planegcs_module()
const gcs = new GcsWrapper(new mod.GcsSystem())

const solve = primitives => {
  gcs.clear_data()
  gcs.set_max_iterations(2000)
  gcs.push_primitives_and_params(primitives)
  gcs.solve()
  gcs.apply_solution()
  assert.equal(gcs.has_gcs_conflicting_constraints(), false, 'curve solve must not conflict')
  return gcs.sketch_index.get_primitives()
}

try {
  const circleRadiusResult = solve([
    { id: 'circle_center_0', type: 'point', x: 20, y: 30, fixed: true },
    { id: 'circle_0', type: 'circle', c_id: 'circle_center_0', radius: 12 },
    { id: 'circle_radius_0', type: 'circle_radius', c_id: 'circle_0', radius: 25 },
  ])
  const radiusCircle = circleRadiusResult.find(item => item.id === 'circle_0')
  const radiusCenter = circleRadiusResult.find(item => item.id === 'circle_center_0')
  closeTo(radiusCircle.radius, 25, 'circle radius constraint')
  closeTo(radiusCenter.x, 20, 'circle center x stays fixed')
  closeTo(radiusCenter.y, 30, 'circle center y stays fixed')

  const circleDiameterResult = solve([
    { id: 'circle_center_0', type: 'point', x: -5, y: 7, fixed: true },
    { id: 'circle_0', type: 'circle', c_id: 'circle_center_0', radius: 10 },
    { id: 'circle_diameter_0', type: 'circle_diameter', c_id: 'circle_0', diameter: 64 },
  ])
  closeTo(circleDiameterResult.find(item => item.id === 'circle_0').radius, 32, 'circle diameter constraint')

  // “改半径”语义：用目标半径 + 等比例弧长保持原 90° 圆心角。
  const arcRadiusResult = solve([
    { id: 'arc_center_a', type: 'point', x: 0, y: 0, fixed: true },
    { id: 'p0', type: 'point', x: 10, y: 0, fixed: false },
    { id: 'p1', type: 'point', x: 0, y: 10, fixed: false },
    {
      id: 'arc_a', type: 'arc', c_id: 'arc_center_a', start_id: 'p0', end_id: 'p1',
      radius: 10, start_angle: 0, end_angle: Math.PI / 2,
    },
    { id: 'arc_rules_a', type: 'arc_rules', a_id: 'arc_a' },
    { id: 'arc_radius_a', type: 'arc_radius', a_id: 'arc_a', radius: 20 },
    { id: 'arc_length_a', type: 'arc_length', a_id: 'arc_a', dist: 20 * Math.PI / 2 },
  ])
  const radiusArc = arcRadiusResult.find(item => item.id === 'arc_a')
  closeTo(radiusArc.radius, 20, 'arc radius constraint')
  closeTo(normalizeSpan(radiusArc.start_angle, radiusArc.end_angle), Math.PI / 2, 'arc radius edit keeps angle')

  // “改弧长”语义：用当前半径作临时稳定器，让弧长只改变圆心角。
  const arcLengthResult = solve([
    { id: 'arc_center_b', type: 'point', x: 0, y: 0, fixed: true },
    { id: 'p0', type: 'point', x: 20, y: 0, fixed: false },
    { id: 'p1', type: 'point', x: 0, y: 20, fixed: false },
    {
      id: 'arc_b', type: 'arc', c_id: 'arc_center_b', start_id: 'p0', end_id: 'p1',
      radius: 20, start_angle: 0, end_angle: Math.PI / 2,
    },
    { id: 'arc_rules_b', type: 'arc_rules', a_id: 'arc_b' },
    { id: 'arc_radius_b', type: 'arc_radius', a_id: 'arc_b', radius: 20 },
    { id: 'arc_length_b', type: 'arc_length', a_id: 'arc_b', dist: 20 * Math.PI },
  ])
  const lengthArc = arcLengthResult.find(item => item.id === 'arc_b')
  closeTo(lengthArc.radius, 20, 'arc length edit keeps radius')
  closeTo(normalizeSpan(lengthArc.start_angle, lengthArc.end_angle), Math.PI, 'arc length controls angle')

  // 混合轮廓圆角：两条相邻直线保持 H/V 与切线关系，改半径时允许弧心移动。
  const filletResult = solve([
    { id: 'p0', type: 'point', x: 0, y: 10, fixed: true },
    { id: 'p1', type: 'point', x: 10, y: 10, fixed: false },
    { id: 'p2', type: 'point', x: 20, y: 0, fixed: false },
    { id: 'p3', type: 'point', x: 20, y: -10, fixed: true },
    { id: 'l0-1', type: 'line', p1_id: 'p0', p2_id: 'p1' },
    { id: 'l2-3', type: 'line', p1_id: 'p2', p2_id: 'p3' },
    { id: 'arc_center_fillet', type: 'point', x: 10, y: 0, fixed: false },
    {
      id: 'arc_fillet', type: 'arc', c_id: 'arc_center_fillet', start_id: 'p1', end_id: 'p2',
      radius: 10, start_angle: Math.PI / 2, end_angle: 0,
    },
    { id: 'arc_rules_fillet', type: 'arc_rules', a_id: 'arc_fillet' },
    { id: 'h_fillet', type: 'horizontal_l', l_id: 'l0-1' },
    { id: 'v_fillet', type: 'vertical_l', l_id: 'l2-3' },
    { id: 'tangent_left', type: 'tangent_la', l_id: 'l0-1', a_id: 'arc_fillet', temporary: true },
    { id: 'tangent_right', type: 'tangent_la', l_id: 'l2-3', a_id: 'arc_fillet', temporary: true },
    { id: 'arc_radius_fillet', type: 'arc_radius', a_id: 'arc_fillet', radius: 5 },
  ])
  const filletArc = filletResult.find(item => item.id === 'arc_fillet')
  const filletCenter = filletResult.find(item => item.id === 'arc_center_fillet')
  const filletStart = filletResult.find(item => item.id === 'p1')
  const filletEnd = filletResult.find(item => item.id === 'p2')
  closeTo(filletArc.radius, 5, 'fillet radius constraint')
  closeTo(filletStart.y, 10, 'incoming line stays horizontal')
  closeTo(filletEnd.x, 20, 'outgoing line stays vertical')
  closeTo(Math.hypot(filletStart.x - filletCenter.x, filletStart.y - filletCenter.y), 5, 'fillet start on circle')
  closeTo(Math.hypot(filletEnd.x - filletCenter.x, filletEnd.y - filletCenter.y), 5, 'fillet end on circle')
  closeTo((filletStart.x - 0) * (filletStart.x - filletCenter.x), 0, 'incoming line tangent at start')
  closeTo((filletEnd.y + 10) * (filletEnd.y - filletCenter.y), 0, 'outgoing line tangent at end')

  console.log('curve solver regression: circle/arc dimensions and tangent fillet radius semantics passed')
} finally {
  gcs.destroy_gcs_module()
}
