import { createHash, createPublicKey, sign, verify, timingSafeEqual } from 'node:crypto'

export const ISSUER = 'snapboard-merchant-authority'
export const AUDIENCE = 'snapboard-merchant'
export const CAPABILITIES = ['commercial.export', 'commercial.orders']
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
export const hash = value => createHash('sha256').update(value).digest('hex')
export const equals = (a, b) => {
  const first = Buffer.from(String(a)), second = Buffer.from(String(b))
  return first.length === second.length && timingSafeEqual(first, second)
}
export function signJwt(payload, privateKey, kind) {
  const data = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'merchant-v1' })}.${encode({ ...payload, iss: ISSUER, aud: AUDIENCE, kind })}`
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`
}
export function verifyJwt(token, publicKey, kind) {
  if (typeof token !== 'string' || token.length > (kind === 'integrity' ? 10 * 1024 * 1024 : 20_000)) throw new Error('授权凭据格式无效')
  const pieces = token.split('.')
  if (pieces.length !== 3 || pieces.some(piece => !/^[a-zA-Z0-9_-]+$/.test(piece))) throw new Error('授权凭据格式无效')
  const header = JSON.parse(Buffer.from(pieces[0], 'base64url'))
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || header.kid !== 'merchant-v1'
    || !verify('RSA-SHA256', Buffer.from(pieces.slice(0, 2).join('.')), publicKey, Buffer.from(pieces[2], 'base64url'))) throw new Error('授权签名无效')
  const payload = JSON.parse(Buffer.from(pieces[1], 'base64url'))
  if (payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.kind !== kind
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp < payload.iat
    || kind !== 'integrity' && (!/^[a-f0-9-]{36}$/.test(payload.licenseId || '') || !/^[a-f0-9-]{36}$/.test(payload.deviceId || ''))) throw new Error('授权范围或时间字段无效')
  return payload
}
export function requestMessage(license, deviceId, nonce, issuedAt) {
  return Buffer.from(JSON.stringify({ action: 'verify', licenseHash: hash(license), deviceId, nonce, issuedAt }))
}
export function enrollmentMessage(device, nonce, issuedAt) {
  return Buffer.from(JSON.stringify({ action: 'account-enroll', deviceId: device.deviceId, deviceKeyHash: hash(device.publicKey), nonce, issuedAt }))
}
export function diyQuotaMessage({ device, nonce, issuedAt, completed }) {
  return Buffer.from(JSON.stringify({ action: 'diy-export-quota', deviceId: device.deviceId,
    deviceKeyHash: hash(device.publicKey), nonce, issuedAt, completed }))
}
export function validateDevice(value) {
  if (!value || !/^[a-f0-9-]{36}$/.test(value.deviceId || '') || typeof value.publicKey !== 'string' || value.publicKey.length > 2000) throw new Error('设备申请无效')
  const key = createPublicKey(value.publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('设备密钥类型无效')
  return { deviceId: value.deviceId, publicKey: key.export({ type: 'spki', format: 'pem' }).toString() }
}
