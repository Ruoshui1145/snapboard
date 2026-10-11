import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { importPartResourcePack, validatePartResourcePack } from './part-resource-pack.mjs'

const dir = path.resolve(import.meta.dirname, '../../output/resource-pack-audit')
await fs.mkdir(dir, { recursive: true })
const root = await fs.mkdtemp(path.join(dir, 'case-'))
const files = {
  'pack.json': strToU8(JSON.stringify({ id: 'test.pack', name: '测试配件包', version: '1.0.0', license: 'Private' })),
  'parts/挂钩/part.json': strToU8(JSON.stringify({ id: 'hook', name: '测试钩', category: 'hook', model: { preview: 'model.stl' }, mount: { anchors: [{ position: [0, 0, 0] }] } })),
  'parts/挂钩/model.stl': strToU8('solid hook\nendsolid hook'),
}
const valid = zipSync(files)
let syncCount = 0
const sync = async () => { syncCount++ }
await importPartResourcePack(root, valid, sync)
assert.equal(syncCount, 1)
assert.deepEqual(await fs.readFile(path.join(root, '配件资源包/测试配件包/parts/挂钩/part.json')), Buffer.from(files['parts/挂钩/part.json']))
await assert.rejects(importPartResourcePack(root, valid, sync), /已安装/)
assert.equal(syncCount, 1)
const invalidNames = ['../escape.stl', '/absolute.stl', 'x\\bad.stl', 'x:ads.stl', 'CON.stl', 'x./model.stl', 'x/../model.stl', 'x/a.exe', 'x/part.json/../foo.stl']
for (const name of invalidNames) assert.throws(() => validatePartResourcePack(zipSync({ ...files, [name]: strToU8('bad') })))
assert.throws(() => validatePartResourcePack(zipSync({ ...files, 'PACK.JSON': files['pack.json'] })), /重复路径/)
assert.throws(() => validatePartResourcePack(new Uint8Array([1, 2, 3])))
assert.throws(() => validatePartResourcePack(zipSync({ 'readme.txt': strToU8('empty') })), /pack.json/)
const bomb = Buffer.from(valid)
const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
bomb.writeUInt32LE(600 * 1024 * 1024, central + 24)
assert.throws(() => validatePartResourcePack(bomb), /500 MB/)
const failedRoot = await fs.mkdtemp(path.join(dir, 'rollback-'))
await assert.rejects(importPartResourcePack(failedRoot, valid, async () => { throw new Error('simulated sync error') }), /simulated/)
assert.deepEqual(await fs.readdir(path.join(failedRoot, '配件资源包')), [])
const concurrentRoot = await fs.mkdtemp(path.join(dir, 'concurrent-'))
const results = await Promise.allSettled([importPartResourcePack(concurrentRoot, valid, sync), importPartResourcePack(concurrentRoot, valid, sync)])
assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
await fs.writeFile(path.join(dir, 'fixture.sbpack'), valid)
console.log('PASS: resource pack round trip, calibration preservation, duplicate/concurrent import, corrupt archive, unsafe paths, pre-inflate size cap, rollback')
