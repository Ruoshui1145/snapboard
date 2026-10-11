import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { BoardTextureLutId } from '../types/geometry.ts'
import {
  makeSnapColorLut, parseSnapColorNpy, registerSnapColorLut,
  type SnapColorLut, type SnapColorMaterial,
} from './snapColorLut.ts'

const MODES = { bw: 2, rybw: 4, cmyw: 4, '5color': 5, '6color': 6, '8color': 8 } as const
type SnapColorMode = keyof typeof MODES
const RECIPE_COUNTS: Record<SnapColorMode, number> = { bw: 32, rybw: 1024, cmyw: 1024, '5color': 2468, '6color': 1296, '8color': 2738 }

export interface SnapColorPackageManifest {
  formatVersion: 1
  id: string
  revision: string
  name: string
  mode: SnapColorMode
  layerHeight: number
  layerCount: number
  stackOrder: 'top-to-bottom' | 'bottom-to-top'
  materials: SnapColorMaterial[]
  status: 'extracted' | 'verified'
  hashes: { rgb: string; stacks: string }
  process?: Record<string, unknown>
  source?: Record<string, unknown>
}

export interface SnapColorProfile extends Omit<SnapColorPackageManifest, 'formatVersion' | 'hashes'> {
  id: BoardTextureLutId
  profileId: string
  hash: string
}

interface StoredProfile {
  profile: SnapColorProfile
  measured: Uint8Array
  stacks: Uint8Array
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function npyUint8(data: Uint8Array, rows: number, cols: number): Uint8Array {
  const prefix = "{'descr': '|u1', 'fortran_order': False, 'shape': (" + rows + ', ' + cols + "), }"
  const header = strToU8(prefix + ' '.repeat((16 - (10 + prefix.length + 1) % 16) % 16) + '\n')
  const result = new Uint8Array(10 + header.length + data.length)
  result.set([0x93, 78, 85, 77, 80, 89, 1, 0, header.length & 255, header.length >> 8])
  result.set(header, 10)
  result.set(data, 10 + header.length)
  return result
}

function defaultStacks(count: number, base: number, layers: number): Uint8Array {
  const result = new Uint8Array(count * layers)
  for (let recipe = 0; recipe < count; recipe++) {
    let value = recipe
    for (let layer = layers - 1; layer >= 0; layer--) {
      result[recipe * layers + layer] = value % base
      value = Math.floor(value / base)
    }
  }
  return result
}

export function readSnapColorNpz(npz: Uint8Array): { rgbNpy: Uint8Array; stacksNpy: Uint8Array } {
  if (npz.length > 64_000_000) throw new Error('SnapColor NPZ 过大')
  const files = unzipSync(npz, { filter: file =>
    (file.name === 'rgb.npy' || file.name === 'stacks.npy') && file.originalSize <= 32_000_000 })
  if (!files['rgb.npy'] || !files['stacks.npy'] || files['rgb.npy'].length > 32_000_000 || files['stacks.npy'].length > 32_000_000) {
    throw new Error('SnapColor NPZ 缺少 rgb/stacks 或数组过大')
  }
  return { rgbNpy: files['rgb.npy'], stacksNpy: files['stacks.npy'] }
}

function validManifest(value: unknown): asserts value is SnapColorPackageManifest {
  if (!value || typeof value !== 'object') throw new Error('SnapColor manifest 无效')
  const m = value as Record<string, unknown>
  const mode = m.mode as SnapColorMode
  if (m.formatVersion !== 1 || !Object.hasOwn(MODES, mode)) throw new Error('不支持的 SnapColor 格式或颜色模式')
  if (typeof m.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(m.id)
    || typeof m.revision !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(m.revision)
    || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120) throw new Error('SnapColor 档案标识无效')
  if (!Number.isFinite(m.layerHeight) || (m.layerHeight as number) <= 0 || (m.layerHeight as number) > 1
    || m.layerCount !== (mode === '5color' ? 6 : 5)
    || (m.stackOrder !== 'top-to-bottom' && m.stackOrder !== 'bottom-to-top')) throw new Error('SnapColor 层参数无效')
  if (!Array.isArray(m.materials) || m.materials.length !== MODES[mode]
    || m.materials.some(item => !item || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(item.color))) throw new Error('SnapColor 材料映射无效')
  if (m.status !== 'extracted' && m.status !== 'verified') throw new Error('SnapColor 验证状态无效')
  const hashes = m.hashes as Record<string, unknown> | undefined
  if (!hashes || ![hashes.rgb, hashes.stacks].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('SnapColor 文件哈希无效')
  }
}

export async function readSnapColorPackage(input: Blob | ArrayBuffer | Uint8Array): Promise<StoredProfile> {
  const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer())
    : input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length > 64_000_000) throw new Error('SnapColor 校色包过大')
  const limits: Record<string, number> = { 'manifest.json': 65_536, 'rgb.npy': 32_000_000, 'stacks.npy': 32_000_000 }
  let tooLarge = false
  const files = unzipSync(bytes, { filter: file => {
    if (!Object.hasOwn(limits, file.name)) return false
    if (file.originalSize > limits[file.name]) { tooLarge = true; return false }
    return true
  } })
  if (tooLarge || !files['manifest.json'] || !files['rgb.npy'] || !files['stacks.npy']
    || Object.entries(files).some(([name, data]) => data.length > limits[name])) throw new Error('SnapColor 校色包缺少文件或文件过大')
  let manifest: unknown
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])) } catch { throw new Error('SnapColor manifest JSON 无效') }
  validManifest(manifest)
  if (await sha256(files['rgb.npy']) !== manifest.hashes.rgb || await sha256(files['stacks.npy']) !== manifest.hashes.stacks) {
    throw new Error('SnapColor 数组哈希不匹配')
  }
  const rgb = parseSnapColorNpy(files['rgb.npy'])
  const recipes = parseSnapColorNpy(files['stacks.npy'])
  if (!(rgb.data instanceof Uint8Array) || ![2, 3].includes(rgb.shape.length) || rgb.shape.at(-1) !== 3) {
    throw new Error('SnapColor RGB 数组必须为 uint8 且末维为 3')
  }
  const colorCount = rgb.data.length / 3
  if (colorCount !== RECIPE_COUNTS[manifest.mode]) throw new Error('SnapColor 配方数量与颜色模式不匹配')
  if (recipes.shape.length !== 2 || recipes.shape[0] !== colorCount || recipes.shape[1] !== manifest.layerCount) {
    throw new Error('SnapColor 层配方与 RGB 数量或层数不匹配')
  }
  const stacks = new Uint8Array(recipes.data.length)
  for (let index = 0; index < recipes.data.length; index++) {
    const material = recipes.data[index]
    if (material !== -1 && material !== 255 && (material < 0 || material >= manifest.materials.length)) {
      throw new Error(`SnapColor 第 ${index + 1} 个材料索引越界：${material}`)
    }
    stacks[index] = material < 0 ? 255 : material
  }
  if (manifest.stackOrder === 'bottom-to-top') {
    for (let recipe = 0; recipe < colorCount; recipe++) {
      const row = recipe * manifest.layerCount
      for (let layer = 0; layer < manifest.layerCount / 2; layer++) {
        const opposite = row + manifest.layerCount - 1 - layer
        const here = row + layer
        ;[stacks[here], stacks[opposite]] = [stacks[opposite], stacks[here]]
      }
    }
  }
  const hash = await sha256(bytes)
  const profile: SnapColorProfile = {
    id: `snapcolor-farm:${manifest.id}@${manifest.revision}:${hash}`,
    profileId: manifest.id,
    hash,
    revision: manifest.revision,
    name: manifest.name,
    mode: manifest.mode,
    layerHeight: manifest.layerHeight,
    layerCount: manifest.layerCount,
    stackOrder: manifest.stackOrder,
    materials: manifest.materials,
    status: manifest.status,
    process: manifest.process,
    source: manifest.source,
  }
  return { profile, measured: rgb.data, stacks }
}

export async function createSnapColorPackage(input: {
  manifest: Omit<SnapColorPackageManifest, 'formatVersion' | 'hashes'>
  rgbNpy: Uint8Array
  stacksNpy?: Uint8Array
}): Promise<Uint8Array> {
  let { manifest, rgbNpy } = input
  let stacksNpy = input.stacksNpy
  if (!stacksNpy) {
    if (!['bw', 'rybw', 'cmyw'].includes(manifest.mode) || manifest.stackOrder !== 'top-to-bottom') {
      throw new Error('此颜色模式需提供显式层配方')
    }
    const rgb = parseSnapColorNpy(rgbNpy)
    let count = rgb.data.length / 3
    // The historical BW extractor returns 32 recipes plus four positioning cells.
    if (manifest.mode === 'bw' && count === 36 && rgb.data instanceof Uint8Array) {
      manifest = { ...manifest, source: { ...manifest.source, originalRgbSha256: await sha256(rgbNpy) } }
      rgbNpy = npyUint8(rgb.data.slice(0, 32 * 3), 32, 3)
      count = 32
    }
    const base = MODES[manifest.mode]
    if (count !== base ** manifest.layerCount) throw new Error('默认配方数量与校准模式不匹配')
    stacksNpy = npyUint8(defaultStacks(count, base, manifest.layerCount), count, manifest.layerCount)
  }
  const fullManifest: SnapColorPackageManifest = {
    ...manifest,
    formatVersion: 1,
    hashes: { rgb: await sha256(rgbNpy), stacks: await sha256(stacksNpy) },
  }
  validManifest(fullManifest)
  const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(fullManifest)), 'rgb.npy': rgbNpy, 'stacks.npy': stacksNpy },
    { mtime: new Date('2000-01-01T00:00:00Z') })
  await readSnapColorPackage(bytes)
  return bytes
}

function openProfiles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('snapcolor-profiles', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('profiles', { keyPath: 'profile.id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function profileStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openProfiles()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('profiles', mode)
      const request = action(transaction.objectStore('profiles'))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { db.close() }
}

function registerStored(record: StoredProfile): SnapColorLut {
  const { profile, measured, stacks } = record
  const lut = makeSnapColorLut({
    id: profile.id,
    name: profile.name,
    description: `${profile.mode} · ${profile.revision} · ${profile.status}`,
    asset: '',
    materials: profile.materials,
    layerHeight: profile.layerHeight,
    layerCount: profile.layerCount,
  }, measured, stacks)
  registerSnapColorLut(lut)
  return lut
}

export async function importSnapColorPackage(input: Blob | ArrayBuffer | Uint8Array): Promise<SnapColorProfile> {
  const record = await readSnapColorPackage(input)
  await profileStore('readwrite', store => store.put(record))
  registerStored(record)
  return record.profile
}

export async function listSnapColorProfiles(): Promise<SnapColorProfile[]> {
  const records = await profileStore<StoredProfile[]>('readonly', store => store.getAll())
  records.forEach(registerStored)
  return records.map(record => record.profile)
}

export async function loadSnapColorPackageLut(id: BoardTextureLutId): Promise<SnapColorLut> {
  const record = await profileStore<StoredProfile | undefined>('readonly', store => store.get(id))
  if (!record) throw new Error(`找不到 SnapColor 校色档案：${id}，请重新导入对应 .snapcolor 文件`)
  return registerStored(record)
}
