import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const index = JSON.parse(await readFile('public/assemblyLibrary/index.json', 'utf8'))
assert.equal(index.schemaVersion, 1)
assert.ok(Array.isArray(index.packages) && index.packages.length >= 1, '至少应有一个装配资源包')
assert.ok(Array.isArray(index.hosts) && index.hosts.length >= 1, '至少应有一个宿主规格')
assert.equal(new Set(index.hosts.map(host => host.id)).size, index.hosts.length, 'host id 必须唯一')
assert.equal(new Set(index.hosts.map(host => host.compatibilityKey)).size, index.hosts.length, 'compatibilityKey 必须唯一')
for (const host of index.hosts) {
  assert.ok(['hole-pattern', 'rail-clip', 't-slot', 'surface-pad'].includes(host.kind), `${host.id} kind 无效`)
  assert.ok(Array.isArray(host.recipe) && host.recipe.length > 0, `${host.id} 缺少装配 recipe`)
  assert.ok(host.occupancy && typeof host.occupancy.kind === 'string', `${host.id} 缺少占用规则`)
}
console.log(`assembly library regression: ${index.packages.length} packs, ${index.hosts.length} hosts, unique compatibility keys OK`)
