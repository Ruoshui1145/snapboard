import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import accountPolicy from './account-policy.json' with { type: 'json' }
import { createLicenseClient, controllerAddress } from './client.mjs'
import { windowsLicenseStorageKey } from './storage-key.mjs'
import { verifyJwt, hash } from './crypto.mjs'
import { beijingDay, quotaDayEnd, isQuotaId, DIY_DAILY_EXPORTS } from './diy-quota-ledger.mjs'

export const isDiyEdition = () => process.env.SNAPBOARD_EDITION === 'diy' && process.env.SNAPBOARD_FARM_ACCOUNT_MODE !== '1'
const problem = (message, code = 'DIY_QUOTA_REQUIRED') => Object.assign(new Error(message), { status: 403, code })

/** Local serial reservations backed by one-use, server-signed daily permits. */
export function createDiyQuotaClient({ directory, publicKey, controllerUrl, localSimulation = false, storageKey, storageKeyProvider,
  clock = () => Date.now(), fetcher = fetch } = {}) {
  const origin = controllerAddress(controllerUrl, localSimulation)
  const identity = createLicenseClient({ directory, publicKey, controllerUrl, localSimulation, storageKey, storageKeyProvider, required: false, clock })
  let wallet, device, loadPromise, queue = Promise.resolve(), offline = false, failure = '', storageFailure = false, lastAttemptAt = 0
  const persist = async () => {
    try { await identity.saveQuotaSnapshot(wallet); storageFailure = false }
    catch { storageFailure = true; throw problem('本机额度记录无法保存，未开始新的导出；图纸和已有文件仍保留', 'DIY_QUOTA_STORAGE') }
  }
  const serial = action => {
    const job = queue.then(async () => { await load(); return action() })
    queue = job.catch(() => undefined)
    return job
  }
  const load = () => loadPromise ??= (async () => {
    device = await identity.device()
    wallet = await identity.quotaSnapshot() ?? { schemaVersion: 1, proof: null, tasks: [], pending: [], lastSeenAt: 0, lastOnlineAt: 0 }
    if (!wallet || wallet.schemaVersion !== 1 || !Array.isArray(wallet.tasks) || !Array.isArray(wallet.pending) || wallet.tasks.length > 400 || wallet.pending.length > 200
      || !Number.isSafeInteger(wallet.lastSeenAt) || !Number.isSafeInteger(wallet.lastOnlineAt)
      || wallet.tasks.some(task => !isQuotaId(task.id) || !isQuotaId(task.permitId) || !['reserved', 'complete', 'released'].includes(task.state)
        || task.unmetered !== undefined && typeof task.unmetered !== 'boolean'
        || !Number.isSafeInteger(task.startedAt) || typeof task.day !== 'string' || task.deliveryKey && !isQuotaId(task.deliveryKey)
        || task.target && (typeof task.target !== 'string' || !path.isAbsolute(task.target) || task.expectedBytes !== null && (!Number.isSafeInteger(task.expectedBytes) || task.expectedBytes <= 0)))
      || wallet.pending.some(receipt => !isQuotaId(receipt.id) || typeof receipt.day !== 'string')) throw problem('本机额度记录无效，请联系支持；未重置次数或覆盖原记录', 'DIY_QUOTA_STORAGE')
    // Resume only outcomes observable in the local service. Never delete user files.
    for (const task of wallet.tasks.filter(item => item.state === 'reserved')) {
      const saved = task.target ? await stat(task.target).catch(() => null) : null
      if (saved?.isFile() && saved.size > 0 && (task.expectedBytes === null || saved.size === task.expectedBytes)) completeLocal(task)
      else task.state = 'released'
    }
    await persist()
  })()
  const claims = () => {
    if (!wallet.proof) return null
    const value = verifyJwt(wallet.proof, publicKey, 'diy-quota')
    if (value.unmetered === true || value.limit !== DIY_DAILY_EXPORTS || value.deviceId !== device.deviceId || value.deviceKeyHash !== hash(device.publicKey) || !isQuotaId(value.applicationId)
      || !Array.isArray(value.permitIds)
      || (value.unmetered === true ? value.limit !== null || value.used !== 0 || value.permitIds.length !== 0
        : !Number.isSafeInteger(value.limit) || value.limit < DIY_DAILY_EXPORTS || value.limit > 200
          || !Number.isSafeInteger(value.used) || value.used < 0 || value.permitIds.length + value.used !== value.limit
          || new Set(value.permitIds).size !== value.permitIds.length || value.permitIds.some(id => !isQuotaId(id)))
      || value.exp * 1000 !== quotaDayEnd(value.day)) throw problem('额度签名或范围无效，请联网刷新', 'DIY_QUOTA_INVALID')
    return value
  }
  const completeLocal = task => {
    task.state = 'complete'
    if (!task.unmetered && !wallet.pending.some(row => row.id === task.permitId)) wallet.pending.push({ id: task.permitId, day: task.day })
  }
  const sync = async (force = false) => {
    if (!force && offline && clock() - lastAttemptAt < 60_000) return
    lastAttemptAt = clock()
    const request = await identity.quotaRequest(wallet.pending)
    try {
      const response = await fetcher(origin + '/v1/diy-quota', { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
      },
        redirect: 'error', signal: AbortSignal.timeout(5000), body: JSON.stringify(request) })
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 404) throw new Error('network')
        throw Object.assign(problem('额度服务未接受本次请求，请检查系统时间或联系支持'), { invalidResponse: true })
      }
      let value
      try {
        value = await response.json()
        const proof = verifyJwt(value.proof, publicKey, 'diy-quota')
        if (proof.nonce !== request.nonce || proof.deviceId !== device.deviceId || proof.deviceKeyHash !== hash(device.publicKey)
          || Math.abs(proof.iat * 1000 - clock()) > 5 * 60_000) throw new Error('mismatch')
        const previous = wallet.proof; wallet.proof = value.proof
        try { claims() } catch (error) { wallet.proof = previous; throw error }
      } catch { throw Object.assign(problem('额度响应验证失败，未接受新的额度'), { invalidResponse: true }) }
      wallet.pending = wallet.pending.filter(item => !request.completed.some(row => row.id === item.id))
      wallet.lastOnlineAt = clock(); offline = false; failure = ''
      await persist()
    } catch (error) {
      if (storageFailure) throw error
      if (error.invalidResponse) failure = error.message
      else { offline = true; failure = '' }
    }
  }
  const available = proof => {
    const taken = new Set([...wallet.pending.map(item => item.id), ...wallet.tasks.filter(task => task.state === 'reserved').map(task => task.permitId)])
    return proof.permitIds.filter(id => !taken.has(id))
  }
  const summarize = () => {
    let proof
    try { proof = claims() } catch (error) { failure = error.message }
    const day = beijingDay(clock()), clockError = clock() + 5 * 60_000 < wallet.lastSeenAt
    const valid = !!proof && proof.day === day && proof.exp * 1000 > clock() && !failure && !clockError && !storageFailure
    const unmetered = proof?.unmetered === true
    const remaining = valid ? unmetered ? null : available(proof).length : 0
    const pending = wallet.pending.filter(item => item.day === day).length
    const reserved = wallet.tasks.filter(task => task.state === 'reserved' && task.day === day).length
    const status = storageFailure ? 'invalid' : clockError ? 'clock_error' : failure ? 'invalid' : !valid ? 'needs_connection'
      : !unmetered && remaining === 0 ? 'quota_exhausted' : offline ? 'grace' : 'valid'
    const message = storageFailure ? '本机额度记录无法保存，图纸和已有文件仍保留' : clockError ? '系统时间回退，请校准时间后刷新额度'
      : failure || !valid ? failure || '请联网验证本机导出凭据；编辑、预览和保存仍可使用'
      : unmetered ? offline ? '本机签名凭据有效；软件内不限制每日次数，后续将由启动器管理，当前尚未接入' : '导出凭据已验证；软件内不限制每日次数，后续将由启动器管理，当前尚未接入'
      : remaining === 0 ? '今天的免费导出额度已用完，可到官网申请更多额度'
      : offline ? `网络暂不可用，今天还可离线导出 ${remaining} 次` : `今天还可免费导出 ${remaining} 次`
    return { edition: 'diy', status, message, deviceId: device.deviceId, commercialAllowed: valid && (unmetered || remaining > 0),
      capabilities: valid && (unmetered || remaining > 0) ? ['commercial.export'] : [], validUntil: proof ? new Date(proof.exp * 1000).toISOString() : null,
      localSimulation, storageProtection: localSimulation ? 'local-simulation' : 'os-protected', dataAccess: 'preserved',
      quota: { day, unmetered, limit: unmetered ? null : proof?.limit ?? DIY_DAILY_EXPORTS, used: (proof?.day === day ? proof.used : 0) + pending,
        remaining, reserved, pendingSync: wallet.pending.length, offline,
        applicationUrl: proof ? origin + '/diy?application=' + proof.applicationId : 'https://snapboard.cn/' } }
  }
  const touch = async () => {
    if (clock() + 5 * 60_000 < wallet.lastSeenAt) throw problem('系统时间回退，请校准时间后刷新额度')
    wallet.lastSeenAt = Math.max(wallet.lastSeenAt, clock()); await persist()
  }
  const status = ({ force = false } = {}) => serial(async () => {
    let value
    try { value = claims() } catch { value = null }
    if (force || !value || value.day !== beijingDay(clock()) || clock() - wallet.lastOnlineAt > 5 * 60_000) await sync(force)
    if (clock() >= wallet.lastSeenAt) { wallet.lastSeenAt = clock(); await persist() }
    return summarize()
  })
  const begin = () => serial(async () => {
    await touch()
    let before
    try { before = claims() } catch { before = null }
    if (!before || before.day !== beijingDay(clock()) || clock() - lastAttemptAt > 5000) await sync()
    const current = summarize()
    if (!current.commercialAllowed) throw problem(current.message, current.status === 'quota_exhausted' ? 'DIY_QUOTA_EXHAUSTED' : 'DIY_QUOTA_REQUIRED')
    if (wallet.tasks.filter(row => row.state === 'reserved').length >= 64) throw problem('正在进行的导出任务过多，请等待或取消后重试', 'DIY_EXPORT_BUSY')
    const proof = claims(), task = { id: randomUUID(), permitId: proof.unmetered === true ? randomUUID() : available(proof)[0], day: proof.day,
      unmetered: proof.unmetered === true, state: 'reserved', startedAt: clock() }
    const active = wallet.tasks.filter(row => row.state === 'reserved')
    wallet.tasks = [...wallet.tasks.filter(row => row.state !== 'reserved' && row.startedAt >= clock() - 7 * 86400000).slice(-(399 - active.length)), ...active, task]
    await persist()
    return { ticket: task.id, status: summarize() }
  })
  const findTask = id => {
    if (!isQuotaId(id)) throw problem('请从软件正常开始导出，未读取到导出凭据')
    const task = wallet.tasks.find(row => row.id === id)
    if (!task || task.state === 'released') throw problem('导出凭据不存在或已取消')
    if (task.state === 'reserved' && clock() - task.startedAt > 24 * 3600_000) throw problem('导出任务已超过24小时，请重新开始')
    return task
  }
  const assertTicket = id => serial(async () => { await touch(); const task = findTask(id)
    if (task.state !== 'reserved') throw problem('该导出已完成；再次生成请开始新的任务')
    return { edition: 'diy', ticket: id, commercialAllowed: true }
  })
  const claimDelivery = id => serial(async () => {
    await touch(); const task = findTask(id)
    if (task.state !== 'reserved' || task.deliveryKey) throw problem('该导出的保存已开始或已完成，请勿重复提交')
    task.deliveryKey = randomUUID(); await persist(); return task.deliveryKey
  })
  const deliveryIntent = (id, key, target, expectedBytes) => serial(async () => {
    await touch(); const task = findTask(id)
    if (task.state !== 'reserved' || !isQuotaId(key) || task.deliveryKey !== key) throw problem('导出保存凭据不匹配')
    if (typeof target !== 'string' || !path.isAbsolute(target) || expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)) throw problem('导出保存范围无效')
    task.target = target; task.expectedBytes = expectedBytes; await persist()
  })
  const abortDelivery = (id, key) => serial(async () => {
    const task = wallet.tasks.find(row => row.id === id)
    if (!task || task.state !== 'reserved' || task.deliveryKey !== key) return
    const saved = task.target ? await stat(task.target).catch(() => null) : null
    if (saved?.isFile() && saved.size > 0 && (task.expectedBytes === null || saved.size === task.expectedBytes)) completeLocal(task)
    else task.state = 'released'
    await persist()
  })
  const commit = id => serial(async () => {
    await touch(); const task = findTask(id)
    if (task.state !== 'complete') { completeLocal(task); await persist() }
    if (wallet.pending.length) await sync()
    return summarize()
  })
  const cancel = id => serial(async () => {
    const task = wallet.tasks.find(row => row.id === id)
    if (task?.state === 'reserved' && !task.deliveryKey) { task.state = 'released'; await persist() }
    return summarize()
  })
  return { edition: 'diy', status, begin, assertTicket, claimDelivery, deliveryIntent, abortDelivery, commit, cancel }
}

let defaultClient
export function diyQuotaClient() {
  if (process.env.SNAPBOARD_LICENSE_STORAGE_UNAVAILABLE === '1') throw problem('操作系统额度存储不可用，编辑和保存仍可使用')
  if (hash(accountPolicy.publicKey) !== 'f924f54444f2431e6065ea5e75ab5e95fa6623d4921faf7a205f6c8fccb2834e') throw problem('生产额度公钥不匹配')
  const directory = process.env.SNAPBOARD_DIY_CLIENT_DIR || path.join(process.env.SNAPBOARD_MERCHANT_CLIENT_DIR ||
    (process.env.SNAPBOARD_SYNC_DIR ? path.resolve('.merchant-license') : path.resolve('workspace-data/merchant-license/client')), 'diy-client')
  defaultClient ??= createDiyQuotaClient({ directory, publicKey: accountPolicy.publicKey,
    controllerUrl: process.env.SNAPBOARD_DIY_AUTH_URL || accountPolicy.controllerUrl,
    localSimulation: false,
    storageKey: process.env.SNAPBOARD_LICENSE_STORAGE_KEY ? Buffer.from(process.env.SNAPBOARD_LICENSE_STORAGE_KEY, 'base64') : undefined,
    storageKeyProvider: process.platform === 'win32' && !process.env.SNAPBOARD_LICENSE_STORAGE_KEY ? windowsLicenseStorageKey : undefined })
  return defaultClient
}
