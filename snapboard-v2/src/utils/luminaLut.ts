import type { BoardTextureLutId } from '../types/geometry'

export type LuminaRgb = [number, number, number]

export interface LuminaMaterial {
  name: string
  color: string
}

export interface LuminaLutDefinition {
  id: BoardTextureLutId
  name: string
  description: string
  asset: string
  stackAsset?: string
  stackOrder?: 'top-to-bottom' | 'bottom-to-top'
  materials: LuminaMaterial[]
  layerHeight: number
  layerCount: number
}

export interface LuminaLut extends LuminaLutDefinition {
  measured: Uint8Array
  stacks: Uint8Array
  labs: Float32Array
  colorCount: number
}

export const LUMINA_LUTS: LuminaLutDefinition[] = [
  {
    id: 'aliz-petg-rybw',
    name: 'Aliz PETG · RYBW',
    description: '白 / 红 / 黄 / 蓝，1024 个 PETG 实测叠色配方',
    asset: '/lumina/luts/aliz-petg-rybw.npy',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '红色', color: '#DC143C' },
      { name: '黄色', color: '#FFE600' },
      { name: '蓝色', color: '#0064F0' },
    ],
    layerHeight: 0.08,
    layerCount: 5,
  },
  {
    id: 'aliz-petg-cmyw',
    name: 'Aliz PETG · CMYW',
    description: '白 / 青 / 品红 / 黄，1024 个 PETG 实测叠色配方',
    asset: '/lumina/luts/aliz-petg-cmyw.npy',
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
    id: 'mochuang-petg-bw',
    name: '魔创 PETG · 黑白',
    description: '白 / 黑，32 个 PETG 灰阶叠色配方',
    asset: '/lumina/luts/mochuang-petg-bw.npy',
    materials: [
      { name: '白色', color: '#FFFFFF' },
      { name: '黑色', color: '#111111' },
    ],
    layerHeight: 0.08,
    layerCount: 5,
  },
  {
    id: 'aliz-petg-5color',
    name: 'Aliz PETG · 5 色扩展',
    description: '白 / 红 / 黄 / 蓝 / 黑，2468 个双页扩展配方，6 个光学层',
    asset: '/lumina/luts/aliz-petg-5color.npy',
    stackAsset: '/lumina/luts/aliz-petg-5color-stacks.npy',
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
    id: 'aliz-petg-6color',
    name: 'Aliz PETG · 6 色 Smart 1296',
    description: '白 / 青 / 品红 / 绿 / 黄 / 黑，1296 个 PETG 实测配方',
    asset: '/lumina/luts/aliz-petg-6color.npy',
    stackAsset: '/lumina/luts/aliz-petg-6color-stacks.npy',
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
    id: 'aliz-petg-8color',
    name: 'Aliz PETG · 8 色 Max',
    description: '白 / 青 / 品红 / 黄 / 黑 / 红 / 深蓝 / 绿，2738 个 PETG 精选配方',
    asset: '/lumina/luts/aliz-petg-8color.npy',
    stackAsset: '/lumina/luts/aliz-petg-8color-stacks.npy',
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
]

const lutCache = new Map<BoardTextureLutId, Promise<LuminaLut>>()
const LEGACY_LUT_MAP: Record<string, BoardTextureLutId> = {
  'bambu-pla-rybw': 'aliz-petg-rybw',
  'bambu-pla-cmyw': 'aliz-petg-cmyw',
  'bambu-pla-bw': 'mochuang-petg-bw',
  'bambu-pla-6color': 'aliz-petg-6color',
  'bambu-pla-8color': 'aliz-petg-8color',
}

export function normalizeLuminaLutId(id: string | undefined): BoardTextureLutId {
  if (id && LUMINA_LUTS.some(item => item.id === id)) return id as BoardTextureLutId
  return (id && LEGACY_LUT_MAP[id]) || 'aliz-petg-rybw'
}

function parseNpyUint8(buffer: ArrayBuffer): { data: Uint8Array; shape: number[] } {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 12 || bytes[0] !== 0x93 || String.fromCharCode(...bytes.slice(1, 6)) !== 'NUMPY') {
    throw new Error('Lumina LUT 不是有效的 NPY 文件')
  }
  const major = bytes[6]
  const view = new DataView(buffer)
  const headerLength = major <= 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  const headerStart = major <= 1 ? 10 : 12
  const header = new TextDecoder('latin1').decode(bytes.slice(headerStart, headerStart + headerLength))
  if (!/['"]descr['"]\s*:\s*['"][|<>=]?u1['"]/.test(header)) throw new Error('当前只支持 uint8 Lumina LUT')
  const shapeMatch = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/)
  if (!shapeMatch) throw new Error('Lumina LUT 缺少 shape')
  const shape = shapeMatch[1].split(',').map(value => Number(value.trim())).filter(Number.isFinite)
  const size = shape.reduce((product, value) => product * value, 1)
  const dataStart = headerStart + headerLength
  if (dataStart + size > bytes.length) throw new Error('Lumina LUT 数据不完整')
  return { data: bytes.slice(dataStart, dataStart + size), shape }
}

function srgbToLinear(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

/** 与 Lumina 的 CIELAB 最近色逻辑一致；D65 白点。 */
export function rgbToLab([r, g, b]: LuminaRgb): LuminaRgb {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b)
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) / 1
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883
  const f = (value: number) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function hueDegrees([, a, b]: LuminaRgb): number {
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

export async function loadLuminaLut(id: BoardTextureLutId | string | undefined): Promise<LuminaLut> {
  const resolvedId = normalizeLuminaLutId(id)
  const cached = lutCache.get(resolvedId)
  if (cached) return cached
  const pending = (async () => {
    const definition = LUMINA_LUTS.find(item => item.id === resolvedId) ?? LUMINA_LUTS[0]
    const response = await fetch(definition.asset, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`Lumina LUT 读取失败 (HTTP ${response.status})`)
    const parsed = parseNpyUint8(await response.arrayBuffer())
    if (parsed.shape.at(-1) !== 3) throw new Error('Lumina LUT 的最后一维必须为 RGB')
    let measured = parsed.data
    let colorCount = measured.length / 3
    // Lumina 的部分 2 色校准板文件含 4 个定位色块；转换器只读取前 2^5 个配方。
    if (definition.id === 'mochuang-petg-bw' && colorCount > 32) {
      colorCount = 32
      measured = measured.slice(0, colorCount * 3)
    }
    let stacks: Uint8Array
    if (definition.stackAsset) {
      const stackResponse = await fetch(definition.stackAsset, { cache: 'force-cache' })
      if (!stackResponse.ok) throw new Error(`Lumina 层配方读取失败 (HTTP ${stackResponse.status})`)
      const parsedStacks = parseNpyUint8(await stackResponse.arrayBuffer())
      if (parsedStacks.shape[0] !== colorCount || parsedStacks.shape[1] !== definition.layerCount) {
        throw new Error(`Lumina 层配方形状不匹配：${parsedStacks.shape.join('×')}`)
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
      if (colorCount !== expected) throw new Error(`Lumina LUT 配方数不匹配：应为 ${expected}，实际 ${colorCount}`)
      stacks = buildStacks(colorCount, definition.materials.length, definition.layerCount)
    }
    const labs = new Float32Array(colorCount * 3)
    for (let index = 0; index < colorCount; index++) {
      const lab = rgbToLab([measured[index * 3], measured[index * 3 + 1], measured[index * 3 + 2]])
      labs.set(lab, index * 3)
    }
    return {
      ...definition,
      measured,
      stacks,
      labs,
      colorCount,
    }
  })()
  lutCache.set(resolvedId, pending)
  return pending
}

export function matchLuminaColor(color: LuminaRgb, lut: LuminaLut, hueWeight = 0): number {
  const lab = rgbToLab(color)
  const sourceHue = hueDegrees(lab)
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
      distance += hueDelta * hueDelta * 1600 * weight
    }
    if (distance < bestDistance) { best = index; bestDistance = distance }
  }
  return best
}

export function luminaMeasuredColor(lut: LuminaLut, index: number): LuminaRgb {
  const offset = Math.max(0, Math.min(lut.colorCount - 1, index)) * 3
  return [lut.measured[offset], lut.measured[offset + 1], lut.measured[offset + 2]]
}

/** stack[0] 是观看面；导出按 Z 从下到上时需要反向读取。 */
export function luminaStackMaterial(lut: LuminaLut, recipe: number, layerFromBottom: number): number {
  const layer = lut.layerCount - 1 - Math.max(0, Math.min(lut.layerCount - 1, layerFromBottom))
  const material = lut.stacks[recipe * lut.layerCount + layer]
  return material === 255 ? -1 : material
}
