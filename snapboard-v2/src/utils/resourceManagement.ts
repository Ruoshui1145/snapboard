export type ResourceDirectoryId =
  | 'part-source'
  | 'assembly-source'
  | 'project-library'
  | 'part-runtime'
  | 'assembly-runtime'

export interface ResourceManagementOverview {
  partCount: number
  partPackageCount: number
  assemblyHostCount: number
  assemblyPackageCount: number
  projectCount: number
  manufacturingExportCount: number
  issueCount: number
  managedBytes: number
}

export interface ResourceCountRow {
  id: string
  count: number
}

export interface ResourcePartCategory extends ResourceCountRow {
  label: string
}

export interface ResourcePartPackage {
  id: string
  name: string
  version: string
  author: string
  partCount: number
}

export interface ResourceAssemblyPackage {
  id: string
  name: string
  version: string
  hostCount: number
}

export interface ResourceProjectFile {
  name: string
  updatedAt: string
  sizeBytes: number
}

export interface ResourceManufacturingFile {
  name: string
  sizeBytes: number
}

export interface ManagedResourceDirectory {
  id: ResourceDirectoryId
  label: string
  relativePath: string
  purpose: string
  access: string
  exists: boolean
  sizeBytes: number
  fileCount: number
  directoryCount: number
}

export interface ResourceManagementSummary {
  generatedAt: string
  environment: 'local-development'
  overview: ResourceManagementOverview
  partLibrary: {
    generatedAt: string
    partCount: number
    packageCount: number
    calibratedCount: number
    pendingCalibrationCount: number
    connectorCount: number
    categories: ResourcePartCategory[]
    packages: ResourcePartPackage[]
    issues: string[]
  }
  assemblyLibrary: {
    generatedAt: string
    hostCount: number
    packageCount: number
    kinds: ResourceCountRow[]
    statuses: ResourceCountRow[]
    packages: ResourceAssemblyPackage[]
    validationErrors: string[]
  }
  projects: {
    files: ResourceProjectFile[]
    manufacturingExports: ResourceManufacturingFile[]
  }
  directories: ManagedResourceDirectory[]
  policy: {
    arbitraryPathsAccepted: false
    destructiveActionsAvailable: false
    note: string
  }
}

export const RESOURCE_MANAGEMENT_SUMMARY_URL = '/api/resource-management/summary'
export const ASSEMBLY_HOST_PACK_IMPORT_URL = '/api/resource-management/import-assembly-pack'

export const fetchResourceManagementSummary = async (signal?: AbortSignal): Promise<ResourceManagementSummary> => {
  const response = await fetch(RESOURCE_MANAGEMENT_SUMMARY_URL, { cache: 'no-store', signal })
  const payload = await response.json().catch(() => ({})) as Partial<ResourceManagementSummary> & { error?: string }
  if (!response.ok) throw new Error(payload.error || `资源检查失败 (${response.status})`)
  if (!payload.overview || !payload.partLibrary || !payload.assemblyLibrary || !payload.projects || !payload.policy
    || !Array.isArray(payload.directories) || !Array.isArray(payload.partLibrary.categories)
    || !Array.isArray(payload.partLibrary.packages) || !Array.isArray(payload.partLibrary.issues)
    || !Array.isArray(payload.assemblyLibrary.validationErrors) || !Array.isArray(payload.assemblyLibrary.packages)
    || !Array.isArray(payload.projects.files) || !Array.isArray(payload.projects.manufacturingExports)) {
    throw new Error('资源管理接口未返回完整数据；请使用桌面版或开发服务器。')
  }
  return payload as ResourceManagementSummary
}

export const importAssemblyHostBundle = async (file: File): Promise<{ packageId: string; hostCount: number }> => {
  if (file.size > 2 * 1024 * 1024) throw new Error('装配资源包不能超过 2 MB')
  const text = await file.text()
  let bundle: unknown
  try { bundle = JSON.parse(text) } catch { throw new Error('资源包不是有效的 JSON') }
  const record = bundle as { format?: unknown; schemaVersion?: unknown }
  if (record?.format !== 'snapboard-assembly-host-bundle' || record.schemaVersion !== 1) {
    throw new Error('请选择 SnapBoard assembly host bundle JSON')
  }
  const response = await fetch(ASSEMBLY_HOST_PACK_IMPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  })
  const payload = await response.json().catch(() => ({})) as { error?: string; packageId?: string; hostCount?: number }
  if (!response.ok) throw new Error(payload.error || `资源包导入失败 (${response.status})`)
  window.dispatchEvent(new Event('snapboard:assembly-library-updated'))
  return { packageId: payload.packageId ?? 'unknown', hostCount: Number(payload.hostCount) || 0 }
}

export const formatResourceBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export const formatResourceDate = (value: string): string => {
  if (!value) return '尚未生成'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
