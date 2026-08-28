import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { strToU8, zipSync } from 'fflate'
import type { BoardTextureConfig, Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import type { PartDefinition, PartLibraryIndex, PlacedPart } from '../partLibrary/types'
import { createSplitPanelShape, generateSplitPanelMesh } from './boardMesh'
import { applyPartParams, loadPrintablePartModel } from './glbLoader'
import { findFootprintPlacement, getEnabledKeepouts, getPrintBedBounds, polygonIntersectsRect } from './printBed.js'
import luminaBambuConfigTemplate from '../../../vendor/lumina-studio/runtime-template/bambu_config_template.json?raw'
import { getBambuPrinterPreset } from './bambuPrinterPresets'
import { createBoardTextureCanvas, createDefaultBoardTexture, getSplitPanelTextureBounds } from './boardTexture'
import { loadLuminaLut, luminaStackMaterial, matchLuminaColor, type LuminaLut, type LuminaRgb } from './luminaLut'

interface PrintableMesh {
  name: string
  vertices: Array<[number, number, number]>
  triangles: Array<[number, number, number]>
}

interface LayoutPosition {
  x: number
  y: number
  rotation: number
}

const number = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error('模型包含无效坐标')
  return String(Number(value.toFixed(6)))
}

const escapeXml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

/** 按热床宽度做简单货架排版；对象保持独立，切片软件仍可再次自动排版。 */
function layoutPanels(panels: SplitPanel[], bedW: number): LayoutPosition[] {
  const gap = 10
  const maxRowW = Math.max(1, bedW)
  let x = 0
  let y = 0
  let rowH = 0
  return panels.map(panel => {
    const rotation = ((panel.printRotation ?? 0) % 360 + 360) % 360
    const quarterTurn = rotation === 90 || rotation === 270
    const width = quarterTurn ? panel.h : panel.w
    const height = quarterTurn ? panel.w : panel.h
    if (x > 0 && x + width > maxRowW + 1e-6) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    const position = { x, y, rotation }
    x += width + gap
    rowH = Math.max(rowH, height)
    return position
  })
}

function rotateLocal(x: number, y: number, panel: SplitPanel, rotation: number): [number, number] {
  if (rotation === 90) return [y, panel.w - x]
  if (rotation === 180) return [panel.w - x, panel.h - y]
  if (rotation === 270) return [panel.h - y, x]
  if (rotation !== 0) {
    const angle = rotation * Math.PI / 180
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]
  }
  return [x, y]
}

/** 将一个板件 Object3D 压成仅含位置和索引的制造网格。 */
function collectPanelMesh(root: THREE.Object3D, panel: SplitPanel, layout: LayoutPosition): PrintableMesh {
  const vertices: Array<[number, number, number]> = []
  const triangles: Array<[number, number, number]> = []
  root.updateMatrixWorld(true)

  root.traverse(object => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (!mesh.isMesh || object.userData.previewOnly || !mesh.geometry?.getAttribute('position')) return

    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position') geometry.deleteAttribute(name)
    }
    geometry.morphAttributes = {}
    const indexed = mergeVertices(geometry, 1e-5)
    const position = indexed.getAttribute('position') as THREE.BufferAttribute
    const base = vertices.length
    for (let i = 0; i < position.count; i++) {
      const localX = position.getX(i) - panel.x
      const localY = position.getY(i) - panel.y
      const [rx, ry] = rotateLocal(localX, localY, panel, layout.rotation)
      vertices.push([rx + layout.x, ry + layout.y, position.getZ(i)])
    }

    const index = indexed.getIndex()
    const count = index?.count ?? position.count
    for (let i = 0; i + 2 < count; i += 3) {
      const a = base + (index ? index.getX(i) : i)
      const b = base + (index ? index.getX(i + 1) : i + 1)
      const c = base + (index ? index.getX(i + 2) : i + 2)
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c])
    }
    geometry.dispose()
    indexed.dispose()
  })

  if (!vertices.length || !triangles.length) throw new Error(`${panel.id.toUpperCase()} 没有可导出的实体网格`)
  validateClosedMesh(panel.id.toUpperCase(), triangles)
  return { name: panel.id.toUpperCase(), vertices, triangles }
}

/** 每条无向边必须恰好被两个三角形共享，防止把开放渲染面写入制造文件。 */
function validateClosedMesh(name: string, triangles: Array<[number, number, number]>): void {
  const edges = new Map<string, number>()
  const add = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  for (const [a, b, c] of triangles) {
    add(a, b)
    add(b, c)
    add(c, a)
  }
  const invalid = [...edges.values()].filter(count => count !== 2).length
  if (invalid) throw new Error(`${name} 网格未完全封闭（${invalid} 条异常边），已阻止导出`)
}

function modelXml(meshes: PrintableMesh[]): string {
  const objects = meshes.map((mesh, index) => `
    <object id="${index + 1}" type="model" name="${escapeXml(mesh.name)}">
      <mesh>
        <vertices>${mesh.vertices.map(([x, y, z]) => `
          <vertex x="${number(x)}" y="${number(y)}" z="${number(z)}"/>`).join('')}
        </vertices>
        <triangles>${mesh.triangles.map(([v1, v2, v3]) => `
          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join('')}
        </triangles>
      </mesh>
    </object>`).join('')
  const build = meshes.map((_, index) => `
    <item objectid="${index + 1}"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">SnapBoard 分割板件</metadata>
  <metadata name="Application">SnapBoard</metadata>
  <resources>${objects}
  </resources>
  <build>${build}
  </build>
</model>`
}

/** 生成标准 OPC/3MF 文件；每块分割板是一个独立可打印对象。 */
export function createSplitPanels3MF(panels: SplitPanel[], cfg: SplitConfig): Uint8Array {
  if (!panels.length) throw new Error('没有可导出的分割板件')
  const layouts = layoutPanels(panels, cfg.bedW)
  const meshes = panels.map((panel, index) => {
    const root = generateSplitPanelMesh({
      panel,
      cfg,
      color: 0x3ec6b0,
      curveSegments: 48,
      includeGuides: false,
      manufacturingChamfer: cfg.manufacturingChamfer,
    })
    try {
      return collectPanelMesh(root, panel, layouts[index])
    } finally {
      root.traverse(object => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach(item => item.dispose())
        else material?.dispose()
      })
    }
  })

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    '3D/3dmodel.model': strToU8(modelXml(meshes)),
  }, { level: 6 })
}

export function downloadSplitPanels3MF(panels: SplitPanel[], cfg: SplitConfig, projectName = 'SnapBoard'): void {
  const data = createSplitPanels3MF(panels, cfg)
  const blob = new Blob([data as BlobPart], { type: 'model/3mf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, '')
  const withoutControls = [...projectName.trim()].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('')
  const safeName = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '') || 'SnapBoard'
  link.href = url
  link.download = `${safeName}-${stamp}.3mf`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

interface ManufacturingObject {
  key: string
  name: string
  mesh: PrintableMesh
  parts: ManufacturingPart[]
  preferredRotation: number
  quantity: number
  kind: 'panel' | 'part'
}

interface ManufacturingPart {
  name: string
  mesh: PrintableMesh
  extruder: number
  color: string
  /** Bambu Studio 的 part 级参数覆盖；用于把结构基材与 Lumina/贴面层分开切片。 */
  settings?: Record<string, string>
}

interface PackedInstance {
  objectKey: string
  objectId: number
  instanceId: number
  identifyId: number
  name: string
  plate: number
  rotation: number
  x: number
  y: number
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number }
}

interface BuildPlate {
  index: number
  kind: 'panel' | 'part'
  instances: PackedInstance[]
}

export interface Manufacturing3MFSummary {
  data: Uint8Array
  plateCount: number
  panelCount: number
  partCount: number
  uniqueObjectCount: number
  warnings: string[]
}

export interface Manufacturing3MFInput {
  panels: SplitPanel[]
  cfg: SplitConfig
  placedParts: PlacedPart[]
  projectName?: string
  partDefinitions?: PartDefinition[]
  boardTexture?: BoardTextureConfig
  signal?: AbortSignal
  onProgress?(message: string, progress?: number): void
}

function throwIfExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('3MF 导出已取消', 'AbortError')
}

const round6 = (value: number): number => Number(value.toFixed(6))
const relativePoints = (points: Array<{ x: number; y: number }> | undefined, panel: SplitPanel) =>
  points?.map(point => [round6(point.x - panel.x), round6(point.y - panel.y)])
const relativeHoles = (points: Array<{ x: number; y: number; knocked?: boolean }> | undefined, panel: SplitPanel) =>
  points?.map(point => [round6(point.x - panel.x), round6(point.y - panel.y), Boolean(point.knocked)])

/** 只把真正影响制造网格的字段写入签名，相同板件会复用一个 3MF object。 */
function panelSignature(panel: SplitPanel, cfg: SplitConfig): string {
  return JSON.stringify({
    w: round6(panel.w), h: round6(panel.h),
    contour: relativePoints(panel.contour, panel),
    roundIdx: panel.roundIdx ?? [],
    slots: relativeHoles(panel.slots, panel),
    round: relativeHoles(panel.round_holes, panel),
    edge: relativeHoles(panel.edge_holes, panel),
    cutouts: panel.cutouts?.map(hole => relativePoints(hole, panel)),
    outerCorners: panel.outerCorners,
    cfg: {
      thickness: cfg.thickness,
      slotLength: cfg.slotLength,
      slotWidth: cfg.slotWidth,
      jointDiameter: cfg.jointDiameter,
      cornerRadius: cfg.cornerRadius,
      gapTolerance: cfg.gapTolerance,
    },
  })
}

interface TextureManufacturingContext {
  config: BoardTextureConfig
  canvas: HTMLCanvasElement
  pixels: Uint8ClampedArray
  lut: LuminaLut
  colors: string[]
  bounds: ReturnType<typeof getSplitPanelTextureBounds>
  structuralThickness: number
  textureThickness: number
  opticalStart: number
  samplePitch: number
  recipeCache: Map<number, number>
}

async function createTextureManufacturingContext(input: Manufacturing3MFInput): Promise<TextureManufacturingContext | null> {
  throwIfExportAborted(input.signal)
  if (!input.boardTexture?.enabled || !input.panels.length) return null
  const config = { ...createDefaultBoardTexture(), ...input.boardTexture }
  const bounds = getSplitPanelTextureBounds(input.panels)
  const canvas = await createBoardTextureCanvas(config, bounds.width / bounds.height)
  throwIfExportAborted(input.signal)
  const ctx = canvas?.getContext('2d', { willReadFrequently: true })
  if (!canvas || !ctx) return null
  const lut = await loadLuminaLut(config.lutId)
  const opticalThickness = lut.layerHeight * lut.layerCount
  const textureThickness = Math.max(opticalThickness + 0.08, Math.min(input.cfg.thickness - 0.2, config.textureThickness))
  const structuralThickness = Math.max(0.2, input.cfg.thickness - textureThickness)
  // 大板按整板面积限制采样总量；0.1mm 只用于小件，避免 4 块大板瞬间生成数千万体素。
  const targetCells = config.modelingMode === 'vector' ? 3_000_000 : 2_000_000
  const adaptivePitch = Math.sqrt(bounds.width * bounds.height / targetCells)
  const samplePitch = config.modelingMode === 'pixel'
    ? Math.max(0.4, config.pixelSize)
    : Math.max(config.modelingMode === 'vector' ? 0.08 : 0.1, adaptivePitch)
  return {
    config,
    canvas,
    pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    lut,
    colors: lut.materials.map(material => material.color),
    bounds,
    structuralThickness,
    textureThickness,
    opticalStart: input.cfg.thickness - opticalThickness,
    samplePitch,
    recipeCache: new Map(),
  }
}

interface PanelMaterialProfile {
  outer: Point2D[]
  holes: Point2D[][]
}

function panelMaterialProfile(panel: SplitPanel, cfg: SplitConfig): PanelMaterialProfile {
  const points = createSplitPanelShape(panel, cfg).extractPoints(64)
  return {
    outer: points.shape.map(point => ({ x: point.x, y: point.y })),
    holes: points.holes.map(hole => hole.map(point => ({ x: point.x, y: point.y }))),
  }
}

interface PanelMaterialRaster {
  width: number
  height: number
  mask: Uint8Array
  /** 3/4 chamfer distance，3 个单位约等于一个正交网格。 */
  distance: Uint16Array
}

function panelMaterialRaster(
  profile: PanelMaterialProfile,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cell: number,
): PanelMaterialRaster {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建板件制造掩膜')
  const trace = (ring: Point2D[]) => {
    if (!ring.length) return
    ctx.moveTo((ring[0].x - originX) / cell, (ring[0].y - originY) / cell)
    for (let index = 1; index < ring.length; index++) ctx.lineTo((ring[index].x - originX) / cell, (ring[index].y - originY) / cell)
    ctx.closePath()
  }
  ctx.beginPath()
  trace(profile.outer)
  for (const hole of profile.holes) trace(hole)
  ctx.fillStyle = '#fff'
  ctx.fill('evenodd')
  const rgba = ctx.getImageData(0, 0, width, height).data
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < mask.length; index++) mask[index] = rgba[index * 4 + 3] >= 128 ? 1 : 0

  // 一次性计算到最近孔壁/外缘的距离，五个光学层直接查表，不再逐格遍历所有孔。
  const stride = width + 2
  const padded = new Uint16Array((height + 2) * stride)
  const INF = 30_000
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x]) padded[(y + 1) * stride + x + 1] = INF
  }
  for (let y = 1; y <= height; y++) for (let x = 1; x <= width; x++) {
    const index = y * stride + x
    if (!padded[index]) continue
    padded[index] = Math.min(padded[index], padded[index - 1] + 3, padded[index - stride] + 3,
      padded[index - stride - 1] + 4, padded[index - stride + 1] + 4)
  }
  for (let y = height; y >= 1; y--) for (let x = width; x >= 1; x--) {
    const index = y * stride + x
    if (!padded[index]) continue
    padded[index] = Math.min(padded[index], padded[index + 1] + 3, padded[index + stride] + 3,
      padded[index + stride - 1] + 4, padded[index + stride + 1] + 4)
  }
  const distance = new Uint16Array(mask.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) distance[y * width + x] = padded[(y + 1) * stride + x + 1]
  return { width, height, mask, distance }
}

const yieldExportThread = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function appendBox(mesh: PrintableMesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  const base = mesh.vertices.length
  mesh.vertices.push(
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  )
  const faces: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  mesh.triangles.push(...faces.map(([a, b, c]) => [base + a, base + b, base + c] as [number, number, number]))
}

function appendPrintableMesh(target: PrintableMesh, source: PrintableMesh): void {
  const base = target.vertices.length
  // 不能使用 push(...巨大数组)：真实洞洞板可能有几十万顶点，会超过 JS 参数栈上限。
  for (const vertex of source.vertices) target.vertices.push(vertex)
  for (const [a, b, c] of source.triangles) target.triangles.push([base + a, base + b, base + c])
}

function structuralPartSettings(config: BoardTextureConfig): Record<string, string> {
  return {
    layer_height: '0.28',
    wall_loops: '2',
    top_shell_layers: '3',
    bottom_shell_layers: '3',
    top_shell_thickness: '0.6',
    bottom_shell_thickness: '0.6',
    sparse_infill_density: `${Math.round(config.baseInfillDensity)}%`,
    sparse_infill_pattern: 'gyroid',
    fuzzy_skin: 'none',
  }
}

function backingPartSettings(): Record<string, string> {
  return {
    layer_height: '0.28',
    wall_loops: '2',
    top_shell_layers: '3',
    bottom_shell_layers: '3',
    top_shell_thickness: '0.6',
    bottom_shell_thickness: '0.6',
    sparse_infill_density: '100%',
    sparse_infill_pattern: 'zig-zag',
    fuzzy_skin: 'none',
  }
}

function surfacePartSettings(layerHeight = 0.08): Record<string, string> {
  return {
    layer_height: String(round6(layerHeight)),
    wall_loops: '1',
    top_shell_layers: '0',
    bottom_shell_layers: '0',
    sparse_infill_density: '100%',
    sparse_infill_pattern: 'zig-zag',
    outer_wall_speed: '40',
    inner_wall_speed: '70',
    sparse_infill_speed: '70',
    internal_solid_infill_speed: '70',
    top_surface_speed: '40',
    fuzzy_skin: 'none',
  }
}

function translatePrintableMeshZ(mesh: PrintableMesh, delta: number): PrintableMesh {
  for (const vertex of mesh.vertices) vertex[2] += delta
  return mesh
}

/**
 * 复合板分层只在最外侧表面倒角，基材/贴面的内部拼接面保持平直。
 * 基材调用 bottom，质感贴面调用 top；组合后得到上下对称的外缘和孔口倒角。
 */
function createOneSidedBeveledLayer(
  panel: SplitPanel,
  cfg: SplitConfig,
  zOffset: number,
  depth: number,
  side: 'bottom' | 'top',
  name: string,
): PrintableMesh {
  const chamfer = Math.max(0, Math.min(cfg.manufacturingChamfer, depth / 3, cfg.slotWidth / 4))
  if (chamfer <= 0.001) return createPanelPrismMesh(panel, cfg, zOffset, depth, name)

  const bevelRoot = generateSplitPanelMesh({
    panel,
    // generateSplitPanelMesh 会把倒角限制到厚度的 1/3；使用 3×chamfer
    // 才能得到与此处计算一致的真实倒角，避免复合层 Z 截面错位。
    cfg: { ...cfg, thickness: chamfer * 3 },
    color: 0x3ec6b0,
    curveSegments: 64,
    includeGuides: false,
    manufacturingChamfer: chamfer,
  })
  let fullBevel: PrintableMesh
  try {
    fullBevel = collectPanelMesh(bevelRoot, panel, { x: 0, y: 0, rotation: 0 })
  } finally {
    disposeObject(bevelRoot)
  }
  const result: PrintableMesh = { name, vertices: [], triangles: [] }
  if (side === 'bottom') {
    appendPrintableMesh(result, translatePrintableMeshZ(fullBevel, zOffset))
    appendPrintableMesh(result, createPanelPrismMesh(panel, cfg, zOffset + chamfer, depth - chamfer, `${name}-core`))
  } else {
    appendPrintableMesh(result, createPanelPrismMesh(panel, cfg, zOffset, depth - chamfer, `${name}-core`))
    appendPrintableMesh(result, translatePrintableMeshZ(fullBevel, zOffset + depth - chamfer * 3))
  }
  validateClosedMesh(result.name, result.triangles)
  return result
}

function createBottomBeveledBase(panel: SplitPanel, cfg: SplitConfig, structuralThickness: number): PrintableMesh {
  return createOneSidedBeveledLayer(panel, cfg, 0, structuralThickness, 'bottom', `${panel.id}-structural-base`)
}

function flipCompositePanelFaceDown(parts: ManufacturingPart[], totalThickness: number): void {
  for (const part of parts) {
    for (const vertex of part.mesh.vertices) vertex[2] = round6(totalThickness - vertex[2])
    for (const triangle of part.mesh.triangles) [triangle[1], triangle[2]] = [triangle[2], triangle[1]]
  }
}

function textureRecipeAt(x: number, y: number, context: TextureManufacturingContext): number {
  const u = (x - context.bounds.minX) / context.bounds.width
  const v = (y - context.bounds.minY) / context.bounds.height
  const px = Math.max(0, Math.min(context.canvas.width - 1, Math.round(u * (context.canvas.width - 1))))
  const py = Math.max(0, Math.min(context.canvas.height - 1, Math.round((1 - v) * (context.canvas.height - 1))))
  const offset = (py * context.canvas.width + px) * 4
  const color: LuminaRgb = [context.pixels[offset], context.pixels[offset + 1], context.pixels[offset + 2]]
  const key = (color[0] << 16) | (color[1] << 8) | color[2]
  const cached = context.recipeCache.get(key)
  if (cached !== undefined) return cached
  const recipe = matchLuminaColor(color, context.lut, context.config.hueWeight)
  context.recipeCache.set(key, recipe)
  return recipe
}

function createPanelPrismMesh(panel: SplitPanel, cfg: SplitConfig, zOffset: number, depth: number, name: string): PrintableMesh {
  const root = generateSplitPanelMesh({
    panel,
    cfg: { ...cfg, thickness: depth },
    color: 0x3ec6b0,
    curveSegments: 64,
    includeGuides: false,
    manufacturingChamfer: 0,
  })
  root.position.z = zOffset
  try {
    const mesh = collectPanelMesh(root, panel, { x: 0, y: 0, rotation: 0 })
    mesh.name = name
    return mesh
  } finally {
    disposeObject(root)
  }
}

async function createPanelTextureParts(
  panel: SplitPanel,
  cfg: SplitConfig,
  context: TextureManufacturingContext,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<ManufacturingPart[]> {
  throwIfExportAborted(signal)
  if (context.config.surfaceMode === 'veneer') {
    const veneer = createOneSidedBeveledLayer(
      panel,
      cfg,
      context.structuralThickness,
      context.textureThickness,
      'top',
      `${panel.id}-surface-veneer`,
    )
    onProgress?.(1)
    return [{
      name: `${panel.id.toUpperCase()} · ${context.config.surfaceMaterialName} · ${context.textureThickness.toFixed(2)}mm 质感贴面`,
      mesh: veneer,
      extruder: 2,
      color: context.config.surfaceColor,
      settings: backingPartSettings(),
    }]
  }
  const meshes = context.lut.materials.map((_, index): PrintableMesh => ({ name: `${panel.id}-lumina-material-${index + 1}`, vertices: [], triangles: [] }))
  const parts: ManufacturingPart[] = []
  const fillerDepth = context.opticalStart - context.structuralThickness
  if (fillerDepth > 0.001) {
    const filler = createPanelPrismMesh(panel, cfg, context.structuralThickness, fillerDepth, `${panel.id}-surface-backing`)
    parts.push({
      name: `${panel.id.toUpperCase()} · 顶部模具承托层 ${fillerDepth.toFixed(2)}mm`,
      mesh: filler,
      extruder: 2,
      color: context.colors[0],
      settings: backingPartSettings(),
    })
  }

  const cell = context.samplePitch
  const profile = panelMaterialProfile(panel, cfg)
  const startRow = Math.floor((panel.y - context.bounds.minY) / cell)
  const endRow = Math.ceil((panel.y + panel.h - context.bounds.minY) / cell)
  const startColumn = Math.floor((panel.x - context.bounds.minX) / cell)
  const endColumn = Math.ceil((panel.x + panel.w - context.bounds.minX) / cell)
  const columnCount = endColumn - startColumn
  const rowCount = endRow - startRow
  const rasterOriginX = context.bounds.minX + startColumn * cell
  const rasterOriginY = context.bounds.minY + startRow * cell
  const raster = panelMaterialRaster(profile, columnCount, rowCount, rasterOriginX, rasterOriginY, cell)
  const layerCount = context.lut.layerCount
  interface ActiveRect { material: number; x0: number; x1: number; y0: number; y1: number }
  const active = Array.from({ length: layerCount }, () => new Map<string, ActiveRect>())
  const flush = (layer: number, rect: ActiveRect) => appendBox(
    meshes[rect.material],
    rect.x0 - panel.x,
    rect.y0 - panel.y,
    context.opticalStart + layer * context.lut.layerHeight,
    rect.x1 - panel.x,
    rect.y1 - panel.y,
    context.opticalStart + (layer + 1) * context.lut.layerHeight,
  )

  for (let row = startRow; row < endRow; row++) {
    const globalY0 = Math.max(panel.y, context.bounds.minY + row * cell)
    const globalY1 = Math.min(panel.y + panel.h, context.bounds.minY + (row + 1) * cell)
    const rowMaterials = Array.from({ length: layerCount }, () => {
      const values = new Int16Array(columnCount)
      values.fill(-1)
      return values
    })
    for (let column = startColumn; column < endColumn; column++) {
      const globalX0 = Math.max(panel.x, context.bounds.minX + column * cell)
      const globalX1 = Math.min(panel.x + panel.w, context.bounds.minX + (column + 1) * cell)
      const localIndex = (row - startRow) * columnCount + (column - startColumn)
      if (globalX1 <= globalX0 || globalY1 <= globalY0 || !raster.mask[localIndex]) continue
      const recipe = textureRecipeAt((globalX0 + globalX1) / 2, (globalY0 + globalY1) / 2, context)
      for (let layer = 0; layer < layerCount; layer++) {
        const zMid = context.opticalStart + (layer + 0.5) * context.lut.layerHeight
        const inset = Math.max(0, zMid - (cfg.thickness - cfg.manufacturingChamfer))
        const distanceMm = raster.distance[localIndex] / 3 * cell
        if (inset > 0 && distanceMm < inset + cell * 0.2) continue
        rowMaterials[layer][column - startColumn] = luminaStackMaterial(context.lut, recipe, layer)
      }
    }
    for (let layer = 0; layer < layerCount; layer++) {
      const next = new Map<string, ActiveRect>()
      const values = rowMaterials[layer]
      let start = 0
      while (start < values.length) {
        const material = values[start]
        if (material < 0) { start++; continue }
        let end = start + 1
        while (end < values.length && values[end] === material) end++
        const x0 = Math.max(panel.x, context.bounds.minX + (startColumn + start) * cell)
        const x1 = Math.min(panel.x + panel.w, context.bounds.minX + (startColumn + end) * cell)
        const key = `${material}:${x0.toFixed(4)}:${x1.toFixed(4)}`
        const previous = active[layer].get(key)
        const rect = previous && Math.abs(previous.y1 - globalY0) < 1e-5
          ? { ...previous, y1: globalY1 }
          : { material, x0, x1, y0: globalY0, y1: globalY1 }
        next.set(key, rect)
        start = end
      }
      for (const [key, rect] of active[layer]) if (!next.has(key)) flush(layer, rect)
      active[layer] = next
    }
    if ((row - startRow) % 32 === 31) {
      await yieldExportThread()
      throwIfExportAborted(signal)
      onProgress?.((row - startRow + 1) / Math.max(1, rowCount))
    }
  }
  onProgress?.(1)
  for (let layer = 0; layer < layerCount; layer++) for (const rect of active[layer].values()) flush(layer, rect)

  parts.push(...meshes.flatMap((mesh, index) => {
    if (!mesh.triangles.length) return []
    validateClosedMesh(mesh.name, mesh.triangles)
    return [{
      name: `${panel.id.toUpperCase()} · Lumina ${context.lut.materials[index].name} · ${context.lut.layerCount}×${context.lut.layerHeight.toFixed(2)}mm`,
      mesh,
      extruder: index + 2,
      color: context.colors[index],
      settings: surfacePartSettings(context.lut.layerHeight),
    }]
  }))
  return parts
}

function partSignature(instance: PlacedPart): string {
  const params = Object.fromEntries(Object.entries(instance.params).sort(([a], [b]) => a.localeCompare(b)))
  return `${instance.defId}:${JSON.stringify(params)}`
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach(item => item.dispose())
    else material?.dispose()
  })
}

function normalizePrintableMesh(root: THREE.Object3D, name: string): PrintableMesh {
  const vertices: Array<[number, number, number]> = []
  const triangles: Array<[number, number, number]> = []
  root.updateMatrixWorld(true)
  root.traverse(object => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (!mesh.isMesh || object.userData.previewOnly || !mesh.geometry?.getAttribute('position')) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== 'position') geometry.deleteAttribute(attribute)
    }
    geometry.morphAttributes = {}
    const indexed = mergeVertices(geometry, 1e-5)
    const position = indexed.getAttribute('position') as THREE.BufferAttribute
    const base = vertices.length
    for (let i = 0; i < position.count; i++) {
      vertices.push([position.getX(i), position.getY(i), position.getZ(i)])
    }
    const index = indexed.getIndex()
    const count = index?.count ?? position.count
    for (let i = 0; i + 2 < count; i += 3) {
      const a = base + (index ? index.getX(i) : i)
      const b = base + (index ? index.getX(i + 1) : i + 1)
      const c = base + (index ? index.getX(i + 2) : i + 2)
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c])
    }
    geometry.dispose()
    indexed.dispose()
  })
  if (!vertices.length || !triangles.length) throw new Error(`${name} 没有可导出的实体网格`)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  for (const vertex of vertices) {
    minX = Math.min(minX, vertex[0])
    minY = Math.min(minY, vertex[1])
    minZ = Math.min(minZ, vertex[2])
  }
  for (const vertex of vertices) {
    vertex[0] -= minX
    vertex[1] -= minY
    vertex[2] -= minZ
  }
  validateClosedMesh(name, triangles)
  return { name, vertices, triangles }
}

function orientPartForPrinting(root: THREE.Object3D, definition: PartDefinition): THREE.Object3D {
  const wrapper = new THREE.Group()
  wrapper.add(root)
  const configured = definition.model.printOrientation
  if (configured) {
    wrapper.rotation.set(...configured.map(THREE.MathUtils.degToRad) as [number, number, number])
    return wrapper
  }
  root.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
  if (size.x <= size.y && size.x <= size.z) wrapper.rotation.y = -Math.PI / 2
  else if (size.y <= size.x && size.y <= size.z) wrapper.rotation.x = Math.PI / 2
  return wrapper
}

type PlanarPoint = [number, number]

function cross(origin: PlanarPoint, a: PlanarPoint, b: PlanarPoint) {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
}

/** 只保留 XY 投影的凸包顶点，避免为每个候选角度反复扫描板件孔洞产生的大量网格顶点。 */
function printableMeshFootprint(mesh: PrintableMesh): PlanarPoint[] {
  const unique = new Map<string, PlanarPoint>()
  for (const [x, y] of mesh.vertices) unique.set(`${x}:${y}`, [x, y])
  const points = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (points.length <= 2) return points

  const lower: PlanarPoint[] = []
  for (const point of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: PlanarPoint[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function printableMeshBounds(points: PlanarPoint[], rotation: number) {
  const angle = rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) {
    const rx = x * cos - y * sin
    const ry = x * sin + y * cos
    minX = Math.min(minX, rx)
    minY = Math.min(minY, ry)
    maxX = Math.max(maxX, rx)
    maxY = Math.max(maxY, ry)
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

function rotationCandidates(preferred: number, allowDiagonal: boolean): number[] {
  const values = [preferred, 0, 90, 180, 270]
  if (allowDiagonal) {
    // 洞洞板允许利用热床对角线；0.25° 与分割引擎的搜索精度保持一致。
    for (let angle = 0; angle < 180; angle += 0.25) values.push(angle)
  }
  return [...new Set(values.map(value => Math.round((((value % 360) + 360) % 360) * 100) / 100))]
}

/**
 * 按有效打印边界排盘，并避开擦嘴/切刀等禁放区。板件可按 0.25° 搜索斜放；
 * 每个盘内仍使用保守包围盒防碰撞，保证第三方切片器读取实例变换后不会重叠。
 */
export function packManufacturingObjects(objects: ManufacturingObject[], cfg: SplitConfig): BuildPlate[] {
  const gap = 8
  const area = getPrintBedBounds(cfg)
  const usableW = area.width
  const usableH = area.height
  if (usableW <= 0 || usableH <= 0) throw new Error('热床尺寸过小，无法排盘')
  const plates: BuildPlate[] = []
  const instanceCounters = new Map<string, number>()
  const footprintCache = new WeakMap<PrintableMesh, PlanarPoint[]>()
  const candidateCache = new Map<string, Array<{
    rotation: number
    bounds: ReturnType<typeof printableMeshBounds>
    footprint: Point2D[]
    seed: { x: number; y: number }
  }>>()
  let identifyId = 1

  const getPlacementCandidates = (object: ManufacturingObject) => {
    const cached = candidateCache.get(object.key)
    if (cached) return cached
    let footprint = footprintCache.get(object.mesh)
    if (!footprint) {
      footprint = printableMeshFootprint(object.mesh)
      footprintCache.set(object.mesh, footprint)
    }
    const preferred = Math.round((((object.preferredRotation % 360) + 360) % 360) * 100) / 100
    const candidates = rotationCandidates(object.preferredRotation, object.kind === 'panel')
      .map(rotation => {
        const angle = rotation * Math.PI / 180
        const cos = Math.cos(angle), sin = Math.sin(angle)
        const rotated = footprint.map(([x, y]) => ({ x: x * cos - y * sin, y: x * sin + y * cos }))
        const seed = findFootprintPlacement(rotated, cfg)
        return { rotation, bounds: printableMeshBounds(footprint, rotation), footprint: rotated, seed }
      })
      .filter((candidate): candidate is typeof candidate & { seed: { x: number; y: number } } => candidate.seed !== null)
      .sort((a, b) => {
        // 已由分割器指定且仍满足边界的方向优先；否则选占用热床最长边比例最小的方向。
        if (a.rotation === preferred && b.rotation !== preferred) return -1
        if (b.rotation === preferred && a.rotation !== preferred) return 1
        const aScore = Math.max(a.bounds.width / usableW, a.bounds.height / usableH)
        const bScore = Math.max(b.bounds.width / usableW, b.bounds.height / usableH)
        return aScore - bScore
      })
    candidateCache.set(object.key, candidates)
    return candidates
  }

  const collidesWithInstance = (
    bounds: PackedInstance['worldBounds'],
    instance: PackedInstance,
  ) => !(bounds.maxX + gap <= instance.worldBounds.minX ||
    bounds.minX >= instance.worldBounds.maxX + gap ||
    bounds.maxY + gap <= instance.worldBounds.minY ||
    bounds.minY >= instance.worldBounds.maxY + gap)

  const tryPlace = (plate: BuildPlate, object: ManufacturingObject, objectId: number) => {
    for (const { rotation, bounds, footprint, seed } of getPlacementCandidates(object)) {
      const xs = [area.minX - bounds.minX, area.maxX - (bounds.minX + bounds.width), seed.x]
      const ys = [area.minY - bounds.minY, area.maxY - (bounds.minY + bounds.height), seed.y]
      for (const instance of plate.instances) {
        xs.push(instance.worldBounds.maxX + gap - bounds.minX)
        xs.push(instance.worldBounds.minX - gap - bounds.minX - bounds.width)
        ys.push(instance.worldBounds.maxY + gap - bounds.minY)
        ys.push(instance.worldBounds.minY - gap - bounds.minY - bounds.height)
      }
      for (const zone of getEnabledKeepouts(cfg)) {
        xs.push(zone.x - 0.01 - bounds.minX - bounds.width)
        xs.push(zone.x + zone.w + 0.01 - bounds.minX)
        ys.push(zone.y - 0.01 - bounds.minY - bounds.height)
        ys.push(zone.y + zone.h + 0.01 - bounds.minY)
      }
      const unique = (values: number[]) => [...new Set(values.map(value => Number(value.toFixed(6))))]
      const positions = unique(ys).flatMap(y => unique(xs).map(x => ({ x, y })))
        .sort((a, b) => a.y - b.y || a.x - b.x)
      for (const position of positions) {
        const worldBounds = {
          minX: bounds.minX + position.x,
          minY: bounds.minY + position.y,
          maxX: bounds.minX + bounds.width + position.x,
          maxY: bounds.minY + bounds.height + position.y,
        }
        if (worldBounds.minX < area.minX - 1e-6 || worldBounds.maxX > area.maxX + 1e-6 ||
            worldBounds.minY < area.minY - 1e-6 || worldBounds.maxY > area.maxY + 1e-6) continue
        if (plate.instances.some(instance => collidesWithInstance(worldBounds, instance))) continue
        const translated = footprint.map(point => ({ x: point.x + position.x, y: point.y + position.y }))
        const blocked = getEnabledKeepouts(cfg).some(zone => polygonIntersectsRect(translated, {
          minX: zone.x, minY: zone.y, maxX: zone.x + zone.w, maxY: zone.y + zone.h,
        }))
        if (blocked) continue
        const packed: PackedInstance = {
          objectKey: object.key, objectId,
          instanceId: instanceCounters.get(object.key) ?? 0,
          identifyId: identifyId++, name: object.name, plate: plate.index,
          rotation, x: position.x, y: position.y, worldBounds,
        }
        plate.instances.push(packed)
        return packed
      }
    }
    return null
  }

  const partCount = objects.reduce((sum, object) => sum + object.parts.length, 0)
  objects.forEach((object, objectIndex) => {
    // 前 partCount 个 id 是真实网格；后续 id 是每个可排盘装配对象。
    const rootObjectId = partCount + objectIndex + 1
    for (let copy = 0; copy < object.quantity; copy++) {
      let packed: PackedInstance | null = null
      for (const plate of plates) {
        if (plate.kind !== object.kind) continue
        packed = tryPlace(plate, object, rootObjectId)
        if (packed) break
      }
      if (!packed) {
        // 内部数组从 0 开始；写入 Bambu model_settings.config 时必须转换为 1 开始。
        const plate: BuildPlate = { index: plates.length, kind: object.kind, instances: [] }
        plates.push(plate)
        packed = tryPlace(plate, object, rootObjectId)
      }
      if (!packed) {
        const detail = object.kind === 'panel' ? '（已尝试 0.25° 精度斜放）' : ''
        throw new Error(`${object.name} 无法放入 ${usableW} × ${usableH} mm 有效打印区${detail}`)
      }
      instanceCounters.set(object.key, packed.instanceId + 1)
    }
  })
  return plates
}

/**
 * Bambu Studio 在一个项目内用二维网格摆放多张虚拟热床。板内坐标仍由排盘器
 * 计算，但第二盘起必须叠加热床网格原点；否则配置读取失败或被忽略时，所有
 * build item 都会落回同一个坐标区域，看起来像是“零件全堆在一起”。
 */
function plateGridOffset(plate: number, cfg: SplitConfig): { x: number; y: number } {
  const gap = 40
  const column = plate % 2
  const row = Math.floor(plate / 2)
  return {
    x: column * (cfg.bedW + gap),
    y: -row * (cfg.bedH + gap),
  }
}

function buildTransform(instance: PackedInstance, cfg: SplitConfig): string {
  const angle = instance.rotation * Math.PI / 180
  const cos = number(Math.cos(angle))
  const sin = number(Math.sin(angle))
  const plateOffset = plateGridOffset(instance.plate, cfg)
  return `${cos} ${sin} 0 ${number(-Math.sin(angle))} ${cos} 0 0 0 1 ${number(instance.x + plateOffset.x)} ${number(instance.y + plateOffset.y)} 0`
}

// Bambu Studio only loads its plate sidecars when the 3MF declares a Bambu
// application version. Keep this deliberately conservative: it is a format
// compatibility marker, while SnapBoard remains recorded as the generator.
const luminaProjectTemplate = JSON.parse(luminaBambuConfigTemplate) as Record<string, unknown>
const BAMBU_COMPAT_VERSION = String(luminaProjectTemplate.version ?? '02.05.00.66')

interface IndexedManufacturingPart {
  objectIndex: number
  partId: number
  part: ManufacturingPart
}

function indexedManufacturingParts(objects: ManufacturingObject[]): IndexedManufacturingPart[] {
  let partId = 0
  return objects.flatMap((object, objectIndex) => object.parts.map(part => ({ objectIndex, partId: ++partId, part })))
}

function rootObjectId(objects: ManufacturingObject[], objectIndex: number): number {
  return objects.reduce((sum, object) => sum + object.parts.length, 0) + objectIndex + 1
}

/**
 * Lumina 使用一个 object_1.model 容纳全部实际网格，主模型只保存装配引用。
 * 这种结构比“每个网格一个外部文件 + 自造 production UUID”兼容性更好，
 * Bambu Studio、OrcaSlicer 也更容易恢复 object/part 对应关系。
 */
function manufacturingObjectsModelXml(objects: ManufacturingObject[]): string {
  const resources = indexedManufacturingParts(objects).map(({ partId, part }) => {
    const mesh = part.mesh
    return `
    <object id="${partId}" type="model" name="${escapeXml(part.name)}">
      <mesh>
        <vertices>${mesh.vertices.map(([x, y, z]) => `
          <vertex x="${number(x)}" y="${number(y)}" z="${number(z)}"/>`).join('')}
        </vertices>
        <triangles>${mesh.triangles.map(([v1, v2, v3]) => `
          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join('')}
        </triangles>
      </mesh>
    </object>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>${resources}
  </resources>
  <build/>
</model>`
}

function manufacturingModelXml(objects: ManufacturingObject[], plates: BuildPlate[], title: string, cfg: SplitConfig): string {
  const indexedParts = indexedManufacturingParts(objects)
  const resources = objects.map((object, index) => {
    const objectId = rootObjectId(objects, index)
    const parts = indexedParts.filter(part => part.objectIndex === index)
    return `
    <object id="${objectId}" type="model" name="${escapeXml(object.name)}">
      <components>${parts.map(({ partId }) => `
        <component p:path="/3D/Objects/object_1.model" objectid="${partId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('')}
      </components>
    </object>`
  }).join('')
  const build = plates.flatMap(plate => plate.instances).map(instance => `
    <item objectid="${instance.objectId}" transform="${buildTransform(instance, cfg)}" printable="1"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <metadata name="Title">${escapeXml(title)}</metadata>
  <metadata name="Application">BambuStudio-${BAMBU_COMPAT_VERSION}</metadata>
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <metadata name="Generator">SnapBoard</metadata>
  <resources>${resources}
  </resources>
  <build>${build}
  </build>
</model>`
}

function bambuModelSettingsXml(objects: ManufacturingObject[], plates: BuildPlate[]): string {
  // model_settings.config is not merely a plate index: Bambu validates the
  // object/part table before accepting the plate-to-instance mapping. Our core
  // 3MF stores one mesh directly in every resource object, so the part id is
  // the same as that resource object id.
  const indexedParts = indexedManufacturingParts(objects)
  const objectSettings = objects.map((object, index) => {
    const objectId = rootObjectId(objects, index)
    const parts = indexedParts.filter(part => part.objectIndex === index)
    const faceCount = parts.reduce((sum, entry) => sum + entry.part.mesh.triangles.length, 0)
    return `
  <object id="${objectId}">
    <metadata key="name" value="${escapeXml(object.name)}"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="${faceCount}"/>${parts.map(({ partId, part }) => `
    <part id="${partId}" subtype="normal_part">
      <metadata key="name" value="${escapeXml(part.name)}"/>
      <metadata key="extruder" value="${part.extruder}"/>
      ${Object.entries(part.settings ?? {}).map(([key, value]) => `<metadata key="${escapeXml(key)}" value="${escapeXml(value)}"/>`).join('\n      ')}
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <mesh_stat face_count="${part.mesh.triangles.length}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`).join('')}
  </object>`
  }).join('')
  const plateSettings = plates.map(plate => `
  <plate>
    <metadata key="plater_id" value="${plate.index + 1}"/>
    <metadata key="plater_name" value="SnapBoard ${plate.kind === 'panel' ? '板件' : '配件'} 第 ${plate.index + 1} 盘"/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>${plate.instances.map(instance => `
    <model_instance>
      <metadata key="object_id" value="${instance.objectId}"/>
      <metadata key="instance_id" value="${instance.instanceId}"/>
      <metadata key="identify_id" value="${instance.identifyId}"/>
    </model_instance>`).join('')}
  </plate>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>${objectSettings}${plateSettings}
  <assemble/>
</config>`
}

const filamentArrayKeys = new Set([
  'nozzle_temperature', 'nozzle_temperature_initial_layer',
  'nozzle_temperature_range_low', 'nozzle_temperature_range_high',
  'bed_temperature', 'bed_temperature_initial_layer',
  'activate_air_filtration', 'additional_cooling_fan_speed',
  'chamber_temperatures', 'close_fan_the_first_x_layers',
  'complete_print_exhaust_fan_speed', 'cool_plate_temp',
  'cool_plate_temp_initial_layer', 'during_print_exhaust_fan_speed',
  'eng_plate_temp', 'eng_plate_temp_initial_layer',
  'fan_cooling_layer_time', 'fan_max_speed', 'fan_min_speed',
  'hot_plate_temp', 'hot_plate_temp_initial_layer',
  'textured_plate_temp', 'textured_plate_temp_initial_layer',
  'supertack_plate_temp', 'supertack_plate_temp_initial_layer',
])

function bambuProjectSettingsJson(cfg: SplitConfig, filamentColors: string[], texture?: BoardTextureConfig): string {
  // Bambu 会把缺字段的稀疏 JSON 判为无效配置，并退化为“仅加载几何”。
  // 因此沿用 Lumina 已验证的完整模板，再收敛到 SnapBoard 的单耗材项目。
  const settings = structuredClone(luminaProjectTemplate)
  const printer = getBambuPrinterPreset(cfg.printerPreset)
  const colors = filamentColors.length ? filamentColors : ['#3EC6B0']
  for (const [key, value] of Object.entries(settings)) {
    if (Array.isArray(value) && value.length && (key.startsWith('filament_') || filamentArrayKeys.has(key))) {
      settings[key] = Array.from({ length: colors.length }, () => value[0])
    }
  }

  settings.version = BAMBU_COMPAT_VERSION
  settings.name = 'project_settings'
  settings.from = 'project'
  const manufacturing = { ...createDefaultBoardTexture(), ...texture }
  settings.filament_colour = colors
  settings.filament_multi_colour = colors
  settings.default_filament_colour = colors
  settings.filament_settings_id = [Array.isArray(settings.filament_settings_id) ? settings.filament_settings_id[0] : 'Generic PLA']
  // 全局采用洞洞板基材的常规 PETG 工艺；仅 1mm 表层在 model_settings 中覆盖为 Lumina 慢速/实心参数。
  settings.layer_height = '0.28'
  settings.initial_layer_print_height = manufacturing.surfaceMode === 'lumina' && manufacturing.surfaceFinish === 'textured-pei'
    ? '0.08'
    : '0.25'
  settings.wall_loops = '2'
  settings.top_shell_layers = '3'
  settings.bottom_shell_layers = '3'
  settings.top_shell_thickness = '0.6'
  settings.bottom_shell_thickness = '0.6'
  settings.sparse_infill_density = `${Math.round(manufacturing.baseInfillDensity)}%`
  settings.sparse_infill_pattern = 'gyroid'
  settings.fuzzy_skin = 'none'
  settings.curr_bed_type = 'Textured PEI Plate'
  // 洞洞板与彩色光学层统一按 PETG 制造；不能继承 Lumina 模板中的 PLA 温度/材料标记。
  settings.filament_type = colors.map(() => 'PETG')
  settings.filament_vendor = colors.map(() => 'Bambu Lab')
  settings.filament_density = colors.map(() => '1.28')
  settings.filament_flow_ratio = colors.map(() => '0.95')
  settings.filament_max_volumetric_speed = colors.map(() => '21')
  settings.nozzle_temperature = colors.map(() => '245')
  settings.nozzle_temperature_initial_layer = colors.map(() => '230')
  settings.nozzle_temperature_range_low = colors.map(() => '230')
  settings.nozzle_temperature_range_high = colors.map(() => '270')
  settings.textured_plate_temp = colors.map(() => '70')
  settings.textured_plate_temp_initial_layer = colors.map(() => '70')
  settings.hot_plate_temp = colors.map(() => '70')
  settings.hot_plate_temp_initial_layer = colors.map(() => '70')
  settings.eng_plate_temp = colors.map(() => '70')
  settings.eng_plate_temp_initial_layer = colors.map(() => '70')
  settings.single_extruder_multi_material = colors.length > 1 ? '1' : '0'
  settings.enable_prime_tower = '0'
  settings.printer_model = printer.model
  settings.printer_settings_id = printer.profile
  settings.print_compatible_printers = printer.profile
  settings.print_settings_id = printer.defaultPrintProfile
  settings.filament_settings_id = colors.map(() => printer.defaultFilamentProfile)
  settings.printable_height = String(printer.printableHeight)
  settings.nozzle_diameter = Array.from({ length: printer.extruderCount ?? 1 }, () => '0.4')
  settings.printer_extruder_id = Array.from({ length: printer.extruderCount ?? 1 }, (_, index) => String(index + 1))
  settings.printable_area = [`0x0`, `${number(cfg.bedW)}x0`, `${number(cfg.bedW)}x${number(cfg.bedH)}`, `0x${number(cfg.bedH)}`]
  settings.extruder_printable_area = printer.extruderPrintableArea ?? [`0x0,${number(cfg.bedW)}x0,${number(cfg.bedW)}x${number(cfg.bedH)},0x${number(cfg.bedH)}`]
  settings.bed_exclude_area = getEnabledKeepouts(cfg).flatMap(zone => [
    `${number(zone.x)}x${number(zone.y)}`,
    `${number(zone.x + zone.w)}x${number(zone.y)}`,
    `${number(zone.x + zone.w)}x${number(zone.y + zone.h)}`,
    `${number(zone.x)}x${number(zone.y + zone.h)}`,
  ])
  settings.wrapping_exclude_area = []
  return JSON.stringify(settings, null, 2)
}

function bambuSliceInfoXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${BAMBU_COMPAT_VERSION}"/>
  </header>
</config>`
}

function bambuFilamentSequenceJson(plates: BuildPlate[]): string {
  return JSON.stringify(Object.fromEntries(plates.map(plate => [
    `plate_${plate.index + 1}`,
    { sequence: [] },
  ])))
}

function bambuCutInformationXml(objects: ManufacturingObject[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<objects>${objects.map((_, index) => `
  <object id="${rootObjectId(objects, index)}">
    <cut_id id="0" check_sum="1" connectors_cnt="0"/>
  </object>`).join('')}
</objects>`
}

/** 防止生成会触发切片器越界的盘号/实例映射。Bambu 的 plater_id 是严格的 1..N。 */
function validateBambuPlateLayout(objects: ManufacturingObject[], plates: BuildPlate[]): void {
  if (!plates.length) throw new Error('3MF 没有生成任何热床')
  const instanceKeys = new Set<string>()
  const identifyIds = new Set<number>()
  const partCount = objects.reduce((sum, object) => sum + object.parts.length, 0)
  plates.forEach((plate, plateIndex) => {
    if (plate.index !== plateIndex || !plate.instances.length) {
      throw new Error(`3MF 第 ${plateIndex + 1} 盘的索引或实例为空`)
    }
    for (const instance of plate.instances) {
      if (instance.plate !== plateIndex || instance.objectId <= partCount || instance.objectId > partCount + objects.length) {
        throw new Error(`3MF 第 ${plateIndex + 1} 盘包含无效对象引用`)
      }
      const key = `${instance.objectId}:${instance.instanceId}`
      if (instanceKeys.has(key) || identifyIds.has(instance.identifyId) || instance.identifyId < 1) {
        throw new Error(`3MF 包含重复的对象实例标识：${key}`)
      }
      instanceKeys.add(key)
      identifyIds.add(instance.identifyId)
    }
  })
  const expected = objects.reduce((sum, object) => sum + object.quantity, 0)
  if (instanceKeys.size !== expected) throw new Error(`3MF 实例数量不一致：应为 ${expected}，实际 ${instanceKeys.size}`)
}

async function resolvePartDefinitions(provided?: PartDefinition[]): Promise<PartDefinition[]> {
  if (provided) return provided
  const response = await fetch('/partLibrary/index.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`配件库读取失败 (HTTP ${response.status})`)
  return ((await response.json()) as PartLibraryIndex).parts ?? []
}

function partAssetUrl(asset: string): string {
  if (/^https?:\/\//i.test(asset)) return asset
  const relative = asset.startsWith('/partLibrary/') ? asset : `/partLibrary/${asset.replace(/^\/+/, '')}`
  return new URL(relative, globalThis.location?.origin ?? 'http://localhost:5173').href
}

async function createManufacturingObjects(input: Manufacturing3MFInput): Promise<{ objects: ManufacturingObject[]; warnings: string[] }> {
  const objects = new Map<string, ManufacturingObject>()
  const warnings: string[] = []
  input.onProgress?.('正在准备 Lumina 纹理与板件掩膜…', 0.03)
  const textureContext = await createTextureManufacturingContext(input)
  input.onProgress?.('纹理预处理完成，开始生成板件…', 0.1)
  for (let panelIndex = 0; panelIndex < input.panels.length; panelIndex++) {
    throwIfExportAborted(input.signal)
    const panel = input.panels[panelIndex]
    const panelStart = 0.1 + panelIndex / Math.max(1, input.panels.length) * 0.62
    const panelSpan = 0.62 / Math.max(1, input.panels.length)
    input.onProgress?.(`正在生成第 ${panelIndex + 1}/${input.panels.length} 块板的制造网格…`, panelStart)
    const key = textureContext
      ? `panel-textured:${panel.id}:${panel.x}:${panel.y}:${panelSignature(panel, input.cfg)}`
      : `panel:${panelSignature(panel, input.cfg)}`
    const existing = objects.get(key)
    if (existing) {
      existing.quantity++
      continue
    }
    if (textureContext) {
      const mesh = createBottomBeveledBase(panel, input.cfg, textureContext.structuralThickness)
      const parts: ManufacturingPart[] = [{
        name: `${panel.id.toUpperCase()} · ${textureContext.config.baseMaterialName} · 结构基材 ${textureContext.structuralThickness.toFixed(1)}mm`,
        mesh, extruder: 1, color: textureContext.config.baseColor,
        settings: structuralPartSettings(textureContext.config),
      }]
      const textureParts = await createPanelTextureParts(panel, input.cfg, textureContext, input.signal, fraction => {
        input.onProgress?.(`正在生成第 ${panelIndex + 1}/${input.panels.length} 块板的 Lumina 光学层…`, panelStart + panelSpan * fraction)
      })
      for (const texturePart of textureParts) parts.push(texturePart)
      if (!textureParts.length) warnings.push(`${panel.id.toUpperCase()} 的表层没有生成有效制造网格`)
      if (textureContext.config.surfaceFinish === 'textured-pei') flipCompositePanelFaceDown(parts, input.cfg.thickness)
      objects.set(key, {
        key, name: `${panel.id.toUpperCase()} · ${panel.w.toFixed(0)}×${panel.h.toFixed(0)} 复合板件（整体移动）`, mesh, parts,
        preferredRotation: panel.printRotation ?? 0, quantity: 1, kind: 'panel',
      })
      continue
    }
    const root = generateSplitPanelMesh({
      panel, cfg: input.cfg, color: 0x3ec6b0, curveSegments: 48,
      includeGuides: false, manufacturingChamfer: input.cfg.manufacturingChamfer,
    })
    try {
      const mesh = collectPanelMesh(root, panel, { x: 0, y: 0, rotation: 0 })
      objects.set(key, {
        key, name: `${panel.w.toFixed(0)}×${panel.h.toFixed(0)} 板件`, mesh,
        parts: [{ name: `${panel.id.toUpperCase()} · 结构基材 ${input.cfg.thickness.toFixed(1)}mm`, mesh, extruder: 1, color: '#3EC6B0', settings: structuralPartSettings(createDefaultBoardTexture()) }],
        preferredRotation: panel.printRotation ?? 0, quantity: 1, kind: 'panel',
      })
    } finally { disposeObject(root) }
  }

  if (input.placedParts.length) {
    input.onProgress?.('正在整理配件并计算独立热床…', 0.74)
    const definitions = await resolvePartDefinitions(input.partDefinitions)
    const byId = new Map(definitions.map(definition => [definition.id, definition]))
    const grouped = new Map<string, { instance: PlacedPart; quantity: number }>()
    for (const instance of input.placedParts) {
      const key = partSignature(instance)
      const group = grouped.get(key)
      if (group) group.quantity++
      else grouped.set(key, { instance, quantity: 1 })
    }
    for (const [signature, group] of grouped) {
      throwIfExportAborted(input.signal)
      const definition = byId.get(group.instance.defId)
      if (!definition) {
        warnings.push(`找不到配件定义：${group.instance.defId}`)
        continue
      }
      const asset = definition.model.print
      if (!asset) {
        warnings.push(`${definition.name} 没有制造模型，未写入 3MF`)
        continue
      }
      try {
        const source = await loadPrintablePartModel(partAssetUrl(asset), definition.model)
        const parameterized = new THREE.Group()
        parameterized.add(source)
        applyPartParams(parameterized, group.instance.params, definition.params)
        const root = orientPartForPrinting(parameterized, definition)
        try {
          const key = `part:${signature}`
          const mesh = normalizePrintableMesh(root, definition.name)
          objects.set(key, {
            key, name: definition.name, mesh,
            parts: [{ name: definition.name, mesh, extruder: 1, color: '#3EC6B0' }],
            preferredRotation: 0, quantity: group.quantity, kind: 'part',
          })
        } finally {
          disposeObject(root)
        }
      } catch (error) {
        warnings.push(`${definition.name} 导入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { objects: [...objects.values()], warnings }
}

/** 生成包含板件与已放置配件的多热床 3MF；重复模型复用 object，仅增加实例。 */
export async function createManufacturing3MF(input: Manufacturing3MFInput): Promise<Manufacturing3MFSummary> {
  throwIfExportAborted(input.signal)
  if (!input.panels.length && !input.placedParts.length) throw new Error('没有可导出的板件或配件')
  const { objects, warnings } = await createManufacturingObjects(input)
  throwIfExportAborted(input.signal)
  if (!objects.length) throw new Error(warnings[0] || '没有可导出的制造模型')
  const plates = packManufacturingObjects(objects, input.cfg)
  input.onProgress?.(`正在写入 ${plates.length} 个热床和 Bambu 工程配置…`, 0.82)
  await yieldExportThread()
  throwIfExportAborted(input.signal)
  validateBambuPlateLayout(objects, plates)
  let maxExtruder = 1
  for (const object of objects) for (const part of object.parts) maxExtruder = Math.max(maxExtruder, part.extruder)
  const filamentColors = Array.from({ length: maxExtruder }, () => '#FFFFFF')
  for (const object of objects) for (const part of object.parts) filamentColors[part.extruder - 1] = part.color
  const title = input.projectName?.trim() || 'SnapBoard 制造项目'
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
  const modelRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
  input.onProgress?.('正在压缩 3MF 工程包…', 0.92)
  await yieldExportThread()
  throwIfExportAborted(input.signal)
  const data = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    '3D/3dmodel.model': strToU8(manufacturingModelXml(objects, plates, title, input.cfg)),
    '3D/_rels/3dmodel.model.rels': strToU8(modelRelationships),
    '3D/Objects/object_1.model': strToU8(manufacturingObjectsModelXml(objects)),
    'Metadata/project_settings.config': strToU8(bambuProjectSettingsJson(input.cfg, filamentColors, input.boardTexture)),
    'Metadata/model_settings.config': strToU8(bambuModelSettingsXml(objects, plates)),
    'Metadata/slice_info.config': strToU8(bambuSliceInfoXml()),
    'Metadata/filament_sequence.json': strToU8(bambuFilamentSequenceJson(plates)),
    'Metadata/cut_information.xml': strToU8(bambuCutInformationXml(objects)),
  }, { level: 6 })
  input.onProgress?.('3MF 工程包生成完成，正在保存…', 0.96)
  return {
    data,
    plateCount: plates.length,
    panelCount: objects.filter(object => object.kind === 'panel').reduce((sum, object) => sum + object.quantity, 0),
    partCount: objects.filter(object => object.kind === 'part').reduce((sum, object) => sum + object.quantity, 0),
    uniqueObjectCount: objects.length,
    warnings,
  }
}

export function manufacturing3MFFileName(input: Manufacturing3MFInput, plateCount: number): string {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, '')
  const withoutControls = [...(input.projectName ?? '').trim()].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('')
  const safeName = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '') || 'SnapBoard'
  return `${safeName}-排盘-${plateCount}盘-${stamp}.3mf`
}

export async function downloadManufacturing3MF(input: Manufacturing3MFInput): Promise<Manufacturing3MFSummary> {
  const result = await createManufacturing3MF(input)
  const blob = new Blob([result.data as BlobPart], { type: 'model/3mf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = manufacturing3MFFileName(input, result.plateCount)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return result
}
