import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import os from 'node:os'
import { localSecurityPlugin } from './local-security.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
// File naming has its own disposable fixture; licence denial/allowance is tested separately.
const originalCwd=process.cwd()
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'snapboard-export-names-'))
const loaded=await loadConfigFromFile({command:'serve',mode:'test'},path.join(root,'vite.config.ts'),root)
const projectPlugin=loaded.config.plugins.flat(Infinity).find(plugin=>plugin?.name==='snapboard-project-library-api')
assert.ok(projectPlugin)
const exportRoot=path.join(temporary,'已保存项目','制造导出')
process.chdir(temporary)
const server=await createServer({configFile:false,root,cacheDir:path.join(temporary,'cache'),plugins:[localSecurityPlugin(),projectPlugin],server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}})
const created = []
try {
  await server.listen()
  const address = server.httpServer.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/api/project-library/export`
  for (const extension of ['3mf', 'zip']) {
    const stem = `collision-${randomUUID()}`
    const bodies = ['original', 'second', 'third']
    for (const [index, content] of bodies.entries()) {
      const response = await fetch(`${endpoint}?filename=${encodeURIComponent(`${stem}.${extension}`)}`, { method: 'POST', body: content })
      const result = await response.json()
      assert.equal(response.status, 200, result.error)
      assert.equal(result.filename, `${stem}${index ? `(${index})` : ''}.${extension}`)
      const target = path.resolve(exportRoot, result.filename)
      assert(target.startsWith(exportRoot + path.sep))
      created.push(target)
      assert.equal(await fs.readFile(target, 'utf8'), content)
    }
    assert.equal(await fs.readFile(created.at(-3), 'utf8'), bodies[0], 'original export was overwritten')
  }
  const concurrentStem = `collision-${randomUUID()}`
  const parallel = await Promise.all(['a', 'b', 'c'].map(content => fetch(
    `${endpoint}?filename=${encodeURIComponent(`${concurrentStem}.zip`)}`,
    { method: 'POST', body: content },
  ).then(async response => ({ status: response.status, result: await response.json() }))))
  assert(parallel.every(item => item.status === 200))
  assert.deepEqual(parallel.map(item => item.result.filename).sort(),
    [`${concurrentStem}.zip`, `${concurrentStem}(1).zip`, `${concurrentStem}(2).zip`].sort())
  for (const item of parallel) created.push(path.join(exportRoot, item.result.filename))

  const { writeBinaryToLocalWorkspace } = await server.ssrLoadModule('/src/utils/projectFile.ts')
  const locks = new Map()
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (key, callback) => {
    const previous = locks.get(key) ?? Promise.resolve()
    let release
    const held = new Promise(resolve => { release = resolve })
    locks.set(key, previous.then(() => held))
    await previous
    try { return await callback() } finally { release() }
  } } } })
  const files = new Map()
  const outputDir = {
    name: '制造导出',
    async *values() { for (const name of files.keys()) yield { kind: 'file', name } },
    async getFileHandle(name) {
      assert(!files.has(name), `existing local file selected: ${name}`)
      files.set(name, '')
      let content = ''
      return { name, async createWritable() { return {
        async write(blob) { content = await blob.text() },
        async close() { files.set(name, content) },
      } } }
    },
  }
  const directory = { name: 'test-project', async getDirectoryHandle() { return outputDir } }
  for (const extension of ['3mf', 'zip']) {
    const results = await Promise.all(['first', 'second', 'third'].map(content =>
      writeBinaryToLocalWorkspace(directory, `local.${extension}`, new Blob([content]), '制造导出')))
    assert.deepEqual(results, [0, 1, 2].map(index =>
      `test-project/制造导出/local${index ? `(${index})` : ''}.${extension}`))
    assert.equal(files.get(`local.${extension}`), 'first')
  }
  console.log('Manufacturing export naming: API and local .3mf/.zip originals and (1)/(2) preserved; parallel API exports distinct')
} finally {
  await server.close()
  process.chdir(originalCwd)
  if(!temporary.startsWith(os.tmpdir()+path.sep))throw Error('Unsafe collision fixture cleanup')
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:4,retryDelay:100})
}
