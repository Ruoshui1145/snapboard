import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-hole-standard')
execFileSync(process.execPath, [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--ignoreConfig',
  'src/utils/pegboardSplit.ts', 'src/utils/holePattern.ts', 'src/types/geometry.ts',
  '--outDir', outDir, '--module', 'esnext', '--moduleResolution', 'bundler',
  '--target', 'es2023', '--skipLibCheck', 'true', '--esModuleInterop', 'true',
], { cwd: root, stdio: 'inherit' })

const split = await import(`${pathToFileURL(path.join(outDir, 'utils', 'pegboardSplit.js')).href}?t=${Date.now()}`)
const pattern = await import(`${pathToFileURL(path.join(outDir, 'utils', 'holePattern.js')).href}?t=${Date.now()}`)
const near = (a, b, tolerance = 1e-4) => Math.abs(a - b) <= tolerance

assert.equal(split.PEGBOARD_DEFAULT_CONFIG.jointDiameter, 5, '默认圆孔必须为 φ5')
assert.equal(pattern.SKADIS_DEFAULTS.jointHole.diameter, 5)
assert.ok(near(split.PEGBOARD_DEFAULT_CONFIG.slotStaggerX, 22.2648), 'B 列 X 相位必须来自 SVG 32.2648mm 中心线')

const result = split.splitOrthogonalPolygon({ points: [
  { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 },
] })
assert.equal(result.panels.length, 1)
const board = result.panels[0]
const bottomRounds = board.edge_holes.filter(hole => near(hole.y, 10)).map(hole => hole.x).sort((a, b) => a - b)
assert.deepEqual(bottomRounds, [10, 50, 90, 130, 170], '底边圆孔中心必须严格距底边 10mm')
const bottomSlots = board.slots.filter(hole => near(hole.y, 10)).map(hole => hole.x).sort((a, b) => a - b)
assert.ok(bottomSlots.length >= 4)
bottomSlots.forEach((x, index) => assert.ok(near(x, 32.2648 + index * 40), `底边长圆孔 B 列相位错误: ${x}`))
assert.ok(board.slots.some(hole => near(hole.x, 10) && near(hole.y, 30)), 'A 列首孔必须为 (10,30)')
assert.ok(board.slots.some(hole => near(hole.x, 32.2648) && near(hole.y, 10)), 'B 列首孔必须为 (32.2648,10)')

console.log(JSON.stringify({
  roundDiameter: split.PEGBOARD_DEFAULT_CONFIG.jointDiameter,
  bottomCenterOffset: 10,
  bottomRounds,
  bottomSlots,
  slotPhaseA: [10, 30],
  slotPhaseB: [32.2648, 10],
}, null, 2))
