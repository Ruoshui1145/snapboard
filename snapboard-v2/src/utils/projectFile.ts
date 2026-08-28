import type { PlacedPart } from '../partLibrary/types'
import type {
  Board,
  BoardTextureConfig,
  Contour,
  Feature,
  Part,
  Project,
  SplitConfig,
  SplitPanel,
  SplitResultState,
} from '../types/geometry'
import { PEGBOARD_DEFAULT_CONFIG } from './pegboardSplit'
import { createDefaultBoardTexture } from './boardTexture'
import { normalizeLuminaLutId } from './luminaLut'

export const SNAPBOARD_PROJECT_FORMAT = 'snapboard-project' as const
export const SNAPBOARD_PROJECT_SCHEMA_VERSION = 1 as const

/**
 * 可恢复编辑状态的工作区数据。命令历史、临时选择和相机位置属于会话状态，不写入项目文件。
 */
export interface ProjectWorkspaceData {
  project: Project
  boards: Board[]
  placedParts: PlacedPart[]
  boardTexture: BoardTextureConfig
  splitConfig: SplitConfig
  /** 保留派生板件及用户手动开/关孔状态；关闭自动分割时为 null。 */
  splitResult: SplitResultState | null
}

export interface SnapBoardProjectFile {
  format: typeof SNAPBOARD_PROJECT_FORMAT
  schemaVersion: typeof SNAPBOARD_PROJECT_SCHEMA_VERSION
  appVersion: string
  savedAt: string
  workspace: ProjectWorkspaceData
}

export interface SnapBoardManufacturingFile {
  format: 'snapboard-manufacturing'
  schemaVersion: 1
  exportedAt: string
  units: 'millimeter'
  project: { name: string; version: string }
  config: SplitConfig
  panels: SplitPanel[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isPoint = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x) && isFiniteNumber(value.y)
}

function isContour(value: unknown): value is Contour {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    (value.type === 'outer' || value.type === 'inner') &&
    typeof value.name === 'string' &&
    typeof value.closed === 'boolean' &&
    Array.isArray(value.points) && value.points.every(isPoint) &&
    Array.isArray(value.constraints)
}

function isFeature(value: unknown): value is Feature {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.type !== 'string') return false
  if (value.type === 'sketch') {
    return (value.plane === 'xy' || value.plane === 'xz' || value.plane === 'yz') &&
      Array.isArray(value.contours) && value.contours.every(isContour)
  }
  return value.type === 'extrude' || value.type === 'hole' || value.type === 'holePattern'
}

function isPart(value: unknown): value is Part {
  if (!isRecord(value) || !isRecord(value.material)) return false
  return typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.material.name === 'string' &&
    isFiniteNumber(value.material.thickness) &&
    Array.isArray(value.features) && value.features.every(isFeature)
}

function isProject(value: unknown): value is Project {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.config)) return false
  return typeof value.metadata.name === 'string' &&
    typeof value.metadata.author === 'string' &&
    typeof value.metadata.version === 'string' &&
    typeof value.metadata.createdAt === 'string' &&
    isFiniteNumber(value.config.pixelToMM) && value.config.pixelToMM > 0 &&
    typeof value.config.material === 'string' &&
    Array.isArray(value.parts) && value.parts.every(isPart)
}

function isBoard(value: unknown): value is Board {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.contour) && value.contour.every(isPoint) &&
    isFiniteNumber(value.thickness) &&
    isRecord(value.holePattern) &&
    isRecord(value.split) &&
    isRecord(value.position)
}

function isPlacedPart(value: unknown): value is PlacedPart {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.defId === 'string' &&
    isFiniteNumber(value.rotation) &&
    isRecord(value.params)
}

function isHolePos(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    (value.knocked === undefined || typeof value.knocked === 'boolean') &&
    (value.manual === undefined || typeof value.manual === 'boolean')
}

function isSplitPanel(value: unknown): value is SplitPanel {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    isFiniteNumber(value.w) && isFiniteNumber(value.h) &&
    Array.isArray(value.slots) && value.slots.every(isHolePos) &&
    Array.isArray(value.round_holes) && value.round_holes.every(isHolePos) &&
    Array.isArray(value.edge_holes) && value.edge_holes.every(isHolePos) &&
    (value.contour === undefined || (Array.isArray(value.contour) && value.contour.every(isPoint))) &&
    (value.cutouts === undefined || (Array.isArray(value.cutouts) && value.cutouts.every(hole => Array.isArray(hole) && hole.every(isPoint))))
}

function normalizeSplitConfig(value: unknown): SplitConfig {
  if (!isRecord(value)) throw new Error('项目缺少有效的分割参数')
  const next: SplitConfig = { ...PEGBOARD_DEFAULT_CONFIG, bedKeepouts: [] }
  for (const key of Object.keys(next).filter(key => key !== 'bedKeepouts') as Array<keyof SplitConfig>) {
    const candidate = value[key]
    const fallback = next[key]
    if (typeof fallback === 'boolean') {
      if (typeof candidate === 'boolean') (next[key] as boolean) = candidate
    } else if (typeof fallback === 'string') {
      if (typeof candidate === 'string') (next[key] as string) = candidate
    } else if (isFiniteNumber(candidate)) {
      (next[key] as number) = candidate
    }
  }
  if (Array.isArray(value.bedKeepouts)) {
    next.bedKeepouts = value.bedKeepouts.flatMap((item, index) => {
      if (!isRecord(item) || !isFiniteNumber(item.x) || !isFiniteNumber(item.y) ||
          !isFiniteNumber(item.w) || !isFiniteNumber(item.h)) return []
      return [{
        id: typeof item.id === 'string' ? item.id : `keepout-${index + 1}`,
        name: typeof item.name === 'string' ? item.name : `禁放区 ${index + 1}`,
        x: item.x, y: item.y,
        w: Math.max(0, item.w), h: Math.max(0, item.h),
        enabled: item.enabled !== false,
      }]
    })
  }
  return next
}

function normalizeBoardTexture(value: unknown): BoardTextureConfig {
  const next = createDefaultBoardTexture()
  if (!isRecord(value)) return next
  if (typeof value.enabled === 'boolean') next.enabled = value.enabled
  if (value.source === 'preset' || value.source === 'image') next.source = value.source
  if (typeof value.presetId === 'string' && value.presetId.length <= 80) next.presetId = value.presetId
  if (typeof value.imageDataUrl === 'string' && value.imageDataUrl.startsWith('data:image/') && value.imageDataUrl.length <= 32 * 1024 * 1024) {
    next.imageDataUrl = value.imageDataUrl
  }
  if (typeof value.imageName === 'string' && value.imageName.length <= 200) next.imageName = value.imageName
  if (isFiniteNumber(value.imageAspect) && value.imageAspect > 0) next.imageAspect = value.imageAspect
  if (value.fit === 'cover' || value.fit === 'contain' || value.fit === 'stretch' || value.fit === 'tile') next.fit = value.fit
  if (isFiniteNumber(value.scale)) next.scale = Math.max(10, Math.min(400, value.scale))
  if (isFiniteNumber(value.offsetX)) next.offsetX = Math.max(-100, Math.min(100, value.offsetX))
  if (isFiniteNumber(value.offsetY)) next.offsetY = Math.max(-100, Math.min(100, value.offsetY))
  if (isFiniteNumber(value.rotation)) next.rotation = Math.max(-180, Math.min(180, value.rotation))
  if (isFiniteNumber(value.opacity)) next.opacity = Math.max(0.05, Math.min(1, value.opacity))
  if (isFiniteNumber(value.brightness)) next.brightness = Math.max(0.2, Math.min(2, value.brightness))
  if (isFiniteNumber(value.contrast)) next.contrast = Math.max(0.2, Math.min(2, value.contrast))
  if (isFiniteNumber(value.saturation)) next.saturation = Math.max(0, Math.min(2, value.saturation))
  if (value.colorMode === 'original' || value.colorMode === 'mono' || value.colorMode === 'posterize') next.colorMode = value.colorMode
  if (isFiniteNumber(value.colorCount)) next.colorCount = Math.max(2, Math.min(8, Math.round(value.colorCount)))
  if (value.modelingMode === 'high-fidelity' || value.modelingMode === 'pixel' || value.modelingMode === 'vector') next.modelingMode = value.modelingMode
  if (typeof value.lutId === 'string') next.lutId = normalizeLuminaLutId(value.lutId)
  if (isFiniteNumber(value.quantizeColors)) next.quantizeColors = Math.max(2, Math.min(256, Math.round(value.quantizeColors)))
  if (isFiniteNumber(value.hueWeight)) next.hueWeight = Math.max(0, Math.min(1, value.hueWeight))
  if (typeof value.cleanup === 'boolean') next.cleanup = value.cleanup
  if (isFiniteNumber(value.textureThickness)) next.textureThickness = Math.max(0.08, Math.min(3, value.textureThickness))
  if (isFiniteNumber(value.pixelSize)) next.pixelSize = Math.max(0.4, Math.min(8, value.pixelSize))
  if (value.surfaceMode === 'lumina' || value.surfaceMode === 'veneer') next.surfaceMode = value.surfaceMode
  if (value.surfaceFinish === 'textured-pei' || value.surfaceFinish === 'smooth-top') next.surfaceFinish = value.surfaceFinish
  if (typeof value.baseMaterialName === 'string' && value.baseMaterialName.length <= 80) next.baseMaterialName = value.baseMaterialName
  if (typeof value.surfaceMaterialName === 'string' && value.surfaceMaterialName.length <= 80) next.surfaceMaterialName = value.surfaceMaterialName
  if (typeof value.baseColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.baseColor)) next.baseColor = value.baseColor.toUpperCase()
  if (typeof value.surfaceColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.surfaceColor)) next.surfaceColor = value.surfaceColor.toUpperCase()
  if (isFiniteNumber(value.baseInfillDensity)) next.baseInfillDensity = Math.max(5, Math.min(50, Math.round(value.baseInfillDensity)))
  if (next.source === 'image' && !next.imageDataUrl) next.enabled = false
  return next
}

function isSplitResult(value: unknown): value is SplitResultState {
  if (!isRecord(value)) return false
  return Array.isArray(value.sources) && value.sources.every(source =>
    isRecord(source) &&
    typeof source.contourId === 'string' &&
    typeof source.name === 'string' &&
    Array.isArray(source.panels) && source.panels.every(isSplitPanel) &&
    Array.isArray(source.warnings) && source.warnings.every(item => typeof item === 'string') &&
    isFiniteNumber(source.coverageRatio)) &&
    Array.isArray(value.panels) && value.panels.every(isSplitPanel) &&
    Array.isArray(value.warnings) && value.warnings.every(item => typeof item === 'string') &&
    isRecord(value.config) &&
    isFiniteNumber(value.ts)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createProjectFile(workspace: ProjectWorkspaceData): SnapBoardProjectFile {
  return {
    format: SNAPBOARD_PROJECT_FORMAT,
    schemaVersion: SNAPBOARD_PROJECT_SCHEMA_VERSION,
    appVersion: workspace.project.metadata.version,
    savedAt: new Date().toISOString(),
    workspace: cloneJson(workspace),
  }
}

/** 解析并校验用户选择的项目文件；旧版缺失的分割参数会按当前默认值补齐。 */
export function parseProjectFile(text: string): SnapBoardProjectFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  if (!isRecord(raw) || raw.format !== SNAPBOARD_PROJECT_FORMAT) {
    throw new Error('这不是 SnapBoard 项目文件')
  }
  if (raw.schemaVersion !== SNAPBOARD_PROJECT_SCHEMA_VERSION) {
    throw new Error(`不支持的项目版本：${String(raw.schemaVersion)}`)
  }
  if (!isRecord(raw.workspace)) throw new Error('项目工作区数据缺失')
  const workspace = raw.workspace
  if (!isProject(workspace.project)) throw new Error('项目草图数据损坏或字段不完整')
  if (!Array.isArray(workspace.boards) || !workspace.boards.every(isBoard)) throw new Error('项目演示板数据无效')
  if (!Array.isArray(workspace.placedParts) || !workspace.placedParts.every(isPlacedPart)) throw new Error('项目装配数据无效')
  if (workspace.splitResult !== null && workspace.splitResult !== undefined && !isSplitResult(workspace.splitResult)) {
    throw new Error('项目分割结果数据无效')
  }

  const splitConfig = normalizeSplitConfig(workspace.splitConfig)
  const splitResult = workspace.splitResult == null
    ? null
    : { ...workspace.splitResult, config: normalizeSplitConfig(workspace.splitResult.config) }
  return {
    format: SNAPBOARD_PROJECT_FORMAT,
    schemaVersion: SNAPBOARD_PROJECT_SCHEMA_VERSION,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : workspace.project.metadata.version,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    workspace: cloneJson({
      project: workspace.project,
      boards: workspace.boards,
      placedParts: workspace.placedParts,
      boardTexture: normalizeBoardTexture(workspace.boardTexture),
      splitConfig,
      splitResult,
    }),
  }
}

export function safeFileName(name: string): string {
  const withoutControls = [...name.trim()].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('')
  const cleaned = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '')
  return cleaned || '未命名项目'
}

export function projectFileName(name: string): string {
  return `${safeFileName(name)}.snapboard`
}

export function serializeProjectFile(workspace: ProjectWorkspaceData): string {
  return JSON.stringify(createProjectFile(workspace), null, 2)
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadProjectFile(workspace: ProjectWorkspaceData): void {
  downloadBlob(
    new Blob([serializeProjectFile(workspace)], { type: 'application/json;charset=utf-8' }),
    projectFileName(workspace.project.metadata.name),
  )
}

export interface ProjectLibraryEntry {
  name: string
  updatedAt: string
  size: number
}

export interface ProjectFileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: Blob | string): Promise<void>
    close(): Promise<void>
  }>
}

interface ProjectDirectoryEntryHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

export interface ProjectDirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  values(): AsyncIterableIterator<ProjectDirectoryEntryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ProjectFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProjectDirectoryHandle>
  queryPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied'>
}

interface ProjectFilePickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<ProjectFileHandle[]>
  showSaveFilePicker?: (options?: unknown) => Promise<ProjectFileHandle>
  showDirectoryPicker?: (options?: unknown) => Promise<ProjectDirectoryHandle>
}

const projectPickerOptions = (suggestedName?: string) => ({
  suggestedName,
  types: [{
    description: 'SnapBoard 项目',
    accept: { 'application/json': ['.snapboard'] },
  }],
  excludeAcceptAllOption: false,
})

const isPickerCancelled = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

const LOCAL_HANDLE_DB = 'snapboard-local-workspace'
const LOCAL_HANDLE_STORE = 'handles'
const LOCAL_HANDLE_KEY = 'project-directory'

function openLocalHandleDb(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_HANDLE_DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LOCAL_HANDLE_STORE)) {
        request.result.createObjectStore(LOCAL_HANDLE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function rememberLocalWorkspace(handle: ProjectDirectoryHandle): Promise<void> {
  const db = await openLocalHandleDb()
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(LOCAL_HANDLE_STORE, 'readwrite')
        .objectStore(LOCAL_HANDLE_STORE)
        .put(handle, LOCAL_HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** 恢复上次授权的本地项目目录；浏览器仍可能要求用户重新确认权限。 */
export async function restoreLocalWorkspace(): Promise<ProjectDirectoryHandle | null> {
  const db = await openLocalHandleDb().catch(() => null)
  if (!db) return null
  try {
    return await new Promise<ProjectDirectoryHandle | null>((resolve, reject) => {
      const request = db.transaction(LOCAL_HANDLE_STORE, 'readonly')
        .objectStore(LOCAL_HANDLE_STORE)
        .get(LOCAL_HANDLE_KEY)
      request.onsuccess = () => resolve((request.result as ProjectDirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

export async function ensureLocalWorkspacePermission(
  handle: ProjectDirectoryHandle,
  requestIfNeeded: boolean,
): Promise<boolean> {
  if (!handle.queryPermission) return true
  const current = await handle.queryPermission({ mode: 'readwrite' })
  if (current === 'granted') return true
  if (!requestIfNeeded || !handle.requestPermission) return false
  return await handle.requestPermission({ mode: 'readwrite' }) === 'granted'
}

/** 选择一个普通本地文件夹作为工作区，并把目录句柄保存到 IndexedDB。 */
export async function chooseLocalWorkspace(): Promise<ProjectDirectoryHandle | null | undefined> {
  const picker = (window as ProjectFilePickerWindow).showDirectoryPicker
  if (!picker) return undefined
  try {
    const handle = await picker.call(window, { id: 'snapboard-project-workspace', mode: 'readwrite' })
    await rememberLocalWorkspace(handle).catch(() => undefined)
    return handle
  } catch (error) {
    if (isPickerCancelled(error)) return null
    throw error
  }
}

export interface LocalWorkspaceProject extends ProjectLibraryEntry {
  handle: ProjectFileHandle
}

export async function listLocalWorkspaceProjects(handle: ProjectDirectoryHandle): Promise<LocalWorkspaceProject[]> {
  const files: LocalWorkspaceProject[] = []
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.snapboard')) continue
    const fileHandle = await handle.getFileHandle(entry.name)
    const file = await fileHandle.getFile()
    files.push({
      name: entry.name,
      updatedAt: new Date(file.lastModified).toISOString(),
      size: file.size,
      handle: fileHandle,
    })
  }
  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function writeProjectToLocalWorkspace(
  workspace: ProjectWorkspaceData,
  directory: ProjectDirectoryHandle,
): Promise<ProjectFileHandle> {
  const handle = await directory.getFileHandle(projectFileName(workspace.project.metadata.name), { create: true })
  await writeProjectFile(workspace, handle)
  return handle
}

export async function writeBinaryToLocalWorkspace(
  directory: ProjectDirectoryHandle,
  fileName: string,
  data: Uint8Array,
  subdirectory?: string,
): Promise<string> {
  const targetDirectory = subdirectory
    ? await directory.getDirectoryHandle(subdirectory, { create: true })
    : directory
  const handle = await targetDirectory.getFileHandle(safeFileName(fileName), { create: true })
  const writable = await handle.createWritable()
  await writable.write(new Blob([data as BlobPart], { type: 'model/3mf' }))
  await writable.close()
  return subdirectory ? `${directory.name}/${subdirectory}/${handle.name}` : `${directory.name}/${handle.name}`
}

/** 将项目写入用户通过“另存为”选择的位置；支持后续覆盖同一文件。 */
export async function writeProjectFile(
  workspace: ProjectWorkspaceData,
  handle: ProjectFileHandle,
): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(new Blob([serializeProjectFile(workspace)], { type: 'application/json;charset=utf-8' }))
  await writable.close()
}

/** 系统“另存为”。不支持 File System Access API 的浏览器返回 null，由调用方回退到下载。 */
export async function saveProjectFileAs(
  workspace: ProjectWorkspaceData,
): Promise<ProjectFileHandle | null> {
  const picker = (window as ProjectFilePickerWindow).showSaveFilePicker
  if (!picker) return null
  try {
    const handle = await picker.call(window, projectPickerOptions(projectFileName(workspace.project.metadata.name)))
    await writeProjectFile(workspace, handle)
    return handle
  } catch (error) {
    if (isPickerCancelled(error)) return null
    throw error
  }
}

/** 为制造文件打开系统“另存为”；undefined 表示浏览器不支持，null 表示用户取消。 */
export async function saveManufacturingFileAs(
  data: Uint8Array,
  suggestedName: string,
): Promise<ProjectFileHandle | null | undefined> {
  const picker = (window as ProjectFilePickerWindow).showSaveFilePicker
  if (!picker) return undefined
  try {
    const handle = await picker.call(window, {
      suggestedName: safeFileName(suggestedName),
      types: [{ description: '3MF 制造文件', accept: { 'model/3mf': ['.3mf'] } }],
      excludeAcceptAllOption: false,
    })
    const writable = await handle.createWritable()
    await writable.write(new Blob([data as BlobPart], { type: 'model/3mf' }))
    await writable.close()
    return handle
  } catch (error) {
    if (isPickerCancelled(error)) return null
    throw error
  }
}

const projectStorageApiBase = (import.meta.env.VITE_PROJECT_STORAGE_API_BASE as string | undefined)?.trim().replace(/\/$/, '')
  || '/api/project-library'

/**
 * 本地开发时指向 Vite 的文件 API；云端部署时设置 VITE_PROJECT_STORAGE_API_BASE，
 * 即可把相同的保存、列表、打开和制造导出调用切到服务器对象存储/数据库。
 */
export const PROJECT_STORAGE_API_BASE = projectStorageApiBase

const projectStorageUrl = (path: string) => `${PROJECT_STORAGE_API_BASE}${path}`

/** 本地工作流的默认项目库；静态部署没有该 API 时返回 false。 */
export async function saveProjectToLibrary(workspace: ProjectWorkspaceData): Promise<boolean> {
  const response = await fetch(projectStorageUrl(`/save?filename=${encodeURIComponent(projectFileName(workspace.project.metadata.name))}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: serializeProjectFile(workspace),
  }).catch(() => null)
  if (!response || response.status === 404) return false
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `默认项目库保存失败 (HTTP ${response.status})`)
  }
  return true
}

export async function listProjectLibrary(): Promise<ProjectLibraryEntry[] | null> {
  const response = await fetch(projectStorageUrl('/list'), { cache: 'no-store' }).catch(() => null)
  if (!response || response.status === 404) return null
  if (!response.ok) throw new Error(`项目库读取失败 (HTTP ${response.status})`)
  const body = await response.json() as { files?: ProjectLibraryEntry[] }
  return Array.isArray(body.files) ? body.files : []
}

export async function readProjectFromLibrary(fileName: string): Promise<SnapBoardProjectFile> {
  const response = await fetch(projectStorageUrl(`/open?filename=${encodeURIComponent(fileName)}`), { cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `项目打开失败 (HTTP ${response.status})`)
  }
  return parseProjectFile(await response.text())
}

/** 将 3MF 写入本地开发项目库的“制造导出”子目录；云端使用同名二进制端点。 */
export async function saveManufacturingToLibrary(fileName: string, data: Uint8Array): Promise<string | null> {
  const response = await fetch(projectStorageUrl(`/export?filename=${encodeURIComponent(safeFileName(fileName))}`), {
    method: 'POST',
    headers: { 'Content-Type': 'model/3mf' },
    body: data as BodyInit,
  }).catch(() => null)
  if (!response || response.status === 404) return null
  const body = await response.json().catch(() => ({})) as { error?: string; folder?: string; filename?: string }
  if (!response.ok) throw new Error(body.error || `制造文件保存失败 (HTTP ${response.status})`)
  return [body.folder, body.filename].filter(Boolean).join('/') || fileName
}

export function downloadManufacturingJSON(
  project: Project,
  panels: SplitPanel[],
  config: SplitConfig,
): void {
  if (!panels.length) throw new Error('没有可导出的分割板件')
  const payload: SnapBoardManufacturingFile = {
    format: 'snapboard-manufacturing',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    units: 'millimeter',
    project: { name: project.metadata.name, version: project.metadata.version },
    config: cloneJson(config),
    panels: cloneJson(panels),
  }
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
    `${safeFileName(project.metadata.name)}-板件清单.json`,
  )
}

/** 浏览器安全文件选择器；取消选择时返回 null。 */
export async function chooseProjectFile(): Promise<{ file: File; handle: ProjectFileHandle | null } | null> {
  const picker = (window as ProjectFilePickerWindow).showOpenFilePicker
  if (picker) {
    try {
      const handles = await picker.call(window, projectPickerOptions())
      const handle = handles[0]
      return handle ? { file: await handle.getFile(), handle } : null
    } catch (error) {
      if (isPickerCancelled(error)) return null
      throw error
    }
  }
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.snapboard,application/json'
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file ? { file, handle: null } : null)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null
      finish(file)
    }, { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}
