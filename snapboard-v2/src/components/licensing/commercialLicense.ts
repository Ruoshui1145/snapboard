import { useSyncExternalStore } from 'react'

export interface CommercialLicenseStatus { edition?: 'diy' | 'farm'; status: string; message: string; commercialAllowed: boolean; capabilities: string[]; validUntil: string | null; contractExpiresAt?: string | null; accountId?: string | null; licenseType?: 'account' | 'legacy' | null; offlineHours?: number | null; detail?: string; localSimulation: boolean; storageProtection: string;
  quota?: { day: string; unmetered?: boolean; limit: number | null; used: number; remaining: number | null; reserved: number; pendingSync: number; offline: boolean; applicationUrl: string } }
let currentStatus: CommercialLicenseStatus | null = null
const listeners = new Set<() => void>()
export const publishCommercialLicense = (value: CommercialLicenseStatus) => { currentStatus = value; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useCommercialLicense = () => useSyncExternalStore(subscribe, () => currentStatus, () => null)
export async function readCommercialLicense(force = false) {
  try {
    const response = await fetch('/api/merchant-license' + (force ? '?refresh=1' : ''), { cache: 'no-store' })
    const value = await response.json() as CommercialLicenseStatus & { error?: string }
    if (!response.ok) throw new Error(value.error || '授权状态读取失败')
    publishCommercialLicense(value); return value
  } catch (error) {
    publishCommercialLicense({ status: 'invalid', message: error instanceof Error ? error.message : '授权状态读取失败', commercialAllowed: false,
      capabilities: [], validUntil: null, localSimulation: false, storageProtection: 'unavailable' })
    throw error
  }
}
export async function requireCommercialAuthorization() {
  const value = await readCommercialLicense(true)
  if (!value.commercialAllowed || !value.capabilities.includes('commercial.export')) throw new Error(`${value.message || '商用授权不可用'}；图纸保存及历史数据访问不受影响`)
}
async function quotaAction(action: string, ticket?: string) {
  const response = await fetch('/api/merchant-license/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ticket ? { ticket } : {}) })
  const value = await response.json() as { error?: string; code?: string; ticket?: string; status?: unknown }
  if (!response.ok) {
    window.dispatchEvent(new Event('snapboard:open-export-quota'))
    throw Object.assign(new Error(value.error || '导出额度操作失败'), { code: value.code || 'DIY_QUOTA_REQUIRED' })
  }
  const status = typeof value.status === 'object' ? value.status : value as unknown as CommercialLicenseStatus
  const checked = status as CommercialLicenseStatus
  if (!checked || checked.edition !== 'diy' || !checked.quota || typeof checked.status !== 'string'
    || action === 'begin-export' && !/^[a-f0-9-]{36}$/.test(value.ticket || '')) throw Object.assign(new Error('额度响应不完整，请重试'), { code: 'DIY_QUOTA_INVALID' })
  publishCommercialLicense(checked)
  return value
}
export async function beginManufacturingAuthorization(): Promise<string | undefined> {
  const status = await readCommercialLicense(true)
  if (import.meta.env.VITE_SNAPBOARD_EDITION === 'diy' && status.edition !== 'diy') throw Object.assign(new Error('DIY 页面与本机服务的发行配置不一致，请使用对应的DIY启动入口'), { code: 'DIY_QUOTA_EDITION' })
  if (status.edition === 'diy') return (await quotaAction('begin-export')).ticket
  if (!status.commercialAllowed || !status.capabilities.includes('commercial.export')) throw new Error(`${status.message || '商用授权不可用'}；图纸保存及历史数据访问不受影响`)
}
export async function completeManufacturingAuthorization(ticket?: string) { if (ticket) await quotaAction('complete-export', ticket) }
export async function cancelManufacturingAuthorization(ticket?: string) { if (ticket) await quotaAction('cancel-export', ticket) }
