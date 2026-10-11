import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '..')
const name = `storage-check-${randomUUID()}.snapboard`
const file = path.join(root, '已保存项目', name)
const cacheDir = await mkdtemp(path.join(tmpdir(), 'snapboard-storage-check-'))
const server = await createServer({ root, cacheDir, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
try {
  await server.listen()
  const address = server.httpServer.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/api/project-library`
  assert.equal((await fetch(`${endpoint}/reveal`)).status, 405)
  assert.equal((await fetch(`${endpoint}/reveal?kind=invalid`, { method: 'POST' })).status, 400)
  assert.equal((await fetch(`${endpoint}/reveal`, { method: 'POST', headers: { Origin: 'https://example.invalid' } })).status, 403)
  for (const revision of [1, 2]) {
    const payload = { format: 'snapboard-project', schemaVersion: 1, workspace: { revision } }
    const response = await fetch(`${endpoint}/save?filename=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal(response.status, 200, await response.text())
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), payload)
  }
  const large = { format: 'snapboard-project', schemaVersion: 1,
    workspace: { padding: 'x'.repeat(51 * 1024 * 1024) } }
  const largeSave = await fetch(`${endpoint}/save?filename=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(large),
  })
  assert.equal(largeSave.status, 200, await largeSave.text())
  assert.ok((await stat(file)).size > 50 * 1024 * 1024, '项目保存不得卡在旧 50 MiB 上限')
  const restored = { format: 'snapboard-project', schemaVersion: 1, workspace: { revision: 3 } }
  const restoredSave = await fetch(`${endpoint}/save?filename=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(restored),
  })
  assert.equal(restoredSave.status, 200, await restoredSave.text())
  const opened = await fetch(`${endpoint}/open?filename=${encodeURIComponent(name)}`)
  assert.equal(opened.status, 200)
  assert.equal((await opened.json()).workspace.revision, 3)
  const listed = await (await fetch(`${endpoint}/list`)).json()
  assert.ok(listed.files.some(entry => entry.name === name))
  assert.ok(!(await readdir(path.dirname(file))).some(entry => entry.startsWith(name + '.') && entry.endsWith('.partial')))
  console.log('Project storage: create, >50 MiB save, overwrite without partial files, list, reopen and fixed-folder endpoint guards OK')
} finally {
  await server.close()
  await unlink(file).catch(() => undefined)
}
