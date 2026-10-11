import assert from 'node:assert/strict'
import { createSpatialLayout, faceToWorld, worldToFace } from '../src/utils/spatialLayout.ts'

for (const [template, expectedFaces, expectedJunctions] of [
  ['flat', 1, 0], ['L', 2, 1], ['U', 3, 2], ['prism', 3, 3],
]) {
  const layout = createSpatialLayout({ template, width: 120, depth: 80, height: 160, thickness: 5 })
  assert.equal(layout.faces.length, expectedFaces)
  assert.equal(layout.junctions.length, expectedJunctions)
  for (const face of layout.faces) {
    const point = faceToWorld(face, face.width * 0.37, 65, 2)
    const [x, y, z] = worldToFace(face, point)
    assert.ok(Math.abs(x - face.width * 0.37) < 1e-8)
    assert.ok(Math.abs(y - 65) < 1e-8)
    assert.ok(Math.abs(z - 2) < 1e-8)
    assert.ok(face.width > 0)
  }
  for (const joint of layout.junctions) {
    const a = layout.faces.find(face => face.id === joint.from)
    const b = layout.faces.find(face => face.id === joint.to)
    assert.ok(a && b)
    const edgeA = faceToWorld(a, a.width, 0)
    const edgeB = faceToWorld(b, 0, 0)
    assert.ok(Math.hypot(...edgeA.map((value, index) => value - edgeB[index])) < 1e-8)
    assert.ok(joint.angleDegrees > 0 && joint.angleDegrees < 180)
  }
}

assert.throws(() => createSpatialLayout({ template: 'L', width: 100, height: 100, depth: 20, thickness: 11 }))
const adjustable = createSpatialLayout({ template: 'L', width: 120, depth: 80, height: 160, thickness: 5, angleDegrees: 120 })
assert.ok(Math.abs(adjustable.junctions[0].angleDegrees - 120) < 1e-8)
assert.ok(Math.abs(faceToWorld(adjustable.faces[0], 120, 0)[0] - faceToWorld(adjustable.faces[1], 0, 0)[0]) < 1e-8)
assert.throws(() => createSpatialLayout({ template: 'L', width: 120, depth: 80, height: 160, thickness: 5, angleDegrees: 170 }))
console.log('立体版面几何契约：Flat/L/U/三棱柱通过')
