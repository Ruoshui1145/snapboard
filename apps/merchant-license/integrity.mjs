import { readdir, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { signJwt, verifyJwt } from './crypto.mjs'
import policy from './policy.json' with { type: 'json' }


async function digest(filename) {
  const sha = createHash('sha256')
  for await (const chunk of createReadStream(filename)) sha.update(chunk)
  return sha.digest('hex')
}
async function payloadFiles(root) {
  const files = []
  const walk = async relative => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (!relative && entry.name === 'merchant-integrity.jwt') continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isSymbolicLink()) throw new Error('发行文件不得为符号链接')
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) files.push(name)
    }
  }
  await walk('')
  return files
}
export async function payloadManifestClaims(root) {
  const files = []
  for (const name of await payloadFiles(root)) {
    const filename = path.join(root, name)
    files.push({ path: name, size: (await stat(filename)).size, sha256: await digest(filename) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const iat = Math.floor(Date.now() / 1000)
  return {iat,exp:iat+10*365*86400,files}
}
export async function makePayloadManifest(root, privateKey, target) {
  const claims=await payloadManifestClaims(root)
  const manifest = signJwt(claims, privateKey, 'integrity')
  await writeFile(target, manifest); return { files: claims.files.length }
}
export async function verifyPayloadManifest(root, token, publicKey) {
  const claims = verifyJwt(token, publicKey, 'integrity')
  if (!Array.isArray(claims.files) || !claims.files.length || claims.files.length > 20000) throw new Error('发行完整性清单无效')
  const base = await realpath(root), seen = new Set()
  for (const file of claims.files) {
    if (!file || typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':') || file.path.startsWith('/')
      || file.path.split('/').some(part => !part || part === '..' || part === '.') || seen.has(file.path)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('发行完整性文件路径无效')
    seen.add(file.path)
    const filename = await realpath(path.join(base, file.path))
    if (!filename.startsWith(base + path.sep) || (await stat(filename)).size !== file.size || await digest(filename) !== file.sha256) throw new Error(`软件发行文件已改变：${file.path}；用户数据不会被删除`)
  }
  const actual = await payloadFiles(base)
  if (actual.length !== seen.size || actual.some(name => !seen.has(name))) throw new Error('发行目录出现未签名文件；用户数据不会被删除')
  return { verified: true, files: seen.size }
}
export async function verifyMerchantPayloadIntegrity(root) {
  return verifyPayloadManifest(root, await readFile(path.join(root, 'merchant-integrity.jwt'), 'utf8'), policy.publicKey)
}
