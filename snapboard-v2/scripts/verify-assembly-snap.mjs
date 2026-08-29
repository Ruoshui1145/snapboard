import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as THREE from 'three'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-assembly-regression')
const tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [
  tscPath,
  '--ignoreConfig',
  'src/utils/assemblySnap.ts', 'src/utils/assemblySide.ts', 'src/utils/slotAxisProbe.ts', 'src/utils/mountAxis.ts', 'src/utils/mountCalibrationRepair.ts', 'src/partLibrary/types.ts',
  '--outDir', outDir, '--module', 'esnext', '--moduleResolution', 'bundler',
  '--target', 'es2023', '--skipLibCheck', 'true', '--esModuleInterop', 'true',
], { cwd: root, stdio: 'inherit' })

const snap = await import(`${pathToFileURL(path.join(outDir, 'utils', 'assemblySnap.js')).href}?t=${Date.now()}`)
const probe = await import(`${pathToFileURL(path.join(outDir, 'utils', 'slotAxisProbe.js')).href}?t=${Date.now()}`)
const partTypes = await import(`${pathToFileURL(path.join(outDir, 'partLibrary', 'types.js')).href}?t=${Date.now()}`)
const repair = await import(`${pathToFileURL(path.join(outDir, 'utils', 'mountCalibrationRepair.js')).href}?t=${Date.now()}`)
const mountAxis = await import(`${pathToFileURL(path.join(outDir, 'utils', 'mountAxis.js')).href}?t=${Date.now()}`)
const assemblySide = await import(`${pathToFileURL(path.join(outDir, 'utils', 'assemblySide.js')).href}?t=${Date.now()}`)

const slotAnchor = { id: 'a1', accepts: ['slot'], position: [0, 0, -2], axis: [0, 1], required: true }
const slotTarget = { id: 'p1:slot:0', panelId: 'p1', kind: 'slot', x: 0, y: 0, z: 4, axis: [0, 1] }
const aligned = snap.fitPartAnchors([slotAnchor], [slotTarget], { x: 0, y: 0 }, 10, 1, 0)
assert.ok(aligned)
assert.equal(aligned.rotationZ, 0)
const sideways = snap.fitPartAnchors([slotAnchor], [slotTarget], { x: 0, y: 0 }, 10, 1, Math.PI / 2)
assert.equal(sideways, null, '长圆孔锚点旋转 90° 必须被轴向约束拒绝')

const occupied = snap.fitPartAnchors([slotAnchor], [slotTarget], { x: 0, y: 0 }, 10, 1, 0, new Set([slotTarget.id]))
assert.equal(occupied, null, '已占用孔不能被第二个零件复用')

const contactFit = snap.fitPartAnchors([slotAnchor], [slotTarget], { x: 0, y: 0 }, 10, 1, 0, undefined, -3)
assert.ok(contactFit)
assert.equal(contactFit.position[2], 7, '板面 z=4、接触面 z=-3 时零件原点应放在 z=7')
assert.equal(snap.contactZForSide(-3, 'back'), 3)
const backContactFit = snap.fitPartAnchors([slotAnchor], [{ ...slotTarget, z: 0 }], { x: 0, y: 0 }, 10, 1, 0, undefined, snap.contactZForSide(-3, 'back'))
assert.equal(backContactFit.position[2], -3)
const backAxis = snap.anchorsForSide([slotAnchor], 'back')[0].axis
assert.equal(Math.abs(backAxis[0]), 0)
assert.equal(backAxis[1], 1)
assert.deepEqual(snap.anchorsForSide([{ ...slotAnchor, axis: [0.6, 0.8] }], 'back')[0].axis, [-0.6, 0.8])

const panel = {
  id: 'p1', x: 0, y: 0, w: 100, h: 100,
  slots: [{ x: 20, y: 20 }], round_holes: [], edge_holes: [],
}
const cfg = { thickness: 4 }
const front = snap.splitPanelTargets([panel], cfg, 'front')
const back = snap.splitPanelTargets([panel], cfg, 'back')
assert.equal(front[0].id, back[0].id, '正背面必须共享同一个全局孔位 ID')

const post = new THREE.Mesh(new THREE.BoxGeometry(5, 15, 4), new THREE.MeshBasicMaterial())
post.updateMatrixWorld(true)
const derived = probe.deriveSlotAxis(post, { id: 'post', accepts: ['slot'], position: [0, 0, 2], normal: [0, 0, 1] })
assert.ok(derived)
assert.ok(Math.abs(derived[1]) > 0.9, `应识别 Y 向长轴，实际 ${derived}`)

const roundGeometry = new THREE.CylinderGeometry(3, 3, 4, 48)
roundGeometry.rotateX(Math.PI / 2)
const round = new THREE.Mesh(roundGeometry, new THREE.MeshBasicMaterial())
round.updateMatrixWorld(true)
assert.equal(probe.deriveSlotAxis(round, { id: 'round', accepts: ['slot'], position: [0, 0, 2], normal: [0, 0, 1] }), undefined)

const legacyPart = { id: 'legacy', category: 'base', name: 'legacy', params: [], model: {}, mount: { mode: 'single', anchors: [{ id: 'a1', accepts: ['slot'], position: [0, 0, 0] }] }, defaultRotation: 0 }
assert.equal(partTypes.mountNeedsCalibration(legacyPart), true, '缺少 slot axis 的旧标定必须回到标定器补算')
assert.deepEqual(mountAxis.stabilizeSlotAxis([-0.131, 0.991]), [0, 1], '采样导致的小角度偏斜应归正为竖直长轴')
const diagonalAxis = mountAxis.stabilizeSlotAxis([Math.SQRT1_2, Math.SQRT1_2])
assert.ok(Math.abs(diagonalAxis[0] - Math.SQRT1_2) < 1e-9 && Math.abs(diagonalAxis[1] - Math.SQRT1_2) < 1e-9, '真实斜向长轴必须保留')
assert.equal(assemblySide.assemblySideForView('free', 100, 4), 'front', '自由视角相机位于 +Z 时应装在正面')
assert.equal(assemblySide.assemblySideForView('free', -100, 4), 'back', '自由视角相机绕到 -Z 时应装在背面')
assert.equal(assemblySide.assemblySideForView('front', -100, 4), 'front', '正面锁定必须覆盖相机位置')
assert.equal(assemblySide.assemblySideForView('back', 100, 4), 'back', '背面锁定必须覆盖相机位置')

const recovered = repair.recoverLegacyContactSelection({
  mode: 'multi',
  anchors: [
    { id: 'a1', accepts: ['slot'], position: [0, 0, -8.9], axis: [0, 1] },
    { id: 'a2', accepts: ['slot'], position: [20, 0, -8.9], axis: [0, 1] },
    { id: 'a3', accepts: ['round'], position: [0, 20, -8.9] },
    { id: 'a4', accepts: ['round'], position: [10, 10, -4] },
  ],
})
assert.equal(recovered.recoveredLegacyContact, true)
assert.equal(recovered.anchors.length, 3, '旧版误记的最后一个圆孔应恢复为接触面')
assert.equal(recovered.contactZ, -4)

const opened = []
const coveredTarget = { ...slotTarget, id: 'covered', covered: true, source: { panelX: 0, panelY: 0, holeX: 20, holeY: 20 } }
assert.equal(snap.openCoveredAssemblyTargets([coveredTarget, coveredTarget], (...args) => opened.push(args)), 1)
assert.equal(opened.length, 1, '同一候选孔即使被重复引用也只能打通一次')

console.log('assembly snap regression: axis, occupancy, contactZ and legacy axis probe OK')
