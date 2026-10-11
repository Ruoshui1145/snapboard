import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const read = file => readFile(file, 'utf8')
const [vite, dialog, resourceClient, assemblyIndexText, packSchema, hostSchema] = await Promise.all([
  read('vite.config.ts'),
  read('src/components/settings/SettingsDialog.tsx'),
  read('src/utils/resourceManagement.ts'),
  read('public/assemblyLibrary/index.json'),
  read('装配资源包/schema/assembly-host-pack.schema.json'),
  read('装配资源包/schema/host.schema.json'),
])

const assemblyIndex = JSON.parse(assemblyIndexText)
assert.equal(assemblyIndex.packages.length, 4)
assert.equal(assemblyIndex.hosts.length, 19)
assert.equal(assemblyIndex.warnings.length, 0)
assert.match(vite, /\/api\/resource-management\/summary/)
assert.match(vite, /\/api\/resource-management\/import-assembly-pack/)
assert.match(vite, /arbitraryPathsAccepted: false/)
assert.match(vite, /destructiveActionsAvailable: false/)
assert.match(vite, /装配资源包', '90-用户导入/)
assert.match(vite, /资源包 ID 已存在/)
assert.match(vite, /兼容键已存在/)
const tabs=/type SettingsTab = ([^\n]+)/.exec(dialog)?.[1] || ''
for(const tab of ['appearance','layout','calibration','marking','overview','parts','assembly','projects','storage'])assert.ok(tabs.includes("'"+tab+"'"),'Missing settings tab '+tab)
assert.match(dialog, /点击或拖入宿主数据包/)
assert.match(dialog, /file-drop-plus/)
assert.match(resourceClient, /snapboard-assembly-host-bundle/)
assert.equal(JSON.parse(packSchema).properties.kind.const, 'assembly-host-pack')
assert.deepEqual(JSON.parse(hostSchema).properties.kind.enum, ['hole-pattern', 'rail-clip', 't-slot', 'surface-pad'])

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
const originalFetch = globalThis.fetch
try {
  const { fetchResourceManagementSummary } = await server.ssrLoadModule('/src/utils/resourceManagement.ts')
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  await assert.rejects(fetchResourceManagementSummary(), /资源管理接口未返回完整数据/)
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}

console.log('resource management regression: 4 packs, 19 hosts, safe summary/import boundaries and settings tabs OK')
