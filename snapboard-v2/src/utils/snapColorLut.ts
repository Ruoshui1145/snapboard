import type { BoardTextureLutId } from '../types/geometry.ts'

export type SnapColorRgb = [number, number, number]

export interface SnapColorMaterial {
  name: string
  color: string
}

export interface SnapColorLutDefinition {
  id: BoardTextureLutId
  name: string
  description: string
  asset: string
  stackAsset?: string
  stackOrder?: 'top-to-bottom' | 'bottom-to-top'
  materials: SnapColorMaterial[]
  layerHeight: number
  layerCount: number
}

export interface SnapColorLut extends SnapColorLutDefinition {
  measured: Uint8Array
  stacks: Uint8Array
  labs: Float32Array
  colorCount: number
}

/** RYBW 四色槽位（白 / 红 / 黄 / 蓝），各品牌 PETG 档案共用。 */
const RYBW_MATERIALS: SnapColorMaterial[] = [
  { name: '白色', color: '#FFFFFF' },
  { name: '红色', color: '#DC143C' },
  { name: '黄色', color: '#FFE600' },
  { name: '蓝色', color: '#0064F0' },
]

/** 品牌 PETG RYBW 档案的公共定义：1024 配方（32×32 网格），5 个 0.08mm 光学层。 */
const brandPetgRybw = (id: BoardTextureLutId, name: string, brand: string): SnapColorLutDefinition => ({
  id,
  name,
  description: `白 / 红 / 黄 / 蓝，1024 个 ${brand} 实测叠色配方`,
  asset: `/snapcolor/luts/${id}.npy`,
  materials: RYBW_MATERIALS.map(item => ({ ...item })),
  layerHeight: 0.08,
  layerCount: 5,
})

export const SNAPCOLOR_LUTS: SnapColorLutDefinition[] = [
  {
    id: 'snapcolor-petg-rybw',
    name: 'Aliz PETG · RYBW',
    description: '白 / 红 / 黄 / 蓝，1024 个 Aliz PETG 实测叠色配方',
    asset: '/snapcolor/luts/snapcolor-petg-rybw.npy',
    materials: RYBW_MATERIALS.map(item => ({ ...item })),
    layerHeight: 0.08,
    layerCount: 5,
  },
  {
    id: 'snapcolor-petg-cmyw',
    name: 'Aliz PETG · CMYW',
    description: '白 / 青 / 品红 / 黄，1024 个 Aliz PETG 实测叠色配方',
    asset: '/snapcolor/luts/snapcolor-petg-cmyw.npy',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '青色', color: '#00FFFF' },
      { name: '品红', color: '#FF00FF' },
      { name: '黄色', color: '#FFFF00' },
    ],
    layerHeight: 0.08,
    layerCount: 5,
  },
  {
    id: 'snapcolor-petg-bw',
    name: '魔创 PETG · 黑白',
    description: '白 / 黑，32 个魔创 PETG 灰阶叠色配方',
    asset: '/snapcolor/luts/snapcolor-petg-bw.npy',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '黑色', color: '#111111' },
    ],
    layerHeight: 0.08,
    layerCount: 5,
  },
  {
    id: 'snapcolor-petg-5color',
    name: 'Aliz PETG · 5 色扩展',
    description: '白 / 红 / 黄 / 蓝 / 黑，2468 个 Aliz PETG 双页扩展配方，6 个光学层',
    asset: '/snapcolor/luts/snapcolor-petg-5color.npy',
    stackAsset: '/snapcolor/luts/snapcolor-petg-5color-stacks.npy',
    stackOrder: 'top-to-bottom',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '红色', color: '#DC143C' },
      { name: '黄色', color: '#FFFF00' },
      { name: '蓝色', color: '#0064F0' },
      { name: '黑色', color: '#000000' },
    ],
    layerHeight: 0.08,
    layerCount: 6,
  },
  {
    id: 'snapcolor-petg-6color',
    name: 'Aliz PETG · 6 色 Smart 1296',
    description: '白 / 青 / 品红 / 绿 / 黄 / 黑，1296 个 Aliz PETG 实测配方',
    asset: '/snapcolor/luts/snapcolor-petg-6color.npy',
    stackAsset: '/snapcolor/luts/snapcolor-petg-6color-stacks.npy',
    stackOrder: 'top-to-bottom',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '青色', color: '#00FFFF' },
      { name: '品红', color: '#FF00FF' },
      { name: '绿色', color: '#00AE42' },
      { name: '黄色', color: '#FFFF00' },
      { name: '黑色', color: '#000000' },
    ],
    layerHeight: 0.08,
    layerCount: 5,
  },
  {
    id: 'snapcolor-petg-8color',
    name: 'Aliz PETG · 8 色 Max',
    description: '白 / 青 / 品红 / 黄 / 黑 / 红 / 深蓝 / 绿，2738 个 Aliz PETG 精选配方',
    asset: '/snapcolor/luts/snapcolor-petg-8color.npy',
    stackAsset: '/snapcolor/luts/snapcolor-petg-8color-stacks.npy',
    stackOrder: 'bottom-to-top',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '青色', color: '#00FFFF' },
      { name: '品红', color: '#FF00FF' },
      { name: '黄色', color: '#FFFF00' },
      { name: '黑色', color: '#000000' },
      { name: '红色', color: '#C12E1F' },
      { name: '深蓝', color: '#0A2989' },
      { name: '绿色', color: '#00AE42' },
    ],
    layerHeight: 0.08,
    layerCount: 5,
  },
  brandPetgRybw('snapcolor-petg-coobeen-rybw', 'CooBeen PETG · RYBW', 'CooBeen PETG'),
  brandPetgRybw('snapcolor-petg-kynix-rybw', 'KYNIX PETG · RYBW', 'KYNIX PETG'),
  brandPetgRybw('snapcolor-petg-sunlu-rybw', '三绿 PETG · RYBW', '三绿 PETG'),
  brandPetgRybw('snapcolor-petg-tianrui-rybw', '天瑞 PETG ECO · RYBW', '天瑞 PETG ECO'),
  brandPetgRybw('snapcolor-petg-biying-rybw', '必应 PETG HF · RYBW', '必应 PETG HF'),
  {
    ...brandPetgRybw('snapcolor-petg-generic-rybw', '通用 PETG · RYBW', '通用 PETG'),
    description: '白 / 红 / 黄 / 蓝，1024 个通用叠色配方；非特定品牌实测、存在色差，仅作过渡，建议尽快校自己的档案',
  },
]

const lutCache = new Map<BoardTextureLutId, Promise<SnapColorLut>>()
const LEGACY_LUT_MAP: Record<string, BoardTextureLutId> = {
  'bambu-pla-rybw': 'snapcolor-petg-rybw',
  'bambu-pla-cmyw': 'snapcolor-petg-cmyw',
  'bambu-pla-bw': 'snapcolor-petg-bw',
  'bambu-pla-6color': 'snapcolor-petg-6color',
  'bambu-pla-8color': 'snapcolor-petg-8color',
  'aliz-petg-rybw': 'snapcolor-petg-rybw',
  'aliz-petg-cmyw': 'snapcolor-petg-cmyw',
  'mochuang-petg-bw': 'snapcolor-petg-bw',
  'aliz-petg-5color': 'snapcolor-petg-5color',
  'aliz-petg-6color': 'snapcolor-petg-6color',
  'aliz-petg-8color': 'snapcolor-petg-8color',
}

export function normalizeSnapColorLutId(id: string | undefined): BoardTextureLutId {
  if (!id) return 'snapcolor-petg-rybw'
  return LEGACY_LUT_MAP[id] || id as BoardTextureLutId
}

export function parseSnapColorNpy(buffer: ArrayBuffer | Uint8Array): { data: Uint8Array | Int32Array; shape: number[] } {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length < 12 || bytes[0] !== 0x93 || String.fromCharCode(...bytes.slice(1, 6)) !== 'NUMPY') {
    throw new Error('SnapColor LUT 不是有效的 NPY 文件')
  }
  const major = bytes[6]
  if (major < 1 || major > 3) throw new Error('不支持的 NPY 版本')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = major <= 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  const headerStart = major <= 1 ? 10 : 12
  if (headerStart + headerLength > bytes.length) throw new Error('SnapColor LUT 文件头不完整')
  const header = new TextDecoder('latin1').decode(bytes.slice(headerStart, headerStart + headerLength))
  const dtype = header.match(/['"]descr['"]\s*:\s*['"]([<>|=]?[uiO]\d+)['"]/)?.[1]
  if (!dtype || !['|u1', '<u1', 'u1', '<i4', '=i4', '>i4'].includes(dtype)) throw new Error('仅支持无 pickle 的 uint8/int32 SnapColor 数组')
  if (!/['"]fortran_order['"]\s*:\s*False/.test(header)) throw new Error('不支持 Fortran 顺序的 SnapColor 数组')
  const shapeMatch = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/)
  if (!shapeMatch) throw new Error('SnapColor LUT 缺少 shape')
  const shape = shapeMatch[1].split(',').map(value => value.trim()).filter(Boolean).map(Number)
  if (!shape.length || shape.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('SnapColor LUT shape 无效')
  const size = shape.reduce((product, value) => product * value, 1)
  const dataStart = headerStart + headerLength
  const width = dtype.endsWith('i4') ? 4 : 1
  if (size > 10_000_000 || dataStart + size * width !== bytes.length) throw new Error('SnapColor LUT 数据大小不匹配')
  if (width === 1) return { data: bytes.slice(dataStart), shape }
  const data = new Int32Array(size)
  for (let index = 0; index < size; index++) data[index] = view.getInt32(dataStart + index * 4, dtype !== '>i4')
  return { data, shape }
}

function parseNpyUint8(buffer: ArrayBuffer): { data: Uint8Array; shape: number[] } {
  const parsed = parseSnapColorNpy(buffer)
  if (!(parsed.data instanceof Uint8Array)) throw new Error('内置 SnapColor LUT 必须为 uint8')
  return { data: parsed.data, shape: parsed.shape }
}

function srgbToLinear(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

/** SnapColor CIELAB 最近色逻辑；D65 白点。 */
export function rgbToLab([r, g, b]: SnapColorRgb): SnapColorRgb {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b)
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) / 1
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883
  const f = (value: number) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function hueDegrees([, a, b]: SnapColorRgb): number {
  const angle = Math.atan2(b, a) * 180 / Math.PI
  return angle < 0 ? angle + 360 : angle
}

function buildStacks(count: number, base: number, layers: number): Uint8Array {
  const stacks = new Uint8Array(count * layers)
  for (let index = 0; index < count; index++) {
    let value = index
    for (let layer = layers - 1; layer >= 0; layer--) {
      stacks[index * layers + layer] = value % base
      value = Math.floor(value / base)
    }
  }
  return stacks
}

export function registerSnapColorLut(lut: SnapColorLut): void {
  if (!lut.id.startsWith('snapcolor-farm:')) throw new Error('只允许注册农场 SnapColor 档案')
  const index = SNAPCOLOR_LUTS.findIndex(item => item.id === lut.id)
  if (index < 0) SNAPCOLOR_LUTS.push(lut)
  else SNAPCOLOR_LUTS[index] = lut
  lutCache.set(lut.id, Promise.resolve(lut))
}

export function makeSnapColorLut(definition: SnapColorLutDefinition, measured: Uint8Array, stacks: Uint8Array): SnapColorLut {
  const colorCount = measured.length / 3
  const labs = new Float32Array(measured.length)
  for (let index = 0; index < colorCount; index++) {
    labs.set(rgbToLab([measured[index * 3], measured[index * 3 + 1], measured[index * 3 + 2]]), index * 3)
  }
  return { ...definition, measured, stacks, labs, colorCount }
}

export async function loadSnapColorLut(id: BoardTextureLutId | string | undefined): Promise<SnapColorLut> {
  const resolvedId = normalizeSnapColorLutId(id)
  const cached = lutCache.get(resolvedId)
  if (cached) return cached
  if (resolvedId.startsWith('snapcolor-farm:')) return (await import('./snapColorPackage.ts')).loadSnapColorPackageLut(resolvedId)
  const pending = (async () => {
    const definition = SNAPCOLOR_LUTS.find(item => item.id === resolvedId)
    if (!definition) throw new Error(`找不到 SnapColor 档案：${resolvedId}`)
    const response = await fetch(definition.asset, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`SnapColor LUT 读取失败 (HTTP ${response.status})`)
    const parsed = parseNpyUint8(await response.arrayBuffer())
    if (parsed.shape.at(-1) !== 3) throw new Error('SnapColor LUT 的最后一维必须为 RGB')
    let measured = parsed.data
    let colorCount = measured.length / 3
    // 早期 2 色校准板文件含 4 个定位色块；SnapColor 只读取前 2^5 个配方。
    if (definition.id === 'snapcolor-petg-bw' && colorCount > 32) {
      colorCount = 32
      measured = measured.slice(0, colorCount * 3)
    }
    let stacks: Uint8Array
    if (definition.stackAsset) {
      const stackResponse = await fetch(definition.stackAsset, { cache: 'force-cache' })
      if (!stackResponse.ok) throw new Error(`SnapColor 层配方读取失败 (HTTP ${stackResponse.status})`)
      const parsedStacks = parseNpyUint8(await stackResponse.arrayBuffer())
      if (parsedStacks.shape[0] !== colorCount || parsedStacks.shape[1] !== definition.layerCount) {
        throw new Error(`SnapColor 层配方形状不匹配：${parsedStacks.shape.join('×')}`)
      }
      stacks = parsedStacks.data
      if (definition.stackOrder === 'bottom-to-top') {
        const reversed = new Uint8Array(stacks.length)
        for (let recipe = 0; recipe < colorCount; recipe++) for (let layer = 0; layer < definition.layerCount; layer++) {
          reversed[recipe * definition.layerCount + layer] = stacks[recipe * definition.layerCount + definition.layerCount - 1 - layer]
        }
        stacks = reversed
      }
    } else {
      const expected = definition.materials.length ** definition.layerCount
      if (colorCount !== expected) throw new Error(`SnapColor LUT 配方数不匹配：应为 ${expected}，实际 ${colorCount}`)
      stacks = buildStacks(colorCount, definition.materials.length, definition.layerCount)
    }
    return makeSnapColorLut(definition, measured, stacks)
  })()
  lutCache.set(resolvedId, pending)
  pending.catch(() => lutCache.delete(resolvedId))
  return pending
}

export function matchSnapColor(color: SnapColorRgb, lut: SnapColorLut, hueWeight = 0): number {
  const lab = rgbToLab(color)
  const sourceHue = hueDegrees(lab)
  // Hue is unstable around the neutral axis. Do not amplify tiny RGB/JPEG noise
  // in pale skin, whites or greys into a large hue penalty.
  const chromaReliability = (a: number, b: number) => Math.max(0, Math.min(1, (Math.hypot(a, b) - 4) / 16))
  const sourceReliability = chromaReliability(lab[1], lab[2])
  let best = 0
  let bestDistance = Infinity
  const weight = Math.max(0, Math.min(1, hueWeight))
  for (let index = 0; index < lut.colorCount; index++) {
    const offset = index * 3
    const dl = lab[0] - lut.labs[offset]
    const da = lab[1] - lut.labs[offset + 1]
    const db = lab[2] - lut.labs[offset + 2]
    let distance = dl * dl + da * da + db * db
    if (weight > 0) {
      const targetHue = hueDegrees([lut.labs[offset], lut.labs[offset + 1], lut.labs[offset + 2]])
      const hueDelta = Math.min(Math.abs(sourceHue - targetHue), 360 - Math.abs(sourceHue - targetHue)) / 180
      distance += hueDelta * hueDelta * 1600 * weight * sourceReliability * chromaReliability(lut.labs[offset + 1], lut.labs[offset + 2])
    }
    if (distance < bestDistance) { best = index; bestDistance = distance }
  }
  return best
}

export function snapColorMeasuredColor(lut: SnapColorLut, index: number): SnapColorRgb {
  const offset = Math.max(0, Math.min(lut.colorCount - 1, index)) * 3
  return [lut.measured[offset], lut.measured[offset + 1], lut.measured[offset + 2]]
}

/** stack[0] 是观看面；导出按 Z 从下到上时需要反向读取。 */
export function snapColorStackMaterial(lut: SnapColorLut, recipe: number, layerFromBottom: number): number {
  const layer = lut.layerCount - 1 - Math.max(0, Math.min(lut.layerCount - 1, layerFromBottom))
  const material = lut.stacks[recipe * lut.layerCount + layer]
  return material === 255 ? -1 : material
}
