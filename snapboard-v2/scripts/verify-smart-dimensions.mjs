import assert from 'node:assert/strict'
import { checkModule } from './check-module.mjs'
const {
  contourDimensionCenter,
  translateContourCenterToLineDistance,
  translateContourGeometry,
} = await checkModule('src/utils/constraintGeometry.ts')

const circle = {
  id: 'circle', type: 'inner', name: '圆孔', closed: true, shape: 'circle',
  center: { x: 100, y: 120 }, radius: 40,
  points: [{ x: 100, y: 80 }, { x: 140, y: 120 }, { x: 100, y: 160 }, { x: 60, y: 120 }],
  constraints: [{
    id: 'diameter', type: 'diameter', value: 40, driving: true,
    label: '直径 40.0 mm', labelPos: { x: 100, y: 60 },
  }],
}
const movedCircle = translateContourGeometry(circle, 50, -20)
assert.deepEqual(movedCircle.patch.center, { x: 150, y: 100 })
assert.equal(circle.radius, 40, '圆心定位不能改变圆孔半径')
assert.equal(movedCircle.patch.constraints[0].value, 40, '圆心定位不能覆盖直径约束')
assert.deepEqual(movedCircle.patch.constraints[0].labelPos, { x: 150, y: 40 })

const rectangle = {
  id: 'rect', type: 'inner', name: '矩形孔', closed: true,
  points: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 100 }, { x: 10, y: 100 }],
  constraints: [
    { id: 'width', type: 'length', edgeIndex: 0, value: 20, driving: true, label: '宽 20.0 mm', labelPos: { x: 20, y: 10 } },
    { id: 'height', type: 'length', edgeIndex: 1, value: 80, driving: true, label: '高 80.0 mm', labelPos: { x: 40, y: 60 } },
  ],
}
const movedRectangle = translateContourGeometry(rectangle, 300, 0)
const width = movedRectangle.points[1].x - movedRectangle.points[0].x
const height = movedRectangle.points[2].y - movedRectangle.points[1].y
assert.equal(width, 20)
assert.equal(height, 80)
assert.deepEqual(movedRectangle.patch.constraints.map(item => item.value), [20, 80], '边距定位不能覆盖孔洞宽高约束')

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} !== ${expected}`)

// 圆心 → 外板底边：只沿 Y 平移整个圆孔，半径与直径尺寸保持不变。
const circleToBottom = translateContourCenterToLineDistance(
  circle,
  { x: 0, y: 300 },
  { x: 500, y: 300 },
  100,
)
assert.ok(circleToBottom)
assert.deepEqual(circleToBottom.centerAfter, { x: 100, y: 200 })
assert.deepEqual(circleToBottom.patch.center, { x: 100, y: 200 })
assert.equal(circle.radius, 40)
assert.equal(circleToBottom.patch.constraints[0].value, 40)

// 正六边形中心 → 外板左边：定位只能整体平移，边长、参考半径和旋转不变。
const hexagon = {
  id: 'hex', type: 'inner', name: '正六边形孔', closed: true, shape: 'polygon',
  center: { x: 160, y: 140 }, radius: 60, rotation: 30,
  points: Array.from({ length: 6 }, (_, index) => {
    const angle = Math.PI / 6 + index * Math.PI / 3
    return { x: 160 + Math.cos(angle) * 60, y: 140 + Math.sin(angle) * 60 }
  }),
  constraints: [],
}
const hexSidesBefore = hexagon.points.map((point, index) => dist(point, hexagon.points[(index + 1) % 6]))
const hexToLeft = translateContourCenterToLineDistance(
  hexagon,
  { x: 0, y: 0 },
  { x: 0, y: 500 },
  90,
)
assert.ok(hexToLeft)
assert.deepEqual(hexToLeft.centerAfter, { x: 90, y: 140 })
assert.equal(hexToLeft.patch.radius, undefined, '定位不得改写规则多边形参考半径')
assert.equal(hexToLeft.patch.rotation, undefined, '定位不得改写规则多边形旋转')
hexToLeft.points.forEach((point, index) => close(
  dist(point, hexToLeft.points[(index + 1) % 6]),
  hexSidesBefore[index],
  '定位不得改变正六边形边长',
))

// 槽口没有 Contour.center：尺寸中心应为中心线中点，移动后宽度和长度均不变。
const slot = {
  id: 'slot', type: 'inner', name: '槽口', closed: true, slotWidth: 20,
  points: [{ x: 80, y: 100 }, { x: 80, y: 180 }], constraints: [],
}
assert.deepEqual(contourDimensionCenter(slot), { x: 80, y: 140 })
const slotLengthBefore = dist(slot.points[0], slot.points[1])
const slotToTop = translateContourCenterToLineDistance(
  slot,
  { x: 0, y: 0 },
  { x: 500, y: 0 },
  75,
)
assert.ok(slotToTop)
assert.deepEqual(slotToTop.centerAfter, { x: 80, y: 75 })
close(dist(slotToTop.points[0], slotToTop.points[1]), slotLengthBefore, '定位不得改变槽口中心线长度')
assert.equal(slot.slotWidth, 20, '定位不得改变槽口宽度')

// 普通闭合内孔没有参数中心：使用面积重心，而不是错误地使用第一个顶点。
const plainHole = {
  id: 'plain', type: 'inner', name: '普通内孔', closed: true,
  points: [{ x: 20, y: 30 }, { x: 80, y: 30 }, { x: 80, y: 70 }, { x: 20, y: 70 }],
  constraints: [],
}
assert.deepEqual(contourDimensionCenter(plainHole), { x: 50, y: 50 })
const plainVectors = plainHole.points.map(point => ({ x: point.x - 50, y: point.y - 50 }))
const plainToRight = translateContourCenterToLineDistance(
  plainHole,
  { x: 400, y: 0 },
  { x: 400, y: 500 },
  65,
)
assert.ok(plainToRight)
assert.deepEqual(plainToRight.centerAfter, { x: 335, y: 50 })
plainToRight.points.forEach((point, index) => assert.deepEqual(
  { x: point.x - 335, y: point.y - 50 },
  plainVectors[index],
))

assert.equal(
  translateContourCenterToLineDistance(plainHole, { x: 0, y: 0 }, { x: 0, y: 0 }, 20),
  null,
  '零长度基准边必须拒绝',
)

console.log('smart dimension regression: center-to-edge placement preserves circle, polygon, slot and generic-hole geometry')
