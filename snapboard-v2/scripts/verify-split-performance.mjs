import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-split-performance')
const tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [
  tscPath,
  '--ignoreConfig',
  'src/utils/pegboardSplit.ts', 'src/types/geometry.ts',
  '--outDir', outDir, '--module', 'esnext', '--moduleResolution', 'bundler',
  '--target', 'es2023', '--skipLibCheck', 'true',
], { cwd: root, stdio: 'inherit' })

const split = await import(`${pathToFileURL(path.join(outDir, 'utils', 'pegboardSplit.js')).href}?t=${Date.now()}`)

const runRectangle = (width, height) => {
  const start = performance.now()
  const result = split.splitOrthogonalPolygon({
    points: [
      { x: 0, y: 0 }, { x: width, y: 0 },
      { x: width, y: height }, { x: 0, y: height },
    ],
  }, split.PEGBOARD_DEFAULT_CONFIG)
  return { elapsed: performance.now() - start, result }
}

const large = runRectangle(1000, 800)
assert.equal(large.result.panels.length, 20)
assert.equal(large.result.coverageRatio, 1)
assert.deepEqual(large.result.warnings, [])
assert.ok(large.elapsed < 8_000, `1000x800mm 大板分割过慢：${large.elapsed.toFixed(0)}ms`)

const veryLarge = runRectangle(1400, 1000)
assert.equal(veryLarge.result.panels.length, 30)
assert.equal(veryLarge.result.coverageRatio, 1)
assert.deepEqual(veryLarge.result.warnings, [])
assert.ok(veryLarge.elapsed < 12_000, `1400x1000mm 大板分割过慢：${veryLarge.elapsed.toFixed(0)}ms`)

const sloped = split.splitOrthogonalPolygon({
  points: [
    { x: 0, y: 0 }, { x: 0, y: 650 }, { x: 220, y: 515 },
    { x: 500, y: 515 }, { x: 500, y: 230 }, { x: 710, y: 230 }, { x: 710, y: 0 },
  ],
}, split.PEGBOARD_DEFAULT_CONFIG)
const diagonalPanels = sloped.panels.filter(panel => panel.contour.some((point, index) => {
  const next = panel.contour[(index + 1) % panel.contour.length]
  return Math.abs(next.x - point.x) > 1e-6 && Math.abs(next.y - point.y) > 1e-6
}))
assert.equal(sloped.coverageRatio, 1, '斜边轮廓必须完整覆盖，不能丢弃边缘材料')
assert.equal(sloped.panels.length, 9)
assert.equal(diagonalPanels.length, 1, '原始斜边必须保留为真实直线，不能栅格化为台阶')
assert.ok(sloped.warnings.every(warning => !warning.includes('丢弃')), '可靠覆盖模式不能丢弃碎料')

console.log(JSON.stringify({
  large: { size: '1000x800', panels: large.result.panels.length, ms: Math.round(large.elapsed) },
  veryLarge: { size: '1400x1000', panels: veryLarge.result.panels.length, ms: Math.round(veryLarge.elapsed) },
  sloped: { panels: sloped.panels.length, coverage: sloped.coverageRatio, diagonalPanels: diagonalPanels.length },
}, null, 2))
