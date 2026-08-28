import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-smart-dimensions')
execFileSync(process.execPath, [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--ignoreConfig', 'src/utils/constraintGeometry.ts', 'src/types/geometry.ts',
  '--outDir', outDir, '--module', 'esnext', '--moduleResolution', 'bundler',
  '--target', 'es2023', '--skipLibCheck', 'true',
], { cwd: root, stdio: 'inherit' })

const { translateContourGeometry } = await import(
  `${pathToFileURL(path.join(outDir, 'utils', 'constraintGeometry.js')).href}?t=${Date.now()}`
)

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

console.log('smart dimension regression: circle center and rectangular hole translate without changing size constraints')
