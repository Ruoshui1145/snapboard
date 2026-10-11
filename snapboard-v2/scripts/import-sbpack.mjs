import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { importPartResourcePack } from './part-resource-pack.mjs'

const root = process.cwd()
const requested = process.argv[2]
if (!requested) throw new Error('用法: npm run pack:import -- "D:/下载/资源包.sbpack"')
const data = await fs.readFile(path.resolve(root, requested))
const result = await importPartResourcePack(root, data, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/sync-part-library.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`同步失败 (${code})`)))
}))
console.log(`已导入资源包 ${result.name} v${result.version}`)
