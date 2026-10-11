import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes, randomUUID, generateKeyPairSync, sign, createCipheriv, createDecipheriv } from 'node:crypto'
import policy from './policy.json' with { type: 'json' }
import accountPolicy from './account-policy.json' with { type: 'json' }
import { verifyJwt, requestMessage, enrollmentMessage, diyQuotaMessage, hash } from './crypto.mjs'
import { windowsLicenseStorageKey } from './storage-key.mjs'

const messages = { unlicensed: '尚未激活商用授权', valid: '商用授权有效', grace: '网络断开，使用已有离线宽限授权',
  expired: '商用授权已过期', revoked: '商用授权已吊销', invalid: '商用授权校验失败', clock_error: '系统时间回退，请联网校准授权' }
export function controllerAddress(source, simulation) {
  const url = new URL(source)
  if (url.username || url.password || url.search || url.hash
    || url.protocol !== 'https:' && !(simulation && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('授权服务必须使用HTTPS；HTTP仅用于本机演练')
  return url.origin
}
async function atomicVault(filename, body) {
  const { rename } = await import('node:fs/promises')
  const temp = filename + '.' + randomUUID() + '.tmp'
  await writeFile(temp, body, { mode: 0o600 }); await rename(temp, filename)
}
export function createLicenseClient({ directory, publicKey, controllerUrl, required = true, localSimulation = false,
  storageKey, storageKeyProvider, accountOnly = false, accountOrigin = 'https://orders.snapboard.cn', clock = () => Date.now(), fetcher = fetch, refreshMs = 6 * 3600_000 } = {}) {
  const origin = controllerAddress(controllerUrl, localSimulation), filename = path.join(directory, 'license.vault')
  const accountsOrigin = controllerAddress(accountOrigin, localSimulation)
  if (!localSimulation && !storageKey && !storageKeyProvider) throw new Error('生产客户端需要操作系统保护的授权存储')
  let key, state, initialize, inFlight, failure = '', offline = false, cacheDamaged = false, accountSession = null, heartbeat, vaultWrites = Promise.resolve()
  const load = () => initialize ??= (async () => {
    await mkdir(directory, { recursive: true })
    key = storageKey ? Buffer.from(storageKey) : storageKeyProvider ? Buffer.from(await storageKeyProvider(directory)) : await readFile(path.join(directory, 'simulation-vault.key')).catch(async error => {
      if (error.code !== 'ENOENT') throw error
      if (!localSimulation) throw new Error('生产客户端必须配置操作系统保护的存储密钥')
      const generated = randomBytes(32); await writeFile(path.join(directory, 'simulation-vault.key'), generated, { mode: 0o600, flag: 'wx' }); return generated
    })
    if (key.length !== 32) throw new Error('授权存储密钥无效')
    try {
      const envelope = JSON.parse(await readFile(filename, 'utf8'))
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAAD(Buffer.from('snapboard-license-v1')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]))
      scheduleHeartbeat()
    } catch (error) {
      if (error.code !== 'ENOENT') { cacheDamaged = true; failure = '本机授权缓存损坏，请重新激活；用户数据不受影响' }
      const device = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
      state = { deviceId: randomUUID(), publicKey: device.publicKey, privateKey: device.privateKey,
        license: null, proof: null, lastSeenAt: 0, lastOnlineAt: 0 }
      if (error.code === 'ENOENT') await save()
    }
  })()
  const save = () => {
    const task = vaultWrites.then(async () => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('snapboard-license-v1'))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()])
    await atomicVault(filename, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }))
    })
    vaultWrites = task.catch(() => undefined)
    return task
  }
  const summarize = () => {
    const now = clock(); let status = !required && !state.license ? 'valid' : 'unlicensed', claims
    if (state.lastSeenAt && now + 5 * 60_000 < state.lastSeenAt) status = 'clock_error'
    else if (failure && failure !== 'network') status = 'invalid'
    else if (state.proof) {
      try {
        claims = verifyJwt(state.proof, publicKey, 'status')
        if (claims.deviceId !== state.deviceId) throw new Error('设备不匹配')
        if (accountOnly && !claims.accountId) throw new Error('农场版只接受账号授权')
        if (!['valid', 'expired', 'revoked'].includes(claims.status) || !Array.isArray(claims.capabilities)) throw new Error('状态字段无效')
        status = claims.status === 'valid' ? claims.exp * 1000 > now ? offline ? claims.offlineAllowed ? 'grace' : 'expired' : 'valid' : 'expired' : claims.status
      } catch { status = 'invalid' }
    }
    const allowed = ['valid', 'grace'].includes(status)
    let contractExpiresAt = null, accountId = null
    try {
      if (state.license) { const licensed = verifyJwt(state.license, publicKey, 'license'); accountId = licensed.accountId || null
        const deadline = claims?.contractExpiresAt ?? licensed.contractExpiresAt
        if (accountId && Number.isSafeInteger(deadline) && deadline > 0) contractExpiresAt = new Date(deadline * 1000).toISOString()
        else if (!accountId) contractExpiresAt = new Date(licensed.exp * 1000).toISOString() }
    } catch { /* No unsigned expiry is displayed. */ }
    return { status, message: messages[status], required, commercialAllowed: allowed,
      capabilities: allowed ? claims?.capabilities ?? [] : [], deviceId: state.deviceId,
      licenseId: claims?.licenseId, validUntil: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
      contractExpiresAt, accountId, licenseType: state.license ? accountId ? 'account' : 'legacy' : null, offlineHours: accountId ? 72 : null,
      lastOnlineAt: state.lastOnlineAt ? new Date(state.lastOnlineAt).toISOString() : null,
      localSimulation, storageProtection: storageKey || storageKeyProvider ? 'os-protected' : 'local-simulation',
      detail: failure && failure !== 'network' ? failure : '', dataAccess: 'preserved' }
  }
  const refresh = async () => {
    await load(); if (!state.license) return summarize()
    if (inFlight) return inFlight
    const license = state.license, nonce = randomBytes(16).toString('hex')
    inFlight = (async () => {
      try {
        const licensed = verifyJwt(license, publicKey, 'license'), remoteOrigin = licensed.accountId ? accountsOrigin : origin
        if (accountOnly && !licensed.accountId) throw Object.assign(new Error('农场版请使用账号登录，旧卡密需负责人迁移'), { invalidResponse: true })
        const issuedAt = clock(), signature = sign(null, requestMessage(license, state.deviceId, nonce, issuedAt), state.privateKey).toString('base64url')
        const response = await fetcher(remoteOrigin + (licensed.accountId ? '/api/license/renew' : '/v1/verify'), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(licensed.accountId ? { Origin: remoteOrigin, ...(accountSession ? { Cookie: accountSession.cookie } : {}) } : {}) },
          redirect: 'error', signal: AbortSignal.timeout(5000), body: JSON.stringify({ license, deviceId: state.deviceId, nonce, issuedAt, signature }) })
        if (!response.ok) {
          if (response.status >= 500 || response.status === 429) throw new Error('授权服务暂时不可用')
          throw Object.assign(new Error('授权服务器拒绝了验证请求'), { invalidResponse: true })
        }
        const value = await response.json()
        let proof
        try {
          proof = verifyJwt(value.proof, publicKey, 'status')
          if (proof.nonce !== nonce || proof.deviceId !== state.deviceId || proof.licenseId !== licensed.licenseId || proof.accountId !== licensed.accountId
            || Math.abs(proof.iat * 1000 - clock()) > 5 * 60_000) throw new Error('授权响应不匹配或系统时间不准确')
          if (value.license) {
            const renewed = verifyJwt(value.license, publicKey, 'license')
            if (renewed.deviceId !== state.deviceId || renewed.licenseId !== proof.licenseId || renewed.accountId !== licensed.accountId) throw new Error('续期凭据不匹配')
          }
        } catch (error) { throw Object.assign(error, { invalidResponse: true }) }
        if (state.license !== license) return summarize()
        if (licensed.accountId && proof.status === 'valid') {
          const cookie = response.headers.get('set-cookie')?.split(';')[0], restored = value.accountSession
          if (!/^snapboard_site_session=[a-f0-9]{64}$/.test(cookie || '') || restored?.user?.id !== licensed.accountId || restored.user.role !== 'farm'
            || !/^[a-f0-9]{64}$/.test(restored.csrf || '') || !Number.isSafeInteger(restored.expiresAt) || restored.expiresAt <= clock()
            || !Array.isArray(restored.farms) || restored.farms.some(item => item.id !== licensed.accountId)) throw Object.assign(new Error('农场云会话响应不匹配'), { invalidResponse: true })
          accountSession = { ...restored, cookie, url: accountsOrigin }
        } else if (licensed.accountId) accountSession = null
        state.proof = value.proof; state.license = value.license || license; state.lastOnlineAt = clock()
        state.lastSeenAt = Math.max(state.lastSeenAt, clock()); failure = ''; offline = false; await save()
      } catch (error) {
        if (error.invalidResponse) failure = error.message
        else { failure = 'network'; offline = true }
      } finally { inFlight = null }
      return summarize()
    })()
    return inFlight
  }
  const scheduleHeartbeat = () => {
    if (heartbeat || !state.license || !verifyJwt(state.license, publicKey, 'license').accountId) return
    heartbeat = setInterval(() => { void refresh().catch(() => undefined) }, 60_000)
    heartbeat.unref?.()
  }
  const status = async ({ force = false } = {}) => {
    await load()
    if (state.license && (force || clock() - state.lastOnlineAt >= refreshMs)) await refresh()
    const result = summarize()
    if (!cacheDamaged && clock() > state.lastSeenAt) { state.lastSeenAt = clock(); await save() }
    return result
  }
  const activate = async license => {
    await load()
    const claims = verifyJwt(license.trim(), publicKey, 'license')
    if (accountOnly && !claims.accountId) throw new Error('农场版请使用账号登录，旧卡密需负责人迁移')
    if (claims.deviceId !== state.deviceId || claims.deviceKeyHash !== hash(state.publicKey)) throw new Error('授权与当前设备不匹配')
    state.license = license.trim(); state.proof = null; state.lastOnlineAt = 0; failure = ''; cacheDamaged = false; await save()
    scheduleHeartbeat()
    return refresh()
  }
  const device = async () => { await load(); return { deviceId: state.deviceId, publicKey: state.publicKey } }
  const enrollment = async () => {
    const identity = await device(), nonce = randomBytes(16).toString('hex'), issuedAt = clock()
    return { device: identity, nonce, issuedAt, signature: sign(null, enrollmentMessage(identity, nonce, issuedAt), state.privateKey).toString('base64url') }
  }
  const logout = async () => {
    await load(); state.license = null; state.proof = null; state.lastOnlineAt = 0; failure = ''; offline = false; accountSession = null
    if (heartbeat) clearInterval(heartbeat); heartbeat = undefined
    cacheDamaged = false; await save(); return summarize()
  }
  const assertCapability = async capability => {
    const result = await status({ force: true })
    if (!result.commercialAllowed || required && !result.capabilities.includes(capability)) {
      throw Object.assign(new Error(result.message + '；历史订单、图纸和已有文件仍可访问'), { status: 403, code: 'MERCHANT_LICENSE_REQUIRED' })
    }
    return result
  }
  const recoverAccountSession = async () => {
    const value = await status({ force: true })
    if (!value.accountId || value.status !== 'valid' || !accountSession || accountSession.expiresAt <= clock()) return null
    return { ...accountSession, authorization: value }
  }
  // DIY uses its own directory and signed quota purpose; these methods are not renderer APIs.
  const quotaSnapshot = async () => {
    await load()
    if (cacheDamaged) throw new Error('本机额度缓存损坏，请联系支持；图纸和制造文件仍保留')
    return structuredClone(state.diyQuota ?? null)
  }
  const saveQuotaSnapshot = async value => {
    await load()
    if (cacheDamaged) throw new Error('本机额度缓存损坏；未覆盖原缓存')
    state.diyQuota = structuredClone(value); await save()
  }
  const quotaRequest = async completed => {
    const identity = await device(), value = { device: identity, nonce: randomBytes(16).toString('hex'), issuedAt: clock(), completed }
    return { ...value, signature: sign(null, diyQuotaMessage(value), state.privateKey).toString('base64url') }
  }
  return { status, activate, device, enrollment, logout, refresh, assertCapability, recoverAccountSession,
    quotaSnapshot, saveQuotaSnapshot, quotaRequest }
}

let defaultClient, defaultAccountMode = false
const clientRoot = () => process.env.SNAPBOARD_MERCHANT_CLIENT_DIR || (process.env.SNAPBOARD_SYNC_DIR
  ? path.resolve('.merchant-license') : path.resolve(import.meta.dirname || path.resolve('apps/merchant-license'), '../../workspace-data/merchant-license/client'))
export function merchantLicenseClient({ account = false } = {}) {
  if (process.env.SNAPBOARD_LICENSE_STORAGE_UNAVAILABLE === '1') throw new Error('操作系统授权存储不可用；工程保存和历史数据仍可访问')
  const accountDirectory = path.join(clientRoot(), 'account-client')
  account ||= defaultAccountMode || process.env.SNAPBOARD_FARM_ACCOUNT_MODE === '1' || existsSync(path.join(accountDirectory, 'license.vault'))
  if (account && !defaultAccountMode) { defaultClient = undefined; defaultAccountMode = true }
  const selectedPolicy = defaultAccountMode ? accountPolicy : policy
  if (defaultAccountMode && hash(accountPolicy.publicKey) !== 'f924f54444f2431e6065ea5e75ab5e95fa6623d4921faf7a205f6c8fccb2834e') throw new Error('农场生产授权公钥不匹配')
  defaultClient ??= createLicenseClient({ ...selectedPolicy,
    directory: defaultAccountMode ? accountDirectory : clientRoot(),
    storageKey: process.env.SNAPBOARD_LICENSE_STORAGE_KEY ? Buffer.from(process.env.SNAPBOARD_LICENSE_STORAGE_KEY, 'base64') : undefined,
    storageKeyProvider: !selectedPolicy.localSimulation && process.platform === 'win32' && !process.env.SNAPBOARD_LICENSE_STORAGE_KEY ? windowsLicenseStorageKey : undefined })
  return defaultClient
}
