import assert from 'node:assert/strict'
import { calibrationCornerReducer, calibrationPointFromClick, emptyCalibrationCorners, validCalibrationQuad } from '../src/utils/calibrationCorners.ts'

// A tall photo can be scrolled so its image rectangle starts above the viewport.
// Click coordinates must still be measured from the image, not the scroll box.
const point = calibrationPointFromClick(150, 310,
  { left: 50, top: -190, width: 200, height: 1000 }, 800, 4000)
assert.deepEqual(point, [400, 2000])

let state = emptyCalibrationCorners()
for (const [index, corner] of [[0, [80, 90]], [1, [720, 90]], [2, [720, 3900]], [3, [80, 3900]]]) {
  state = calibrationCornerReducer(state, { type: 'mark', index, point: corner, advance: true })
}
assert.equal(state.active, null, 'fourth click must not wrap around and overwrite the first corner')
assert.equal(validCalibrationQuad(state.points, 800, 4000), true)
state = calibrationCornerReducer(state, { type: 'undo' })
assert.equal(state.active, 3)
assert.equal(state.points[3], null)
state = calibrationCornerReducer(state, { type: 'clear' })
assert.ok(state.points.every(corner => corner === null))
state = calibrationCornerReducer(state, { type: 'undo' })
assert.equal(state.points[0][0], 80, 'clearing all four corners must be undoable')
assert.equal(validCalibrationQuad([[0, 0], [100, 100], [100, 0], [0, 100]], 200, 200), false,
  'crossed corner order must be rejected before extraction')
console.log('Calibration corners: scrolled photo coordinates, four-point advance, undo, clear and crossing guard OK')
