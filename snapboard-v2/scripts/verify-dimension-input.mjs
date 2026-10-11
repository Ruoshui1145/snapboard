import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const out = path.resolve(root, '../output/dimension-input-audit')
execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '--ignoreConfig', 'src/utils/dimensionInput.ts', '--outDir', out, '--module', 'esnext', '--target', 'es2023', '--skipLibCheck', 'true'], { cwd: root, stdio: 'inherit' })
const { formatDimensionInput: format, parseDimensionInput: parse } = await import(pathToFileURL(path.join(out, 'dimensionInput.js')))
assert.equal(format(160.0839006943), '160.084')
assert.equal(format(0.1 + 0.2), '0.3')
assert.equal(format(420), '420')
assert.equal(format(-0), '0')
assert.equal(format(0.000000123456), '1.23e-7')
for (const n of [160.0839006943, 0.1 + 0.2, -5.12345678, 0, 420, 1e-8]) assert.equal(parse(format(n), n), n, '原样确认不得悄悄舍入几何')
assert.equal(parse('200', 160.0839006943), 200)
assert.ok(Number.isNaN(parse('', 160)))
assert.ok(Number.isNaN(parse('invalid', 160)))
assert.ok(!Number.isFinite(parse('Infinity', 160)))
assert.equal(format(Infinity), '')
console.log('PASS: finite display, decimal tails, small/signed values, invalid input, unchanged precision, edited values')
